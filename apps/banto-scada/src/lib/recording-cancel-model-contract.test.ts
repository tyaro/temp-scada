import { it, expect } from "vitest";
import {
  cancelModelFixtures as f,
  cancelModelDocument,
  cancelModelTranscripts,
} from "./__fixtures__/recording-cancel-model-cases";
import {
  parseRecordingWireDocument,
  recordingWireReplyMatchesRequest,
  recordingWireReplyCapacity,
} from "./recording-wire-contract";
import { parseRecordingAdmissionDocument } from "./recording-admission-contract";
import { parseRecordingOperationsDocument } from "./recording-operations-contract";
import { ownMeasuredHistoryJson } from "./history/owned-json";
function parse(v: any) {
  return v.kind.startsWith("recordingWire")
    ? parseRecordingWireDocument(v)
    : v.kind.startsWith("recordingAdmission") ||
        v.kind === "recordingReconciliationDelivery"
      ? parseRecordingAdmissionDocument(v)
      : parseRecordingOperationsDocument(v);
}
for (const row of cancelModelTranscripts())
  it("cancel model transcript " + row.name, () => {
    const v = row.document,
      p = parse(v);
    expect(p).toEqual(v);
    expect(p).not.toBe(v);
    expect(Object.isFrozen(p)).toBe(true);
    if (v.kind.startsWith("recordingWire"))
      expect(recordingWireReplyMatchesRequest(v, v.request)).toBe(true);
  });
for (const scenario of f.scenarios)
  it("cancel inputs keep independent contracts " + scenario.name, () => {
    for (const step of scenario.steps)
      if (step.input) {
        const v = cancelModelDocument(step.input);
        expect(() => parse(v)).not.toThrow();
      }
  });
it("cancel reservation accounts for echo and maximum reply before notification", () => {
  const measured = ownMeasuredHistoryJson(
    f.bases.cancel,
    256 * 1024,
    8192,
    "wireRequest",
  ).bytes;
  const cost =
    measured + recordingWireReplyCapacity(f.bases.cancel).reply.bytes;
  const exact = f.scenarios.find(
    (s) => s.name === "exact reserved cancel bytes retain rejected outcome",
  )!;
  expect(exact.limits!.read_bytes).toBe(cost);
  const smaller = f.scenarios.find(
    (s) => s.name === "one byte below cancel reservation is atomic",
  )!;
  expect(smaller.limits!.read_bytes).toBe(cost - 1);
});
