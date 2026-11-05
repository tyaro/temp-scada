/** Same module is exercised in Node and Chromium; no product transport is started. */
import raw from "../../../../../examples/recording-wire-coordinator-v2-cases.json";
import {
  createRecordingWireCoordinatorV2,
  createTestTransportPortV2,
} from "../recording-wire-coordinator-v2";
import { createRecordingWireLocalV2 } from "../recording-wire-local-v2";
import {
  makeDelivery,
  deliveryFixtures,
  deliveryRequest,
  deliveryReply,
} from "./recording-wire-delivery-ledger-cases";
import { makeReceiver } from "./recording-wire-receiver-cases";

export const coordinatorV2Cases = raw as {
  scenarios: {
    name: string;
    kind: "replyFirst" | "transportFirst" | "endedBeforeStart";
  }[];
};
function take<T>(r: { ok: true; value: T } | { ok: false; reason: string }): T {
  if (!r.ok) throw Error(r.reason);
  return r.value;
}
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
export async function runCoordinatorV2Scenario(
  scenario: (typeof coordinatorV2Cases.scenarios)[number],
) {
  const ledger = makeDelivery(),
    receiver = makeReceiver();
  const local = take(createRecordingWireLocalV2(ledger, receiver));
  const port = take(createTestTransportPortV2(deliveryFixtures.scope));
  const root = take(
    createRecordingWireCoordinatorV2(ledger, receiver, local, port),
  );
  const request = deliveryRequest("lease"),
    token = take(ledger.beginOriginal(request));
  const track = take(root.track("original", token));
  const ticket = take(port.issue("original", track.request));
  const attempt = take(root.reserveAttempt(track, ticket));
  if (scenario.kind === "endedBeforeStart") {
    take(port.finish(ticket, "returned"));
    if (root.markStarted(attempt).ok) throw Error("ended ticket started");
    await flush();
    if (root.current().tracks[0].attempt?.status !== "reserved")
      throw Error("ticket state");
    return root.current().usage;
  }
  take(root.markStarted(attempt));
  if (scenario.kind === "replyFirst") {
    if (!ledger.acceptOriginal(token, deliveryReply(request)).ok)
      throw Error("reply");
    take(root.pump());
    await flush();
    if (
      root.current().tracks[0].delivery !== "delivered" ||
      root.current().tracks[0].attempt?.status !== "inFlight"
    )
      throw Error("reply confused with task end");
    take(port.finish(ticket, "returned"));
  } else {
    take(port.finish(ticket, "rejected"));
    await flush();
    if (
      root.current().tracks[0].delivery !== "pending" ||
      root.current().tracks[0].attempt?.status !== "rejected"
    )
      throw Error("task end confused with reply");
    if (!ledger.acceptOriginal(token, deliveryReply(request)).ok)
      throw Error("reply");
    take(root.pump());
  }
  await flush();
  const final = root.current().tracks[0];
  if (
    final.delivery !== "delivered" ||
    final.reply !== take(ledger.original(token)).terminal
  )
    throw Error("stored reply");
  if (
    final.attempt?.status !==
    (scenario.kind === "replyFirst" ? "returned" : "rejected")
  )
    throw Error("task terminal");
  return root.current().usage;
}
