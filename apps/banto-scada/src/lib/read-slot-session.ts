import Ajv2020 from "ajv/dist/2020.js";
import schema from "../../../../crates/scada-runtime/schema/read-slot-view.schema.json";
import { parseProject, type Project } from "./project";
import type { EquipmentContext } from "./symbol-slots";
import {
  slotPresentation,
  isSimulatedSlot,
  type SlotPresentation,
  type SlotValue,
} from "./slot-presentation";

export interface SlotProvenance {
  catalogRevision: number;
  runId: number | null;
  collectionMode: "configured" | "all_simulation";
  valueSource:
    | "real"
    | "simulation"
    | "computed"
    | "derived_simulation"
    | "internal"
    | "db";
  sourceTimestampMs: number;
}
export type ReadSlotReading =
  | { state: "unassigned" | "disconnected" | "unresolved" }
  | { state: "invalid"; reason: string }
  | {
      state: "resolved";
      quality: "good";
      value: SlotValue;
    }
  | { state: "resolved"; quality: "stale" | "bad"; value: null };
export interface ReadSlotRow {
  key: { equipmentId: string; slotName: string };
  expectedType: "bool" | "number";
  externalName: string | null;
  reading: ReadSlotReading;
  provenance: SlotProvenance | null;
}
export interface ReadSlotView {
  projectId: string;
  projectRevision: number;
  connection: string;
  lastError: string | null;
  metadataReady: boolean;
  slots: ReadSlotRow[];
}
const validate = new Ajv2020({
  allErrors: true,
  strictNumbers: true,
}).compile<ReadSlotView>(schema);
/** Opaque, non-persistent handles. The wire never chooses a local generation. */
export type ReadSlotGeneration = Readonly<{
  readonly kind: "read-slot-generation";
}>;
export type ReadSlotFrame = Readonly<{ readonly kind: "read-slot-frame" }>;
type PlanRow = Omit<ReadSlotRow, "reading" | "provenance">;
type Index<T> = Map<string, Map<string, T>>;
function put<T>(index: Index<T>, key: ReadSlotRow["key"], value: T) {
  const slots = index.get(key.equipmentId) ?? new Map<string, T>();
  if (slots.has(key.slotName)) throw new Error("slot keyが重複しています");
  slots.set(key.slotName, value);
  index.set(key.equipmentId, slots);
}
function get<T>(index: Index<T>, equipmentId: string, slotName: string) {
  return index.get(equipmentId)?.get(slotName);
}
function plan(project: Project): Index<PlanRow> {
  const index: Index<PlanRow> = new Map();
  for (const equipment of project.equipment ?? []) {
    const type = project.equipmentTypes!.find(
      (item) => item.id === equipment.typeId,
    )!;
    for (const binding of equipment.bindings) {
      const slot = type.slots.find((slot) => slot.name === binding.slotName)!;
      const row = {
        key: { equipmentId: equipment.id, slotName: slot.name },
        expectedType: slot.type,
        externalName: binding.externalName,
      };
      put(index, row.key, row);
    }
  }
  return index;
}
interface FrameData {
  owner: Project;
  projectId: string;
  revision: number;
  plan: Index<PlanRow>;
  rows: Index<ReadSlotRow>;
  phase: "disconnected" | "invalid" | "ready";
  current: () => boolean;
}
const frames = new WeakMap<ReadSlotFrame, FrameData>();

