/** Pure Observation delivery records. Normal replies are evidence, not transport completion. */
import {
  parseRecordingWireObservationRequest,
  parseRecordingWireObservationReply,
  recordingWireReplyCapacity,
} from "../recording-wire-contract";
import { measureWire, wireProfile } from "../recording-wire/budget";
import { sameOwnedJson } from "../json-equality";
import {
  Core,
  Fault,
  yes,
  no,
  requireLedger,
  observationAccepted,
  observationRejected,
  type ObservationTargetRecord,
  type ObservationQueryRecord,
  type ObservationAttemptRecord,
} from "./core";
import type {
  OriginalCallToken,
  ObservationTargetToken,
  ObservationQueryToken,
  ObservationAttemptToken,
  ObservationTargetState,
  ObservationQueryState,
  ObservationAttemptState,
  LedgerResult,
  ObservationAcceptResult,
} from "./types";

const M = 1024;
function bytes(value: { kind: string }): number {
  const p = wireProfile(value.kind);
  return measureWire(value, p.limit, p.accounting).bytes;
}
function refKey(target: ObservationTargetRecord["target"]): string {
  return target.kind === "operation"
    ? `operation:${target.operationRef}`
    : `reconciliation:${target.readRef}`;
}

export function bind(
  c: Core,
  source: OriginalCallToken,
): LedgerResult<ObservationTargetToken> {
  const original = c.lookup(c.originalTokens, source);
  if (!original) return no("foreignToken");
  const request = original.request;
  const terminal = original.terminal;
  const reply =
    request.kind === "recordingAdmissionRequest" &&
    terminal?.kind === "recordingAdmissionReply"
      ? terminal
      : request.kind === "recordingAdmissionInspectionRequest" &&
          terminal?.kind === "recordingAdmissionInspectionReply" &&
          terminal.outcome.kind === "found"
        ? terminal.outcome.reply
        : null;
  if (!reply || reply.outcome.kind !== "accepted") return no("invalidRequest");
  const admission = reply.request;
  const expectedAdmission =
    request.kind === "recordingAdmissionRequest"
      ? request
      : request.kind === "recordingAdmissionInspectionRequest"
        ? request.original
        : null;
  if (!expectedAdmission || !sameOwnedJson(admission, expectedAdmission))
    return no("invalidRequest");
  const accepted = reply.outcome.handle;
  const target =
    accepted.kind === "operation"
      ? Object.freeze({
          kind: "operation" as const,
          operationRef: accepted.operationRef,
          request: accepted.request,
        })
      : Object.freeze({
          kind: "reconciliation" as const,
          readRef: accepted.readRef,
          request: accepted.request,
        });
  const known = c.observationTargets.get(admission.admissionId);
  if (known) {
    if (
      !sameOwnedJson(known.admission, admission) ||
      !sameOwnedJson(known.accepted, accepted)
    ) {
      c.stop("protocolViolation");
      return no("protocolViolation");
    }
    return yes(known.token);
  }
  if (c.observationTargetRefs.has(refKey(target))) {
    c.stop("protocolViolation");
    return no("protocolViolation");
  }
  const gate = c.gate();
  if (gate) return no(gate);
  try {
    c.canAdd(c.usage.observationTargets, 1, c.limits.observationTargets);
    c.canAdd(c.usage.observationBytes, M, c.limits.observationBytes);
    const token = Object.freeze({}) as ObservationTargetToken;
    const record: ObservationTargetRecord = {
      token,
      target,
      admission,
      accepted,
      result: null,
    };
    const result = yes(token);
    c.observationTargets.set(admission.admissionId, record);
    c.observationTargetRefs.set(refKey(target), record);
    c.observationTargetTokens.set(token, record);
    c.usage.observationTargets++;
    c.usage.observationBytes += M;
    c.dirty = true;
    return result;
  } catch (error) {
    return no(error instanceof Fault ? error.reason : "invalidRequest");
  }
}

