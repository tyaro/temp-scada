import { it, expect } from "vitest";
import {
  subscriptionModelFixtures as f,
  subscriptionModelDocument,
  subscriptionModelTranscripts,
} from "./__fixtures__/recording-subscription-model-cases";
import {
  parseRecordingWireDocument,
  parseRecordingWireStateFrame,
  recordingWireReplyMatchesRequest,
  recordingWireFrameMatchesSubscription,
} from "./recording-wire-contract";
import { parseRecordingAdmissionDocument } from "./recording-admission-contract";
import { parseRecordingOperationsDocument } from "./recording-operations-contract";
import { ownMeasuredHistoryJson } from "./history/owned-json";
function parse(v: any) {
  if (!v.kind)
    return parseRecordingWireStateFrame({
      version: 1,
      kind: "recordingWireStateFrame",
      subscriptionRef: "validation",
      snapshot: v,
    }).snapshot;
  return v.kind.startsWith("recordingWire")
    ? parseRecordingWireDocument(v)
    : v.kind.startsWith("recordingAdmission") ||
        v.kind === "recordingReconciliationDelivery"
      ? parseRecordingAdmissionDocument(v)
      : parseRecordingOperationsDocument(v);
}
function frozen(v: any): boolean {
  return (
    v === null ||
    typeof v !== "object" ||
    (Object.isFrozen(v) && Object.values(v).every(frozen))
  );
}
for (const row of subscriptionModelTranscripts())
  it("subscription model transcript " + row.name, () => {
    const v = row.document,
      p = parse(v);
    expect(p).toEqual(v);
    expect(p).not.toBe(v);
    expect(frozen(p)).toBe(true);
    if (v.kind?.endsWith("Reply") && v.kind.startsWith("recordingWire"))
      expect(recordingWireReplyMatchesRequest(v, v.request)).toBe(true);
  });
for (const scenario of f.scenarios)
  it("subscription input contracts " + scenario.name, () => {
    for (const step of scenario.steps)
      if (step.input)
        expect(() =>
          parse(subscriptionModelDocument(step.input!)),
        ).not.toThrow();
  });
it("frames correlate only with the known attachment reference, scope and revision", () => {
  const attach = f.bases.attachInitial,
    frame = f.bases.framecompleted;
  expect(recordingWireFrameMatchesSubscription(frame, attach)).toBe(true);
  expect(
    recordingWireFrameMatchesSubscription(f.bases.ownerClosedFrame, attach),
  ).toBe(true);
  const changed = structuredClone(frame);
  changed.subscriptionRef = "other";
  expect(recordingWireFrameMatchesSubscription(changed, attach)).toBe(false);
  changed.subscriptionRef = frame.subscriptionRef;
  changed.snapshot.scope.ownerEpoch = "other";
  expect(recordingWireFrameMatchesSubscription(changed, attach)).toBe(false);
  const newerAttach = structuredClone(f.bases.attach2Completed);
  newerAttach.outcome.subscriptionRef = frame.subscriptionRef;
  expect(
    recordingWireFrameMatchesSubscription(f.bases.frameregistered, newerAttach),
  ).toBe(false);
});
it("attach reservation includes original reply and live slot descriptors", () => {
  const bytes = ownMeasuredHistoryJson(
    f.bases.attach,
    256 * 1024,
    8192,
    "wireRequest",
  ).bytes;
  const exact = f.scenarios.find(
    (s) =>
      s.name === "exact read capacity holds attachment without future refill",
  );
  expect(exact).toBeDefined();
  expect(exact!.limits!.read_bytes).toBe(1024 + bytes + 2048);
});