/** Validates a full replacement, never merges it with earlier values. */
function accept(
  payload: unknown,
  project: Project,
  expected: Index<PlanRow>,
): Index<ReadSlotRow> {
  if (!validate(payload)) throw new Error("ReadSlotViewの形式が不正です");
  if (
    payload.projectId !== project.manifest.projectId ||
    payload.projectRevision !== project.manifest.projectRevision
  )
    throw new Error("Projectが一致しません");
  const rows: Index<ReadSlotRow> = new Map();
  let count = 0,
    metadata: string | undefined;
  for (const row of payload.slots) {
    const request = get(expected, row.key.equipmentId, row.key.slotName);
    if (
      !request ||
      row.expectedType !== request.expectedType ||
      row.externalName !== request.externalName
    )
      throw new Error("読取planが一致しません");
    const reading = row.reading;
    if (row.externalName === null) {
      if (reading.state !== "unassigned" || row.provenance !== null)
        throw new Error("未割付の値です");
    } else if (payload.connection !== "live") {
      if (
        payload.metadataReady ||
        reading.state !== "disconnected" ||
        row.provenance !== null
      )
        throw new Error("非Live状態に値があります");
    } else if (reading.state === "resolved") {
      if (!payload.metadataReady || !row.provenance)
        throw new Error("metadataがありません");
      if (
        reading.quality === "good" &&
        (reading.value.type !== row.expectedType ||
          (reading.value.type === "number" &&
            !Number.isFinite(reading.value.value)))
      )
        throw new Error("値の型が一致しません");
      const identity = JSON.stringify([
        row.provenance.catalogRevision,
        row.provenance.runId,
        row.provenance.collectionMode,
      ]);
      if (metadata !== undefined && metadata !== identity)
        throw new Error("metadataの世代が一致しません");
      metadata = identity;
    } else {
      if (
        row.provenance !== null ||
        reading.state === "unassigned" ||
        reading.state === "disconnected"
      )
        throw new Error("取得状態が一致しません");
      if (!payload.metadataReady && reading.state !== "invalid")
        throw new Error("未検証の取得結果です");
    }
    put(rows, row.key, structuredClone(row));
    count++;
  }
  if (payload.connection !== "live" && payload.metadataReady)
    throw new Error("非Liveのmetadataです");
  if (
    count !== [...expected.values()].reduce((sum, slots) => sum + slots.size, 0)
  )
    throw new Error("slot結果が不足しています");
  return rows;
}

export function createReadSlotSession(project: Project) {
  let owner = project,
    snapshot: Project,
    expected: Index<PlanRow>;
  let generation: ReadSlotGeneration, frame: ReadSlotFrame;
  function publish(
    phase: FrameData["phase"],
    rows: Index<ReadSlotRow> = new Map(),
  ) {
    const token = generation,
      published = Object.freeze({ kind: "read-slot-frame" as const });
    frame = published;
    frames.set(frame, {
      owner,
      projectId: snapshot.manifest.projectId,
      revision: snapshot.manifest.projectRevision,
      plan: expected,
      rows,
      phase,
      current: () => token === generation && published === frame,
    });
    return frame;
  }
  function reset(next: Project) {
    // Keep identity separate from the owned, validated plan. No caller mutation can edit it.
    const validated = parseProject(JSON.stringify(next));
    owner = next;
    snapshot = validated;
    expected = plan(validated);
    generation = Object.freeze({ kind: "read-slot-generation" as const });
    publish("disconnected");
    return { generation, frame };
  }
  reset(project);
  return {
    get generation() {
      return generation;
    },
    get frame() {
      return frame;
    },
    reset,
    receive(token: ReadSlotGeneration, payload: unknown) {
      if (token !== generation) return { accepted: false, frame };
      try {
        const rows = accept(payload, snapshot, expected);
        publish("ready", rows);
        return { accepted: true, frame };
      } catch {
        publish("invalid");
        return { accepted: false, frame };
      }
    },
  };
}

/** Caller derives this prop from the current Project and the returned publication frame. */
export function equipmentReadContext(
  project: Project,
  frame?: ReadSlotFrame,
): EquipmentContext {
  const accepted = frame ? frames.get(frame) : undefined;
  return {
    equipmentTypes: project.equipmentTypes,
    equipment: project.equipment,
    readSlot(equipmentId, slotName, expectedType, externalName) {
      if (
        !accepted ||
        !accepted.current() ||
        accepted.owner !== project ||
        accepted.projectId !== project.manifest.projectId ||
        accepted.revision !== project.manifest.projectRevision
      )
        return slotPresentation("disconnected");
      const request = get(accepted.plan, equipmentId, slotName);
      if (
        !request ||
        request.expectedType !== expectedType ||
        request.externalName !== externalName
      )
        return slotPresentation("invalid");
      if (accepted.phase !== "ready") return slotPresentation(accepted.phase);
      const row = get(accepted.rows, equipmentId, slotName)!;
      const reading = row.reading;
      if (reading.state !== "resolved")
        return slotPresentation(
          reading.state,
          reading.state === "invalid" ? reading.reason : undefined,
        );
      const provenance = row.provenance!;
      const simulated = isSimulatedSlot(provenance);
      if (reading.quality === "good") {
        const text = String(reading.value.value);
        return {
          state: "good",
          label: "Good",
          text: simulated ? `SIM · ${text}` : text,
          value: { ...reading.value },
          provenance: { ...provenance },
        };
      }
      const unavailable = slotPresentation(reading.quality);
      const presentation: SlotPresentation = {
        ...unavailable,
        text: simulated ? `SIM · ${unavailable.text}` : unavailable.text,
        provenance: { ...provenance },
      };
      return presentation;
    },
  };
}
