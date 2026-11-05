import { sameOwnedJson } from "../json-equality";
import {
  Core,
  Fault,
  yes,
  no,
  accepted,
  rejected,
  requireLedger,
  type OriginalRecord,
} from "./core";
import * as v from "./validation";
import type {
  LedgerResult,
  OriginalCallToken,
  DeliveryAcceptResult,
} from "./types";
export function begin(
  c: Core,
  input: unknown,
): LedgerResult<OriginalCallToken> {
  try {
    const q = v.originalRequest(input);
    if (!v.matchesScope(c.scope, q)) return no("invalidRequest");
    const id = v.key(q),
      known = c.originals.get(id);
    if (known) {
      if (!sameOwnedJson(known.request, q)) {
        c.stop("protocolViolation");
        return no("protocolViolation");
      }
      return yes(known.token);
    }
    const gate = c.gate(true);
    if (gate) return no(gate);
    const pool = v.pool(q);
    if (c.pending(pool)) return no("busy");
    const { Q, R, I } = v.reservation(c.scope, q),
      cost = Q + R + 1024,
      probe = I + R + 2048;
    c.canAdd(
      c.usage[(pool + "Ids") as "mutationIds" | "readIds"],
      1,
      c.limits[(pool + "Ids") as "mutationIds" | "readIds"],
    );
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
    c.canAdd(
      c.usage.readBytes,
      probe + (pool === "read" ? cost : 0),
      c.limits.readBytes,
    );
    if (pool === "mutation")
      c.canAdd(c.usage.mutationBytes, cost, c.limits.mutationBytes);
    const token = Object.freeze({}) as OriginalCallToken;
    const record: OriginalRecord = {
      token,
      request: q,
      pool,
      R,
      I,
      credit: true,
      terminal: null,
      learnedBy: null,
    };
    const result = yes(token);
    c.originals.set(id, record);
    c.originalTokens.set(token, record);
    if (pool === "mutation") {
      c.usage.mutationBytes += cost;
      c.usage.mutationIds++;
    } else {
      c.usage.readBytes += cost;
      c.usage.readIds++;
    }
    c.usage.readBytes += probe;
    c.usage.inspectionIdsReserved++;
    c.usage.inspectionAttemptsReserved++;
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
  const record = c.lookup(c.originalTokens, token);
  if (!record) return rejected("foreignToken");
  let reply;
  try {
    reply = v.originalReply(record.request, input);
    requireLedger(v.bytes(reply) <= record.R, "invalidDocument");
  } catch {
    return c.fail("invalidDocument");
  }
  if (!sameOwnedJson(reply.request, record.request))
    return c.fail("protocolViolation");
  if (record.terminal)
    return sameOwnedJson(record.terminal, reply)
      ? accepted("duplicate", true, false)
      : c.fail("protocolViolation");
  const result = accepted("stored", true, false);
  record.terminal = reply;
  record.learnedBy = "direct";
  c.dirty = true;
  return result;
}
