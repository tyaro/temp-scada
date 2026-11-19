/**
 * Editor の表示プレビュー・運転表示の模擬の書込み（段階3の運転操作 §8、
 * O3c-2）。Hub へは送らず、slot のタグの模擬値を書いた値に変え、その結果を
 * 小窓に出す。IPC を呼ばない。値の解決は host の `resolve`
 * （crates/scada-host/src/operation_write/resolve.rs）の順に写す。Hub の
 * カタログが無いので、タグの有無・書込みの可否・整数の型は確かめない。
 *
 * 模擬値は Editor の編集 session に持ち、Project には入れない。実 Hub を
 * 購読しているときは書かず（操作の行を押せなくする）、重ねもしない。
 */
import { slotReadType, type SlotReadType } from "./equipment";
import {
  inputDecimals,
  parseOperationInput,
  type OperationLatest,
  type OperationView,
  type OperationWriteRequest,
  type WriteResult,
} from "./operation";
import type { OperationHost } from "./operation-faceplate";
import type { Project } from "./project";
import type { SlotProvenance } from "./read-slot-session";
import { slotPresentation, type SlotValue } from "./slot-presentation";
import type { EquipmentContext } from "./symbol-slots";
import type { NumericReading, TagReadings } from "./tag-presentation";

/**
 * 実 Hub の購読中に操作の行を押せなくする理由のコード。TS だけのコードで、
 * host は返さない（文は `operation.ts` の `reasonText`）。
 */
export const SIMULATED_ON_HUB = "simulated_on_hub";
/** 模擬の host の Project の版。Editor の Project には digest が無い。 */
export const SIMULATED_DIGEST = "editor-simulation";
/** 模擬の host の `phase`（初期設定中の文を出さない）。 */
export const SIMULATED_PHASE = "simulation";

/** 編集 session の模擬の書込みの状態（不変。書くたびに新しく作る）。 */
export interface Simulation {
  /** 模擬値を書いた Project。別の Project では使わない。 */
  projectId: string | null;
  /** タグ（外部名）ごとの模擬値と書いた時刻。 */
  values: ReadonlyMap<string, { value: SlotValue; atMs: number }>;
  /** 機器・slot ごとの最後の模擬の書込み（`latestKey`）。 */
  latest: ReadonlyMap<string, OperationLatest>;
  sequence: number;
}

export function emptySimulation(): Simulation {
  return { projectId: null, values: new Map(), latest: new Map(), sequence: 0 };
}

const latestKey = (equipmentId: string, slotName: string) =>
  `${equipmentId}\u0000${slotName}`;
const current = (simulation: Simulation, project: Project) =>
  simulation.projectId === project.manifest.projectId
    ? simulation
    : emptySimulation();

/** 照会（`operation_view` の代わり）。実 Hub の購読中は押せなくする。 */
export function simulatedView(
  project: Project,
  simulation: Simulation,
  equipmentId: string,
  readsHub: boolean,
): OperationView {
  const state = current(simulation, project);
  const equipment = project.equipment?.find((item) => item.id === equipmentId);
  const type = project.equipmentTypes?.find(
    (item) => item.id === equipment?.typeId,
  );
  return {
    projectId: project.manifest.projectId,
    projectDigest: SIMULATED_DIGEST,
    blocked: readsHub ? SIMULATED_ON_HUB : null,
    phase: SIMULATED_PHASE,
    slots: (type?.slots ?? [])
      .filter((slot) => slot.write)
      .map((slot) => ({
        slot: slot.name,
        latest: state.latest.get(latestKey(equipmentId, slot.name)) ?? null,
      })),
  };
}

function refused(reason: string, tag: string | null = null): WriteResult {
  return {
    outcome: "refused",
    reason,
    tag,
    value: null,
    auditId: null,
    recordId: null,
    unrecorded: false,
  };
}

type Resolved = { tag: string; value: SlotValue };
/** host `resolve` の順で、書く値とタグを決める。拒否は理由のコード。 */
function resolveWrite(
  project: Project,
  request: OperationWriteRequest,
): Resolved | { reason: string; tag?: string } {
  if (
    request.projectId !== project.manifest.projectId ||
    request.projectDigest !== SIMULATED_DIGEST
  )
    return { reason: "project_changed" };
  const equipment = project.equipment?.find(
    (item) => item.id === request.equipmentId,
  );
  if (!equipment) return { reason: "unknown_equipment" };
  const placement = project.screens
    .find((screen) => screen.id === request.screenId)
    ?.objects.find((object) => object.id === request.objectId);
  if (
    placement?.shape.type !== "symbol" ||
    placement.shape.equipmentId !== request.equipmentId
  )
    return { reason: "invalid_request" };
  const slot = project.equipmentTypes
    ?.find((item) => item.id === equipment.typeId)
    ?.slots.find((item) => item.name === request.slotName);
  if (!slot) return { reason: "unknown_slot" };
  if (!slot.write) return { reason: "no_write_def" };
  const readType: SlotReadType = slotReadType(slot.type);
  let value: SlotValue;
  if (request.buttonIndex !== undefined) {
    const button = slot.write.buttons?.[request.buttonIndex];
    if (
      !button ||
      typeof button.value !== (readType === "bool" ? "boolean" : "number")
    )
      return { reason: "invalid_button" };
    value =
      typeof button.value === "boolean"
        ? { type: "bool", value: button.value }
        : { type: "number", value: button.value };
  } else if (request.input !== undefined) {
    const parsed = parseOperationInput(
      request.input,
      slot.type,
      inputDecimals(
        project,
        request.screenId,
        request.objectId,
        request.slotName,
      ),
      slot.write.input ?? null,
    );
    if (!parsed.ok) return { reason: parsed.reason };
    value = { type: "number", value: parsed.value };
  } else return { reason: "invalid_request" };
  const tag = equipment.bindings.find(
    (binding) => binding.slotName === request.slotName,
  )?.externalName;
  if (!tag) return { reason: "unbound" };
  if (value.value !== request.expectedValue)
    return { reason: "project_changed", tag };
  return { tag, value };
}

