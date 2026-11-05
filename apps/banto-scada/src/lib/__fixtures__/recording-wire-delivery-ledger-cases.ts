/** Test command DSL against the real pure ledger in Node and Chromium. */
import raw from "../../../../../examples/recording-wire-delivery-ledger-cases.json";
import {
  createRecordingWireDeliveryLedger,
  type DeliveryLimits,
  type LedgerResult,
  type WireDeliveryLedger,
} from "../recording-wire-delivery-ledger";
import { parseRecordingWireDocument } from "../recording-wire-contract";
import { parseRecordingAdmissionDocument } from "../recording-admission-contract";
import { receiverMetrics } from "./recording-wire-receiver-cases";
export const deliveryFixtures = raw as {
  scope: any;
  bases: Record<string, any>;
  replyOutcomes: Record<string, any>;
  scenarios: { name: string; limits?: any; steps: any[] }[];
};
export const cloneDelivery = <T>(v: T): T => JSON.parse(JSON.stringify(v));
export function patchDelivery(v: any, changes: any[] = []) {
  const out = cloneDelivery(v);
  for (const p of changes) {
    const keys = p.path.split(".");
    let at = out;
    for (const key of keys.slice(0, -1)) at = at[key];
    if (p.remove) delete at[keys.at(-1)];
    else at[keys.at(-1)] = cloneDelivery(p.value);
  }
  return out;
}
export function deliveryRequest(base = "lease", patch: any[] = []) {
  return patchDelivery(deliveryFixtures.bases[base], patch);
}
export function deliveryReply(q: any, variant = "default"): any {
  const kind = q.kind.replace(/Request$/, "Reply");
  let outcome: any;
  if (q.kind === "recordingWireLeaseRequest")
    outcome = {
      kind: "issued",
      deadlineLeaseRef: "lease-ref",
      grantedBudgetMs: Math.min(q.requestedBudgetMs, 100),
    };
  else if (q.kind === "recordingWireCancelRequest")
    outcome = { kind: "ack", disposition: "requested" };
  else if (q.kind === "recordingAdmissionRequest")
    outcome = cloneDelivery(
      deliveryFixtures.replyOutcomes[
        variant === "default" ? "unknown" : variant
      ],
    );
  else
    outcome =
      variant === "foundAccepted"
        ? { kind: "found", reply: deliveryReply(q.original, "accepted") }
        : { kind: "notFound" };
  return { version: 1, kind, request: cloneDelivery(q), outcome };
}
export function deliveryQuery(q: any, id = "query"): any {
  return {
    version: 1,
    kind: "recordingWireCallInspectionRequest",
    scope: cloneDelivery(deliveryFixtures.scope),
    callInspectionId: id,
    original: cloneDelivery(q),
  };
}
export function deliveryInspection(
  q: any,
  outcome = "pending",
  reply?: any,
): any {
  return {
    version: 1,
    kind: "recordingWireCallInspectionReply",
    request: cloneDelivery(q),
    outcome:
      outcome === "terminal"
        ? { kind: "terminal", reply }
        : outcome === "unavailable"
          ? { kind: "unavailable", error: "ownerUnavailable" }
          : { kind: outcome },
  };
}
export function makeDelivery(
  limits?: Partial<DeliveryLimits>,
): WireDeliveryLedger {
  const r = createRecordingWireDeliveryLedger(deliveryFixtures.scope, limits);
  if (!r.ok) throw Error(r.reason);
  return r.value;
}
export const deliveryTake = <T>(r: LedgerResult<T>): T => {
  if (!r.ok) throw Error(r.reason);
  return r.value;
};
export function frozenDelivery(v: any): boolean {
  return (
    v === null ||
    typeof v !== "object" ||
    (Object.isFrozen(v) && Object.values(v).every(frozenDelivery))
  );
}
function subset(actual: any, expected: any, path = "value") {
  if (expected !== null && typeof expected === "object") {
    for (const [k, v] of Object.entries(expected))
      subset(actual?.[k], v, path + "." + k);
  } else if (!Object.is(actual, expected))
    throw Error(
      path + ": " + JSON.stringify(actual) + " != " + JSON.stringify(expected),
    );
}
export function parseDelivery(v: any) {
  return v.kind.startsWith("recordingWire")
    ? parseRecordingWireDocument(v)
    : parseRecordingAdmissionDocument(v);
}
/** Independent test oracle: metrics implementation is separate from production walkers. */
export function deliveryCosts(q: any) {
  const Q = receiverMetrics(q).bytes;
  const R = q.kind.startsWith("recordingWire") ? Q + 65536 : 512 * 1024;
  const I = receiverMetrics(deliveryQuery(q, "r".repeat(64))).bytes;
  return {
    Q,
    R,
    I,
    original: Q + R + 1024,
    probe: I + R + 2048,
    repeat: R + 1024,
  };
}
export function runDeliveryScenario(s: {
  name: string;
  limits?: any;
  steps: any[];
}) {
  const ledger = makeDelivery(s.limits),
    tokens = new Map<string, any>(),
    queries = new Map<string, any>(),
    attempts = new Map<string, any>();
  const requests = new Map<any, any>(),
    queryRequests = new Map<any, any>(),
    queryOriginal = new Map<any, any>(),
    attemptQuery = new Map<any, any>();
  // Original delivery facts only; no native or server state model.
  const expectedOriginal = new Map<any, any>(),
    expectedAttempt = new Map<any, any>();
  const old: { value: any; json: string }[] = [];
  let documents = 0,
    reads = 0;
  for (const [index, step] of s.steps.entries())
    try {
      let input: any, result: any;
      const accept = step.op === "direct" || step.op === "receive";
      if (step.op === "begin") input = deliveryRequest(step.base, step.patch);
      if (step.op === "direct")
        input = deliveryReply(
          requests.get(tokens.get(step.id)) ?? deliveryRequest(),
          step.variant,
        );
      if (step.op === "query")
        input = patchDelivery(
          deliveryQuery(
            step.originalBase
              ? deliveryRequest(step.originalBase)
              : (requests.get(tokens.get(step.original)) ?? deliveryRequest()),
            step.wireId,
          ),
          step.patch,
        );
      if (step.op === "receive") {
        const query =
          queryRequests.get(attemptQuery.get(attempts.get(step.attempt))) ??
          deliveryQuery(deliveryRequest());
        let embedded = deliveryReply(query.original, step.variant);
        if (step.embeddedRequestPatch)
          embedded.request = patchDelivery(
            embedded.request,
            step.embeddedRequestPatch,
          );
        input = deliveryInspection(query, step.outcome, embedded);
      }
      if (input) {
        if (step.kind) input.kind = step.kind;
        if (step.requestPatch)
          input.request = patchDelivery(input.request, step.requestPatch);
        if (step.documentPatch) Object.assign(input, step.documentPatch);
        if (step.result !== "invalidDocument") {
          parseDelivery(input);
          documents++;
        }
      }
      switch (step.op) {
        case "begin":
          result = ledger.beginOriginal(input);
          if (result.ok) {
            if (step.sameAs && result.value !== tokens.get(step.sameAs))
              throw Error("exact original changed");
            tokens.set(step.id, result.value);
            requests.set(result.value, input);
          }
          break;
        case "direct":
          result = ledger.acceptOriginal(tokens.get(step.id), input);
          break;
        case "query":
          result = ledger.beginInspection(tokens.get(step.original), input);
          if (result.ok) {
            const { query, attempt } = result.value;
            if (step.sameQueryAs && query !== queries.get(step.sameQueryAs))
              throw Error("exact query changed");
            if (
              step.sameAttemptAs &&
              attempt !== attempts.get(step.sameAttemptAs)
            )
              throw Error("exact first attempt changed");
            queries.set(step.query, query);
            attempts.set(step.attempt, attempt);
            queryRequests.set(query, input);
            queryOriginal.set(query, tokens.get(step.original));
            attemptQuery.set(attempt, query);
          }
          break;
        case "repeat":
          result = ledger.repeatInspection(queries.get(step.query));
          if (result.ok) {
            attempts.set(step.attempt, result.value);
            attemptQuery.set(result.value, queries.get(step.query));
          }
          break;
        case "receive":
          result = ledger.acceptInspection(attempts.get(step.attempt), input);
          break;
        case "original":
          result = ledger.original(tokens.get(step.id));
          break;
        case "queryState":
          result = ledger.inspection(queries.get(step.id));
          if (
            result.ok &&
            step.latestAs &&
            result.value.latestAttempt !== attempts.get(step.latestAs)
          )
            throw Error("latest attempt changed");
          break;
        case "attempt":
          result = ledger.attempt(attempts.get(step.id));
          break;
        case "retire":
          result = ledger.retire();
          break;
        case "dispose":
          result = ledger.dispose();
          break;
        case "current":
          result = Object.freeze({ ok: true, value: ledger.current() });
          break;
        default:
          throw Error("unknown test command");
      }
      const want = step.result ?? (accept ? "stored" : "ok");
      if (want === "ok") {
        if (!result.ok) throw Error(JSON.stringify(result));
      } else if (want === "stored" || want === "duplicate") {
        subset(
          result,
          {
            ok: true,
            value: {
              disposition: want,
              ...(step.flags ?? {
                terminalStored:
                  step.op === "direct" || step.outcome === "terminal",
                attemptStored: step.op === "receive",
              }),
            },
          },
          "result",
        );
      } else
        subset(
          result,
          {
            ok: false,
            reason: want,
            ...(accept
              ? (step.flags ?? { terminalStored: false, attemptStored: false })
              : {}),
          },
          "result",
        );
      if (step.value) subset(result.value, step.value);
      if (step.state) subset(ledger.current(), step.state, "state");
      const flags = result.ok ? result.value : result;
      if (
        step.op === "direct" &&
        flags.terminalStored &&
        !expectedOriginal.has(tokens.get(step.id))
      )
        expectedOriginal.set(tokens.get(step.id), cloneDelivery(input));
      if (step.op === "receive") {
        const token = attempts.get(step.attempt),
          original = queryOriginal.get(attemptQuery.get(token));
        if (flags.attemptStored && !expectedAttempt.has(token))
          expectedAttempt.set(token, cloneDelivery(input));
        if (flags.terminalStored && !expectedOriginal.has(original))
          expectedOriginal.set(original, cloneDelivery(input.outcome.reply));
      }
      const committed = ledger.current();
      for (const token of new Set(tokens.values())) {
        const read = ledger.original(token);
        if (!read.ok) throw Error("original getter");
        if (
          JSON.stringify(read.value.request) !==
            JSON.stringify(requests.get(token)) ||
          JSON.stringify(read.value.terminal) !==
            JSON.stringify(expectedOriginal.get(token) ?? null)
        )
          throw Error("original body changed");
        if (read.value.terminal) parseDelivery(read.value.terminal);
        reads++;
        old.push({ value: read, json: JSON.stringify(read) });
      }
      for (const token of new Set(attempts.values())) {
        const read = ledger.attempt(token);
        if (!read.ok) throw Error("attempt getter");
        if (
          JSON.stringify(read.value.reply) !==
          JSON.stringify(expectedAttempt.get(token) ?? null)
        )
          throw Error("attempt body changed");
        if (read.value.reply) parseDelivery(read.value.reply);
        reads++;
        old.push({ value: read, json: JSON.stringify(read) });
      }
      if (ledger.current() !== committed)
        throw Error("getter republished cache");
      if (!frozenDelivery(result) || !frozenDelivery(committed))
        throw Error("mutable result");
      old.push({ value: committed, json: JSON.stringify(committed) });
      for (const prior of old)
        if (JSON.stringify(prior.value) !== prior.json)
          throw Error("old result changed");
    } catch (error) {
      throw Error(s.name + " / " + index + " (" + step.op + "): " + error);
    }
  return { documents, reads, state: ledger.current() };
}