export function target(
  c: Core,
  token: ObservationTargetToken,
): LedgerResult<ObservationTargetState> {
  const record = c.lookup(c.observationTargetTokens, token);
  return record
    ? yes(
        Object.freeze({
          target: record.target,
          admission: record.admission,
          accepted: record.accepted,
          result: record.result,
        }),
      )
    : no("foreignToken");
}

export function begin(
  c: Core,
  token: ObservationTargetToken,
  input: unknown,
): LedgerResult<
  Readonly<{ query: ObservationQueryToken; attempt: ObservationAttemptToken }>
> {
  try {
    const request = parseRecordingWireObservationRequest(input);
    if (!sameOwnedJson(request.scope, c.scope)) return no("invalidRequest");
    const target = c.lookup(c.observationTargetTokens, token);
    if (!target) return no("foreignToken");
    const known = c.observationQueries.get(request.observationId);
    if (known) {
      if (known.target !== target || !sameOwnedJson(known.request, request)) {
        c.stop("protocolViolation");
        return no("protocolViolation");
      }
      return yes(
        Object.freeze({ query: known.token, attempt: known.first.token }),
      );
    }
    if (!sameOwnedJson(request.target, target.target))
      return no("invalidRequest");
    const gate = c.gate();
    if (gate) return no(gate);
    if ([...c.observationAttempts.values()].some((a) => a.reply === null))
      return no("busy");
    const Q = bytes(request),
      R = recordingWireReplyCapacity(request).reply.bytes;
    c.canAdd(c.usage.observationQueries, 1, c.limits.observationQueries);
    c.canAdd(c.usage.observationAttempts, 1, c.limits.observationAttempts);
    c.canAdd(
      c.usage.observationBytes,
      Q + R + 2 * M,
      c.limits.observationBytes,
    );
    const sequence = c.nextSequence();
    const queryToken = Object.freeze({}) as ObservationQueryToken;
    const attemptToken = Object.freeze({}) as ObservationAttemptToken;
    const query = {
      token: queryToken,
      request,
      target,
      terminal: null,
    } as ObservationQueryRecord;
    const attempt: ObservationAttemptRecord = {
      token: attemptToken,
      query,
      R,
      reply: null,
      queryTerminalStored: false,
      targetResultStored: false,
    };
    query.first = attempt;
    query.latest = attempt;
    const result = yes(
      Object.freeze({ query: queryToken, attempt: attemptToken }),
    );
    c.sequence = sequence;
    c.observationQueries.set(request.observationId, query);
    c.observationQueryTokens.set(queryToken, query);
    c.observationAttempts.set(sequence, attempt);
    c.observationAttemptTokens.set(attemptToken, attempt);
    c.usage.observationQueries++;
    c.usage.observationAttempts++;
    c.usage.observationBytes += Q + R + 2 * M;
    c.dirty = true;
    return result;
  } catch (error) {
    return no(error instanceof Fault ? error.reason : "invalidRequest");
  }
}

export function repeat(
  c: Core,
  token: ObservationQueryToken,
): LedgerResult<ObservationAttemptToken> {
  const query = c.lookup(c.observationQueryTokens, token);
  if (!query) return no("foreignToken");
  const gate = c.gate();
  if (gate) return no(gate);
  if (query.terminal) return no("busy");
  if ([...c.observationAttempts.values()].some((a) => a.reply === null))
    return no("busy");
  try {
    const R = recordingWireReplyCapacity(query.request).reply.bytes;
    c.canAdd(c.usage.observationAttempts, 1, c.limits.observationAttempts);
    c.canAdd(c.usage.observationBytes, R + M, c.limits.observationBytes);
    const sequence = c.nextSequence();
    const attemptToken = Object.freeze({}) as ObservationAttemptToken;
    const attempt: ObservationAttemptRecord = {
      token: attemptToken,
      query,
      R,
      reply: null,
      queryTerminalStored: false,
      targetResultStored: false,
    };
    const result = yes(attemptToken);
    c.sequence = sequence;
    c.observationAttempts.set(sequence, attempt);
    c.observationAttemptTokens.set(attemptToken, attempt);
    query.latest = attempt;
    c.usage.observationAttempts++;
    c.usage.observationBytes += R + M;
    c.dirty = true;
    return result;
  } catch (error) {
    return no(error instanceof Fault ? error.reason : "invalidRequest");
  }
}

