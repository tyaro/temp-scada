import Ajv2020 from "ajv/dist/2020.js";
import slotSchema from "../../../../crates/scada-runtime/schema/read-slot-view.schema.json";
import textSchema from "../../../../crates/scada-runtime/schema/runtime-view.schema.json";
import updateSchema from "../../../../crates/scada-runtime/schema/read-display-update.schema.json";
import { bindingReferences } from "./binding-references";
import { parseProject, type Project } from "./project";
import {
  createReadSlotSession,
  equipmentReadContext,
  type ReadSlotFrame,
  type ReadSlotView,
  type SlotProvenance,
} from "./read-slot-session";
import type { NumericReading, TagReadings } from "./tag-presentation";

export interface RuntimeView extends Omit<ReadSlotView, "slots"> {
  readings: Record<string, NumericReading>;
  provenance: Record<string, SlotProvenance>;
}
export interface ReadDisplayUpdate {
  sequence: number;
  sdkGeneration: number | null;
  text: RuntimeView;
  slots: ReadSlotView;
}
const validate = new Ajv2020({ allErrors: true, strictNumbers: true })
  .addSchema(slotSchema)
  .addSchema(textSchema)
  .compile<ReadDisplayUpdate>(updateSchema);

export type ReadPresentationToken = Readonly<{
  kind: "read-presentation-token";
}>;
export type ReadPresentationFrame = Readonly<{
  kind: "read-presentation-frame";
}>;
interface FrameData {
  owner: Project;
  projectId: string;
  revision: number;
  names: string[];
  phase: "ready" | "invalid" | "disconnected";
  update?: ReadDisplayUpdate;
  slots: ReadSlotFrame;
  current: () => boolean;
}
const frames = new WeakMap<ReadPresentationFrame, FrameData>();
const metadataKey = (p: SlotProvenance) =>
  JSON.stringify([p.catalogRevision, p.runId, p.collectionMode]);