/**
 * 模擬の書込み（`operation_write` の代わり）。通れば slot のタグの模擬値を
 * 書いた値に変え、機器・slot の最後の 1 件として残す。拒否は残さない。
 */
export function simulateWrite(
  project: Project,
  simulation: Simulation,
  request: OperationWriteRequest,
  nowMs: number,
): { simulation: Simulation; result: WriteResult } {
  const resolved = resolveWrite(project, request);
  if ("reason" in resolved)
    return { simulation, result: refused(resolved.reason, resolved.tag) };
  const state = current(simulation, project);
  const sequence = state.sequence + 1;
  const id = `simulated-${sequence}`;
  const latest: OperationLatest = {
    id,
    state: "finished",
    outcome: "ok",
    reason: null,
    requestedAtMs: nowMs,
    finishedAtMs: nowMs,
    tag: resolved.tag,
    value: resolved.value.value,
    auditId: null,
  };
  return {
    simulation: {
      projectId: project.manifest.projectId,
      values: new Map(state.values).set(resolved.tag, {
        value: resolved.value,
        atMs: nowMs,
      }),
      latest: new Map(state.latest).set(
        latestKey(request.equipmentId, request.slotName),
        latest,
      ),
      sequence,
    },
    result: {
      outcome: "ok",
      reason: null,
      tag: resolved.tag,
      value: resolved.value.value,
      auditId: null,
      recordId: id,
      unrecorded: false,
    },
  };
}

/** Editor の模擬の host。`simulated` で小窓に「模擬」と出す。 */
export function createSimulatedOperationHost(options: {
  project: () => Project;
  simulation: () => Simulation;
  /** プレビューが実 Hub を購読しているか。 */
  readsHub: () => boolean;
  update: (next: Simulation) => void;
  now?: () => number;
}): OperationHost {
  const now = options.now ?? Date.now;
  return {
    simulated: true,
    get projectId() {
      return options.project().manifest.projectId;
    },
    projectDigest: SIMULATED_DIGEST,
    view: async (equipmentId) =>
      simulatedView(
        options.project(),
        options.simulation(),
        equipmentId,
        options.readsHub(),
      ),
    write: async (request) => {
      if (options.readsHub()) return refused(SIMULATED_ON_HUB);
      const { simulation, result } = simulateWrite(
        options.project(),
        options.simulation(),
        request,
        now(),
      );
      if (result.outcome === "ok") options.update(simulation);
      return result;
    },
  };
}

function provenance(atMs: number): SlotProvenance {
  return {
    catalogRevision: 0,
    runId: null,
    collectionMode: "configured",
    valueSource: "simulation",
    sourceTimestampMs: atMs,
  };
}

/**
 * 読取の表示に模擬値を重ねる（実 Hub を購読していないときだけ使う）。
 * 模擬値のあるタグは Good（SIM つき）にし、ほかは元の表示のまま。
 */
export function simulatedReadContext(
  base: { readings: TagReadings; equipmentContext: EquipmentContext },
  simulation: Simulation,
  project: Project,
): { readings: TagReadings; equipmentContext: EquipmentContext } {
  const values = current(simulation, project).values;
  if (!values.size) return base;
  const reading = (name: string): NumericReading | undefined => {
    const entry = values.get(name);
    if (!entry) return base.readings.get(name);
    const origin = provenance(entry.atMs);
    return entry.value.type === "bool"
      ? {
          state: "resolved",
          quality: "good",
          numericValue: null,
          boolValue: entry.value.value,
          provenance: origin,
        }
      : {
          state: "resolved",
          quality: "good",
          numericValue: entry.value.value,
          provenance: origin,
        };
  };
  const names = () => new Set([...base.readings.keys(), ...values.keys()]);
  const copy = () =>
    new Map([...names()].map((name) => [name, reading(name)!] as const));
  const readings: TagReadings = {
    get: reading,
    has: (key) => values.has(key) || base.readings.has(key),
    get size() {
      return names().size;
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
  const readSlot: EquipmentContext["readSlot"] = (
    equipmentId,
    slotName,
    expectedType,
    externalName,
  ) => {
    const entry = values.get(externalName);
    if (!entry || entry.value.type !== expectedType)
      return (
        base.equipmentContext.readSlot?.(
          equipmentId,
          slotName,
          expectedType,
          externalName,
        ) ?? slotPresentation("disconnected")
      );
    return {
      state: "good",
      label: "Good",
      text: `SIM · ${String(entry.value.value)}`,
      value: { ...entry.value },
      provenance: provenance(entry.atMs),
    };
  };
  return {
    readings,
    equipmentContext: { ...base.equipmentContext, readSlot },
  };
}
