/** Shared receiver scenarios run against the real implementation in Vitest and Chromium.
 * This test command DSL is not a wire document, server registry or native adapter. */
import raw from "../../../../../examples/recording-wire-receiver-cases.json";
import readout from "../../../../../examples/recording-wire-readout-cases.json";
import { createRecordingWireReceiver } from "../recording-wire-receiver";
import { parseRecordingWireDocument } from "../recording-wire-contract";
import type { ReceiverLimits, WireReceiver } from "../recording-wire-receiver";
export const receiverFixtures = raw;
export const receiverReadoutFixtures = readout;
export const cloneReceiverJson = <T>(v: T): T => JSON.parse(JSON.stringify(v));
export function receiverSnapshot(
  rev = 1,
  patch: any = {},
  base = "simple",
): any {
  return {
    ...cloneReceiverJson(raw.snapshots[base as keyof typeof raw.snapshots]),
    revision: rev,
    ...patch,
  };
}
export function receiverAttachRequest(
  id = "a",
  after: number | null = null,
): any {
  return {
    version: 1,
    kind: "recordingWireAttachRequest",
    scope: cloneReceiverJson(raw.scope),
    attachId: id,
    afterRevision: after,
  };
}
export function receiverAttachReply(
  request: any,
  snapshot = receiverSnapshot(),
  ref = "s",
): any {
  return {
    version: 1,
    kind: "recordingWireAttachReply",
    request: cloneReceiverJson(request),
    outcome: { kind: "attached", subscriptionRef: ref, snapshot },
  };
}
export function receiverStateFrame(
  snapshot = receiverSnapshot(),
  ref = "s",
): any {
  return {
    version: 1,
    kind: "recordingWireStateFrame",
    subscriptionRef: ref,
    snapshot,
  };
}
export function receiverControlRequest(
  id = "c",
  action = "snapshot",
  ref = "s",
): any {
  return {
    version: 1,
    kind: "recordingWireControlRequest",
    scope: cloneReceiverJson(raw.scope),
    controlId: id,
    subscriptionRef: ref,
    action,
  };
}
export function receiverControlReply(
  request: any,
  snapshot = receiverSnapshot(2),
): any {
  return {
    version: 1,
    kind: "recordingWireControlReply",
    request: cloneReceiverJson(request),
    outcome: { kind: "snapshot", snapshot },
  };
}
export function receiverControlFrame(reason = "ownerClosed", ref = "s"): any {
  return {
    version: 1,
    kind: "recordingWireControlFrame",
    scope: cloneReceiverJson(raw.scope),
    subscriptionRef: ref,
    reason,
  };
}
export function makeReceiver(limits?: Partial<ReceiverLimits>): WireReceiver {
  const made = createRecordingWireReceiver(raw.scope, limits);
  if (!made.ok) throw Error("factory " + made.reason);
  return made.value;
}
export function deeplyFrozen(v: any): boolean {
  return (
    v === null ||
    typeof v !== "object" ||
    (Object.isFrozen(v) && Object.values(v).every(deeplyFrozen))
  );
}
function subset(actual: any, expected: any, path = "state") {
  if (expected !== null && typeof expected === "object") {
    for (const [key, v] of Object.entries(expected))
      subset(actual?.[key], v, path + "." + key);
  } else if (!Object.is(actual, expected))
    throw Error(
      `${path}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
    );
}
function reverseMembers(v: any) {
  if (v && typeof v === "object") {
    if (Array.isArray(v.members)) v.members.reverse();
    Object.values(v).forEach(reverseMembers);
  }
}
export function runReceiverScenario(scenario: {
  name: string;
  limits?: any;
  steps: any[];
}) {
  const r = makeReceiver(scenario.limits);
  const generations = new Map<string, any>(),
    controls = new Map<string, any>();
  const requests = new Map<string, any>(),
    controlRequests = new Map<string, any>();
  const prior: { state: unknown; json: string }[] = [];
  const expectedAttach = new Map<string, any>(),
    expectedControl = new Map<string, any>();
  const priorDisplays: { state: unknown; json: string }[] = [];
  const priorTerminals: any[] = [];
  let documents = 0,
    terminalReads = 0;
  for (const [index, s] of scenario.steps.entries()) {
    try {
      let input: any, result: any;
      const snapshot = () => {
        const v = receiverSnapshot(s.rev ?? 1, s.snapshot, s.snapshotBase);
        if (s.scopePatch) Object.assign(v.scope, s.scopePatch);
        if (s.reverseMembers) reverseMembers(v);
        return v;
      };
      switch (s.op) {
        case "beginAttach":
          input = receiverAttachRequest(s.id, s.after ?? null);
          break;
        case "attach":
          input = receiverAttachReply(requests.get(s.id), snapshot(), s.ref);
          break;
        case "state":
          input = receiverStateFrame(snapshot(), s.ref);
          break;
        case "controlFrame":
          input = receiverControlFrame(s.reason, s.ref);
          break;
        case "beginControl":
          input = receiverControlRequest(s.id, s.action, s.ref);
          break;
        case "controlReply":
          input = receiverControlReply(controlRequests.get(s.id), snapshot());
          break;
      }
      if (input) {
        if (s.outcome) input.outcome = cloneReceiverJson(s.outcome);
        if (s.requestPatch) Object.assign(input.request, s.requestPatch);
        if (s.documentPatch) Object.assign(input, s.documentPatch);
        if (s.result !== "invalidDocument") {
          parseRecordingWireDocument(input);
          documents++;
        }
      }
      switch (s.op) {
        case "connect":
          result = r.setConnected(s.value);
          break;
        case "dispose":
          result = r.dispose();
          break;
        case "retire":
          result = r.retire(generations.get(s.id));
          break;
        case "beginAttach":
          result = r.beginAttach(input);
          if (result.ok) {
            if (s.result === "cached" && result.value !== generations.get(s.id))
              throw Error("different cached generation");
            generations.set(s.id, result.value);
            requests.set(s.id, input);
          }
          break;
        case "attach":
          result = r.acceptAttach(generations.get(s.id), input);
          break;
        case "state":
          result = r.acceptState(generations.get(s.id), input);
          break;
        case "controlFrame":
          result = r.acceptControlFrame(generations.get(s.id), input);
          break;
        case "beginControl":
          result = r.beginControl(generations.get(s.generation), input);
          if (result.ok) {
            if (s.result === "cached" && result.value !== controls.get(s.id))
              throw Error("different cached control");
            controls.set(s.id, result.value);
            controlRequests.set(s.id, input);
          }
          break;
        case "controlReply":
          result = r.acceptControlReply(controls.get(s.id), input);
          break;
        case "attachTerminal":
          result = r.attachTerminal(generations.get(s.id));
          break;
        case "controlTerminal":
          result = r.controlTerminal(controls.get(s.id));
          break;
        case "observe":
          result = Object.freeze({ ok: true, value: null });
          break;
        default:
          throw Error("unknown test op");
      }
      // Test oracle records only normal original deliveries, never frame knowledge.
      if (input && (result.ok || result.terminalStored === true)) {
        const ledger =
          s.op === "attach"
            ? expectedAttach
            : s.op === "controlReply"
              ? expectedControl
              : null;
        if (ledger && !ledger.has(s.id))
          ledger.set(s.id, cloneReceiverJson(input));
      }
      const wanted = s.result ?? "applied";
      if (
        ["applied", "duplicate", "ignoredRetired", "resyncRequired"].includes(
          wanted,
        )
      ) {
        if (
          !result.ok ||
          (result.value?.disposition && result.value.disposition !== wanted)
        )
          throw Error("result " + JSON.stringify(result));
      } else if (wanted !== "cached") {
        subset(
          result,
          {
            ok: false,
            reason: wanted,
            terminalStored: s.terminalStored ?? false,
          },
          "result",
        );
      } else if (!result.ok) throw Error("cache " + JSON.stringify(result));
      if ((s.op === "attachTerminal" || s.op === "controlTerminal") && s.value)
        subset(result.value, s.value, "value");
      if (s.state) subset(r.current(), s.state);
      if (s.display) subset(r.currentDisplay(), s.display, "display");
      const committed = r.current(),
        view = r.currentDisplay();
      if (
        !deeplyFrozen(view) ||
        view.scope !== committed.scope ||
        view.snapshot !== committed.latest ||
        view.generation !== committed.generation ||
        view.usage !== committed.usage
      )
        throw Error("readout lost owned references");
      for (const [tokens, tokenRequests, replies, get] of [
        [
          generations,
          requests,
          expectedAttach,
          (t: any) => r.attachTerminal(t),
        ],
        [
          controls,
          controlRequests,
          expectedControl,
          (t: any) => r.controlTerminal(t),
        ],
      ] as const)
        for (const [id, token] of tokens) {
          const got = get(token);
          const expected = replies.has(id)
            ? {
                kind: "terminal",
                request: tokenRequests.get(id),
                reply: replies.get(id),
              }
            : { kind: "pending", request: tokenRequests.get(id) };
          if (
            !got.ok ||
            JSON.stringify(got.value) !== JSON.stringify(expected) ||
            !deeplyFrozen(got)
          )
            throw Error("original terminal mismatch");
          priorTerminals.push({ value: got, json: JSON.stringify(got) });
          terminalReads++;
        }
      if (r.current() !== committed || r.currentDisplay() !== view)
        throw Error("read changed committed cache");
      for (const old of [
        ...priorDisplays,
        ...priorTerminals.map((v) => ({ state: v.value, json: v.json })),
      ])
        if (JSON.stringify(old.state) !== old.json)
          throw Error("old readout mutated");
      priorDisplays.push({ state: view, json: JSON.stringify(view) });
      if (!deeplyFrozen(r.current()) || !deeplyFrozen(result))
        throw Error("mutable result");
      for (const old of prior)
        if (JSON.stringify(old.state) !== old.json)
          throw Error("old state mutated");
      prior.push({ state: r.current(), json: JSON.stringify(r.current()) });
    } catch (error) {
      throw Error(`${scenario.name} / ${index} (${s.op}): ${error}`);
    }
  }
  return {
    documents,
    terminalReads,
    state: r.current(),
    display: r.currentDisplay(),
  };
}
/** Independent structural oracle. Deliberately does not import production measurement. */
export function receiverMetrics(
  v: any,
  depth = 0,
): { bytes: number; nodes: number; depth: number } {
  if (v === null) return { bytes: 4, nodes: 1, depth };
  if (typeof v === "number") return { bytes: 24, nodes: 1, depth };
  if (typeof v === "boolean") return { bytes: v ? 4 : 5, nodes: 1, depth };
  const stringBytes = (s: string) => {
    let bytes = 2;
    for (const ch of s) {
      const cp = ch.codePointAt(0)!;
      bytes +=
        cp < 32
          ? 6
          : cp === 34 || cp === 92
            ? 2
            : new TextEncoder().encode(ch).length;
    }
    return bytes;
  };
  if (typeof v === "string") return { bytes: stringBytes(v), nodes: 1, depth };
  const children = Array.isArray(v) ? v : Object.values(v);
  const metrics = children.map((child: any) =>
    receiverMetrics(child, depth + 1),
  );
  const keys = Array.isArray(v)
    ? 0
    : Object.keys(v).reduce((n, key) => n + stringBytes(key) + 1, 0);
  return {
    bytes:
      2 +
      Math.max(0, children.length - 1) +
      keys +
      metrics.reduce((n: any, m: any) => n + m.bytes, 0),
    nodes: 1 + metrics.reduce((n: any, m: any) => n + m.nodes, 0),
    depth: Math.max(depth, ...metrics.map((m: any) => m.depth)),
  };
}