export function accept(
  c: Core,
  token: ObservationAttemptToken,
  input: unknown,
): ObservationAcceptResult {
  const attempt = c.lookup(c.observationAttemptTokens, token);
  if (!attempt) return observationRejected("foreignToken");
  let reply;
  try {
    reply = parseRecordingWireObservationReply(input);
    requireLedger(bytes(reply) <= attempt.R, "invalidDocument");
  } catch {
    c.stop("invalidDocument");
    return observationRejected("invalidDocument");
  }
  const query = attempt.query;
  if (!sameOwnedJson(reply.request, query.request)) {
    c.stop("protocolViolation");
    return observationRejected("protocolViolation");
  }
  if (attempt.reply) {
    if (!sameOwnedJson(attempt.reply, reply)) {
      c.stop("protocolViolation");
      return observationRejected("protocolViolation");
    }
    return observationAccepted("duplicate", {
      attemptStored: true,
      queryTerminalStored: attempt.queryTerminalStored,
      targetResultStored: attempt.targetResultStored,
    });
  }
  // Keep one owned request per query and one payload per target when a later ID
  // reports the same result. A conflicting payload stays in its attempt as evidence.
  const incomingOutcome = reply.outcome;
  if (
    incomingOutcome.kind === "operation" &&
    query.target.result?.kind === "recordingOperationResult" &&
    sameOwnedJson(query.target.result, incomingOutcome.result)
  )
    reply = Object.freeze({
      ...reply,
      request: query.request,
      outcome: Object.freeze({
        ...incomingOutcome,
        result: query.target.result,
      }),
    });
  else if (
    incomingOutcome.kind === "reconciliation" &&
    query.target.result?.kind === "recordingReconciliationDelivery" &&
    sameOwnedJson(query.target.result, incomingOutcome.delivery)
  )
    reply = Object.freeze({
      ...reply,
      request: query.request,
      outcome: Object.freeze({
        ...incomingOutcome,
        delivery: query.target.result,
      }),
    });
  else reply = Object.freeze({ ...reply, request: query.request });
  attempt.reply = reply;
  c.dirty = true;
  if (reply.outcome.kind === "pending")
    return observationAccepted("stored", {
      attemptStored: true,
      queryTerminalStored: false,
      targetResultStored: false,
    });
  if (query.terminal && !sameOwnedJson(query.terminal, reply)) {
    c.stop("protocolViolation");
    return observationRejected("protocolViolation", {
      attemptStored: true,
      queryTerminalStored: false,
      targetResultStored: false,
    });
  }
  if (!query.terminal) query.terminal = reply;
  attempt.queryTerminalStored = true;
  const outcome = reply.outcome;
  if (outcome.kind === "operation" || outcome.kind === "reconciliation") {
    const result =
      outcome.kind === "operation" ? outcome.result : outcome.delivery;
    if (query.target.result && !sameOwnedJson(query.target.result, result)) {
      c.stop("protocolViolation");
      return observationRejected("protocolViolation", {
        attemptStored: true,
        queryTerminalStored: true,
        targetResultStored: false,
      });
    }
    query.target.result ??= result;
    attempt.targetResultStored = true;
  }
  return observationAccepted("stored", {
    attemptStored: true,
    queryTerminalStored: true,
    targetResultStored: attempt.targetResultStored,
  });
}

export function query(
  c: Core,
  token: ObservationQueryToken,
): LedgerResult<ObservationQueryState> {
  const record = c.lookup(c.observationQueryTokens, token);
  return record
    ? yes(
        Object.freeze({
          request: record.request,
          firstAttempt: record.first.token,
          latestAttempt: record.latest.token,
          terminal: record.terminal,
        }),
      )
    : no("foreignToken");
}

export function attempt(
  c: Core,
  token: ObservationAttemptToken,
): LedgerResult<ObservationAttemptState> {
  const record = c.lookup(c.observationAttemptTokens, token);
  return record
    ? yes(Object.freeze({ request: record.query.request, reply: record.reply }))
    : no("foreignToken");
}
