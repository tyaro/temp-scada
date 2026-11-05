/** Shared Node/Chromium scenarios against the real same-realm local-v2 adapter. */
import raw from "../../../../../examples/recording-wire-local-v2-cases.json";
import { createRecordingWireLocalV2 } from "../recording-wire-local-v2";
import {
  makeDelivery,
  deliveryRequest,
  deliveryReply,
  cloneDelivery as clone,
} from "./recording-wire-delivery-ledger-cases";
import {
  makeReceiver,
  receiverAttachRequest,
  receiverAttachReply,
} from "./recording-wire-receiver-cases";
import { wireFixtures } from "./recording-wire-cases";

export const localV2Cases = raw as {
  scenarios: { name: string; kind: "original" | "observation" | "attach" }[];
};

function take<T>(
  result: { ok: true; value: T } | { ok: false; reason: string },
): T {
  if (!result.ok) throw Error(result.reason);
  return result.value;
}

export async function runLocalV2Scenario(
  scenario: (typeof localV2Cases.scenarios)[number],
) {
  const ledger = makeDelivery(),
    receiver = makeReceiver();
  const local = take(createRecordingWireLocalV2(ledger, receiver));
  if (scenario.kind === "original") {
    const request = deliveryRequest("lease"),
      token = take(ledger.beginOriginal(request));
    const handle = take(local.watchOriginal(token));
    if (!ledger.acceptOriginal(token, deliveryReply(request)).ok)
      throw Error("reply");
    if (take(local.pump()).delivered !== 1) throw Error("pump");
    if ((await handle.completion).kind !== "recordingWireLeaseReply")
      throw Error("completion");
  } else if (scenario.kind === "attach") {
    take(receiver.setConnected(true));
    const request = receiverAttachRequest(),
      token = take(receiver.beginAttach(request));
    const handle = take(local.watchAttach(token));
    if (!receiver.acceptAttach(token, receiverAttachReply(request)).ok)
      throw Error("reply");
    if (take(local.pump()).delivered !== 1) throw Error("pump");
    if ((await handle.completion).kind !== "recordingWireAttachReply")
      throw Error("completion");
  } else {
    const request = clone(wireFixtures.bases.observe);
    const admission = deliveryRequest("admit");
    admission.action = {
      kind: "apply",
      changeRef: "change-ref",
      operation: clone(request.target.request),
    };
    const accepted = {
      version: 1,
      kind: "recordingAdmissionReply",
      request: clone(admission),
      outcome: {
        kind: "accepted",
        handle: {
          kind: "operation",
          changeRef: "change-ref",
          operationRef: request.target.operationRef,
          request: clone(request.target.request),
        },
      },
    };
    const original = take(ledger.beginOriginal(admission));
    if (!ledger.acceptOriginal(original, accepted).ok) throw Error("admission");
    const target = take(ledger.bindObservationTarget(original));
    const pair = take(ledger.beginObservation(target, request));
    const attempt = take(local.watchObservationAttempt(pair.attempt));
    const query = take(local.watchObservationQuery(pair.query));
    const pending = {
      version: 1,
      kind: "recordingWireObservationReply",
      request: clone(request),
      outcome: { kind: "pending" },
    };
    if (!ledger.acceptObservation(pair.attempt, pending).ok)
      throw Error("pending");
    if (take(local.pump()).delivered !== 1) throw Error("pending delivery");
    if ((await attempt.completion).outcome.kind !== "pending")
      throw Error("attempt completion");
    const next = take(ledger.repeatObservation(pair.query));
    const nextAttempt = take(local.watchObservationAttempt(next));
    if (
      !ledger.acceptObservation(
        next,
        clone(wireFixtures.bases.observationReply),
      ).ok
    )
      throw Error("terminal");
    if (take(local.pump()).delivered !== 2) throw Error("terminal delivery");
    if (
      (await nextAttempt.completion).outcome.kind !== "operation" ||
      (await query.completion).outcome.kind !== "operation"
    )
      throw Error("completion");
  }
  return local.current().usage;
}