/** Validates both halves before publishing either one. No Hub lifecycle here. */
export function createReadPresentationSession(project: Project) {
  let owner: Project, snapshot: Project, names: string[];
  let slots: ReturnType<typeof createReadSlotSession>;
  let token: ReadPresentationToken, frame: ReadPresentationFrame;
  let sequence = 0,
    highGeneration = 0,
    retiredGeneration = 0;
  let previousKind: string | undefined, metadata: string | undefined;
  function publish(phase: FrameData["phase"], update?: ReadDisplayUpdate) {
    const currentToken = token;
    const publication = Object.freeze({
      kind: "read-presentation-frame" as const,
    });
    frame = publication;
    frames.set(frame, {
      owner,
      projectId: snapshot.manifest.projectId,
      revision: snapshot.manifest.projectRevision,
      names,
      phase,
      update,
      slots: slots.frame,
      current: () => token === currentToken && frame === publication,
    });
    return frame;
  }
  function reset(next: Project) {
    snapshot = parseProject(JSON.stringify(next));
    owner = next;
    names = bindingReferences(snapshot).map((ref) => ref.externalName);
    if (slots) slots.reset(next);
    else slots = createReadSlotSession(next);
    token = Object.freeze({ kind: "read-presentation-token" as const });
    sequence = highGeneration = retiredGeneration = 0;
    previousKind = metadata = undefined;
    publish("disconnected");
    return { token, frame };
  }
  reset(project);
  return {
    get token() {
      return token;
    },
    get frame() {
      return frame;
    },
    reset,
    receive(delivery: ReadPresentationToken, payload: unknown) {
      if (delivery !== token) return { accepted: false, frame };
      try {
        const serial = (payload as Partial<ReadDisplayUpdate> | null)?.sequence;
        if (
          typeof serial === "number" &&
          Number.isSafeInteger(serial) &&
          serial > 0
        ) {
          if (serial <= sequence) return { accepted: false, frame };
          sequence = serial;
        }
        if (!validate(payload)) throw Error("表示DTOが不正です");
        const { text, slots: slotView, sdkGeneration } = payload;
        for (const key of [
          "projectId",
          "projectRevision",
          "connection",
          "lastError",
          "metadataReady",
        ] as const)
          if (text[key] !== slotView[key])
            throw Error("表示DTOの更新が一致しません");
        if (
          text.projectId !== snapshot.manifest.projectId ||
          text.projectRevision !== snapshot.manifest.projectRevision
        )
          throw Error("Projectが一致しません");
        const keys = Object.keys(text.readings);
        if (
          keys.length !== names.length ||
          names.some((name) => !Object.hasOwn(text.readings, name))
        )
          throw Error("Text planが一致しません");
        const settled =
          text.connection === "live" || text.connection === "unbound";
        if (settled !== (sdkGeneration !== null))
          throw Error("SDK世代が一致しません");
        if (
          sdkGeneration !== null &&
          (sdkGeneration < highGeneration ||
            sdkGeneration <= retiredGeneration ||
            (sdkGeneration === highGeneration &&
              previousKind !== text.connection))
        )
          throw Error("旧SDK世代の表示です");
        let identity: string | undefined;
        const observe = (p: SlotProvenance) => {
          const key = metadataKey(p);
          if (identity !== undefined && identity !== key)
            throw Error("metadataが混在しています");
          identity = key;
        };
        let resolved = 0;
        for (const name of names) {
          const reading = text.readings[name];
          const origin = Object.hasOwn(text.provenance, name)
            ? text.provenance[name]
            : undefined;
          if (text.connection === "live") {
            if (
              reading.state === "disconnected" ||
              (!text.metadataReady && reading.state !== "invalid")
            )
              throw Error("Textの接続状態が不正です");
          } else if (text.connection === "unbound") {
            if (!text.metadataReady || reading.state !== "unresolved")
              throw Error("タグ待ちのTextが不正です");
          } else if (text.metadataReady || reading.state !== "disconnected") {
            throw Error("非LiveのTextに値があります");
          }
          if (reading.state === "resolved") {
            if (!origin || !text.metadataReady || text.connection !== "live")
              throw Error("Textの由来がありません");
            observe(origin);
            resolved++;
          } else if (origin) throw Error("無値のTextに由来があります");
        }
        if (Object.keys(text.provenance).length !== resolved)
          throw Error("要求外の由来があります");
        for (const row of slotView.slots) {
          if (row.provenance) observe(row.provenance);
          if (
            row.externalName &&
            row.expectedType === "number" &&
            Object.hasOwn(text.readings, row.externalName)
          ) {
            const reading = text.readings[row.externalName];
            const origin = text.provenance[row.externalName];
            if (reading.state !== row.reading.state)
              throw Error("同じタグの状態が一致しません");
            if (
              reading.state === "resolved" &&
              row.reading.state === "resolved" &&
              (reading.quality !== row.reading.quality ||
                reading.numericValue !== (row.reading.value?.value ?? null) ||
                Object.keys(origin).some(
                  (key) =>
                    origin[key as keyof SlotProvenance] !==
                    row.provenance![key as keyof SlotProvenance],
                ))
            )
              throw Error("同じタグの値が一致しません");
          }
        }
        if (
          sdkGeneration !== null &&
          sdkGeneration === highGeneration &&
          identity &&
          metadata &&
          identity !== metadata
        )
          throw Error("同じSDK世代のmetadataが変更されました");
        // Reuse the complete slot-plan and type validator, after Text checks.
        if (!slots.receive(slots.generation, slotView).accepted)
          throw Error("slotが不正です");
        if (sdkGeneration === null)
          retiredGeneration = Math.max(retiredGeneration, highGeneration);
        else {
          if (sdkGeneration > highGeneration) metadata = undefined;
          highGeneration = sdkGeneration;
          previousKind = text.connection;
          if (identity) metadata = identity;
        }
        publish("ready", structuredClone(payload));
        return { accepted: true, frame };
      } catch {
        slots.receive(slots.generation, null);
        publish("invalid");
        return { accepted: false, frame };
      }
    },
  };
}

/** One guarded context feeds every view. Never return a stored mutable map. */
export function readPresentationContext(
  project: Project,
  frame?: ReadPresentationFrame,
) {
  const data = frame ? frames.get(frame) : undefined;
  const names = new Set(data?.names ?? []);
  const active = () =>
    !!data &&
    data.current() &&
    data.owner === project &&
    data.projectId === project.manifest.projectId &&
    data.revision === project.manifest.projectRevision;
  const get = (name: string): NumericReading | undefined => {
    if (!names.has(name) || !data) return undefined;
    if (!active()) return { state: "disconnected" };
    if (data.phase !== "ready") return { state: data.phase };
    const reading = structuredClone(data.update!.text.readings[name]);
    const origin = data.update!.text.provenance[name];
    return origin ? { ...reading, provenance: { ...origin } } : reading;
  };
  const copy = () =>
    new Map((data?.names ?? []).map((name) => [name, get(name)!]));
  const readings: TagReadings = {
    get,
    has: (key) => names.has(key),
    get size() {
      return data?.names.length ?? 0;
    },
    keys: () => copy().keys(),
    values: () => copy().values(),
    entries: () => copy().entries(),
    [Symbol.iterator]: () => copy().entries(),
    forEach: (callback, thisArg) =>
      copy().forEach((value, key) =>
        callback.call(thisArg, value, key, readings),
      ),
  };
  return {
    readings,
    equipmentContext: equipmentReadContext(
      project,
      active() ? data?.slots : undefined,
    ),
  };
}
