import {
  parseRecordingWireCallInspectionRequest,
  parseRecordingWireCallInspectionReply,
} from "../recording-wire-contract";
import { sameOwnedJson } from "../json-equality";
import {
  Core,
  Fault,
  yes,
  no,
  accepted,
  rejected,
  requireLedger,
  type QueryRecord,
  type AttemptRecord,
  type AttemptOutcome,
} from "./core";
import * as v from "./validation";
import type {
  OriginalCallToken,
  InspectionQueryToken,
  InspectionAttemptToken,
  LedgerResult,
  DeliveryAcceptResult,
} from "./types";
export function begin(
  c: Core,
  token: OriginalCallToken,
  input: unknown,
): LedgerResult<
  Readonly<{ query: InspectionQueryToken; attempt: InspectionAttemptToken }>
> {
  const o = c.lookup(c.originalTokens, token);
  if (!o) return no("foreignToken");
  try {
    const q = parseRecordingWireCallInspectionRequest(input);
    if (!sameOwnedJson(q.scope, c.scope)) return no("invalidRequest");
    const known = c.queries.get(q.callInspectionId);
    if (known) {
      if (known.original !== o || !sameOwnedJson(known.request, q)) {
        c.stop("protocolViolation");
        return no("protocolViolation");
      }
      return yes(
        Object.freeze({ query: known.token, attempt: known.first.token }),
      );
    }
    if (!sameOwnedJson(q.original, o.request)) return no("invalidRequest");
    const gate = c.gate();
    if (gate) return no(gate);
    if (o.terminal || c.pendingInspection()) return no("busy");
    const measured = v.bytes(q),
      I = o.credit ? o.I : measured;
    requireLedger(measured <= I, "invalidRequest");
    if (!o.credit) {
      c.canAdd(
        c.usage.inspectionIdsUsed + c.usage.inspectionIdsReserved,
        1,
        c.limits.inspectionIds,
      );
      c.canAdd(
        c.usage.inspectionAttemptsUsed + c.usage.inspectionAttemptsReserved,
        1,
        c.limits.inspectionAttempts,
      );
      c.canAdd(c.usage.readBytes, I + o.R + 2048, c.limits.readBytes);
    }
    const sequence = c.nextSequence(),
      queryToken = Object.freeze({}) as InspectionQueryToken,
      attemptToken = Object.freeze({}) as InspectionAttemptToken;
    const request = Object.freeze({
      version: 1 as const,
      kind: "recordingWireCallInspectionRequest" as const,
      scope: c.scope,
      callInspectionId: q.callInspectionId,
      original: o.request,
    });
    // The circular private records are never frozen or exposed; only tokens and owned DTOs are.
    const query = {
      token: queryToken,
      request,
      original: o,
      I,
      terminal: null,
    } as QueryRecord;
    const attempt: AttemptRecord = {
      token: attemptToken,
      query,
      R: o.R,
      outcome: null,
      applied: false,
    };
    query.first = attempt;
    query.latest = attempt;
    const result = yes(
      Object.freeze({ query: queryToken, attempt: attemptToken }),
    );
    if (o.credit) {
      c.usage.inspectionIdsReserved--;
      c.usage.inspectionAttemptsReserved--;
      o.credit = false;
    } else c.usage.readBytes += I + o.R + 2048;
    c.usage.inspectionIdsUsed++;
    c.usage.inspectionAttemptsUsed++;
    c.sequence = sequence;
    c.queries.set(q.callInspectionId, query);
    c.queryTokens.set(queryToken, query);
    c.attempts.set(sequence, attempt);
    c.attemptTokens.set(attemptToken, attempt);
    c.dirty = true;
    return result;
  } catch (error) {
    return no(error instanceof Fault ? error.reason : "invalidRequest");
  }
}
export function repeat(
  c: Core,
  token: unknown,
): LedgerResult<InspectionAttemptToken> {
  const q = c.lookup(c.queryTokens, token);
  if (!q) return no("foreignToken");
  const gate = c.gate();
  if (gate) return no(gate);
  if (
    q.original.terminal ||
    q.terminal ||
    q.latest.outcome === null ||
    c.pendingInspection()
  )
    return no("busy");
  try {
    c.canAdd(
      c.usage.inspectionAttemptsUsed + c.usage.inspectionAttemptsReserved,
      1,
      c.limits.inspectionAttempts,
    );
    c.canAdd(c.usage.readBytes, q.original.R + 1024, c.limits.readBytes);
    const sequence = c.nextSequence(),
      token = Object.freeze({}) as InspectionAttemptToken;
    const attempt: AttemptRecord = {
        token,
        query: q,
        R: q.original.R,
        outcome: null,
        applied: false,
      },
      result = yes(token);
    c.sequence = sequence;
    c.usage.inspectionAttemptsUsed++;
    c.usage.readBytes += q.original.R + 1024;
    c.attempts.set(sequence, attempt);
    c.attemptTokens.set(token, attempt);
    q.latest = attempt;
    c.dirty = true;
    return result;
  } catch (error) {
    return no(error instanceof Fault ? error.reason : "invalidRequest");
  }
}
export function accept(
  c: Core,
  token: unknown,
  input: unknown,
): DeliveryAcceptResult {
  const a = c.lookup(c.attemptTokens, token);
  if (!a) return rejected("foreignToken");
  const q = a.query,
    o = q.original;
  let parsed;
  try {
    parsed = parseRecordingWireCallInspectionReply(input);
    requireLedger(v.bytes(parsed.request) <= q.I, "invalidDocument");
  } catch {
    return c.fail("invalidDocument");
  }
  if (!sameOwnedJson(parsed.request, q.request))
    return c.fail("protocolViolation");
  let outcome: AttemptOutcome;
  if (parsed.outcome.kind === "terminal") {
    try {
      const reply = v.originalReply(o.request, parsed.outcome.reply);
      requireLedger(v.bytes(reply) <= a.R, "invalidDocument");
      if (!sameOwnedJson(reply.request, o.request))
        return c.fail("protocolViolation");
      outcome = Object.freeze({ kind: "terminal", reply });
    } catch {
      return c.fail("invalidDocument");
    }
  } else {
    outcome = parsed.outcome;
  }
  if (a.outcome)
    return sameOwnedJson(a.outcome, outcome)
      ? accepted("duplicate", a.applied, true)
      : c.fail("protocolViolation");
  const agrees =
    outcome.kind !== "terminal" ||
    o.terminal === null ||
    sameOwnedJson(o.terminal, outcome.reply);
  if (outcome.kind === "terminal" && o.terminal && agrees)
    outcome = Object.freeze({ kind: "terminal", reply: o.terminal });
  // Stage one stores the normal attempt even if its original reply conflicts in stage two.
  a.outcome = outcome;
  // Once the original has its terminal, no attempt's maximum reply is
  // awaited any more (a terminal reply is charged once, to its original).
  if (o.settled) c.releaseAttempt(a);
  c.dirty = true;
  if (outcome.kind === "terminal") {
    q.terminal ??= outcome.reply;
    if (!agrees) return c.fail("protocolViolation", true);
    if (!o.terminal) {
      o.terminal = outcome.reply;
      o.learnedBy = "inspection";
      c.settleOriginal(o, v.bytes(outcome.reply));
    }
    a.applied = true;
  }
  return accepted("stored", a.applied, true);
}
