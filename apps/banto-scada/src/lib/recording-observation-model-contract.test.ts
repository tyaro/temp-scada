import { it, expect } from "vitest";
import {
  observationModelFixtures as f,
  observationModelDocument,
  observationModelTranscripts,
} from "./__fixtures__/recording-observation-model-cases";
import {
  parseRecordingWireDocument,
  recordingWireReplyMatchesRequest,
} from "./recording-wire-contract";
import { parseRecordingAdmissionDocument } from "./recording-admission-contract";
import { parseRecordingOperationsDocument } from "./recording-operations-contract";
import { ownMeasuredHistoryJson } from "./history/owned-json";
import { WIRE_OPERATION_RESULT_UPPER } from "./recording-wire/capacity";
function parse(v: any) {
  return v.kind.startsWith("recordingWire")
    ? parseRecordingWireDocument(v)
    : v.kind.startsWith("recordingAdmission") ||
        v.kind === "recordingReconciliationDelivery"
      ? parseRecordingAdmissionDocument(v)
      : parseRecordingOperationsDocument(v);
}
for (const row of observationModelTranscripts())
  it("observation model transcript " + row.name, () => {
    const v = row.document,
      p = parse(v);
    expect(p).toEqual(v);
    expect(p).not.toBe(v);
    expect(Object.isFrozen(p)).toBe(true);
    if (v.kind.startsWith("recordingWire"))
      expect(recordingWireReplyMatchesRequest(v, v.request)).toBe(true);
  });
for (const scenario of f.scenarios)
  it("independent completion inputs " + scenario.name, () => {
    for (const step of scenario.steps)
      if (step.input) {
        const v = observationModelDocument(step.input);
        expect(() => parse(v)).not.toThrow();
      }
  });
it("result reservations match the shared conservative budget", () => {
  const bytes = (v: unknown) =>
    ownMeasuredHistoryJson(v, 4 * 1024 * 1024, 196608, "wireInspectionReply")
      .bytes;
  const op =
    bytes(f.bases.opLease) +
    bytes(f.bases.opLeaseReply) +
    bytes(f.bases.opAdmit) +
    2 * 512 * 1024 +
    WIRE_OPERATION_RESULT_UPPER.bytes;
  expect(
    f.scenarios.find(
      (s) => s.name === "completion reservation fits exact mutation budget",
    )!.limits!.total_bytes,
  ).toBe(op);
  const r =
    bytes(f.bases.readLease) +
    bytes(f.bases.readLeaseReply) +
    bytes(f.bases.readAdmit) +
    3 * 512 * 1024;
  expect(
    f.scenarios.find(
      (s) => s.name === "read completion reservation fits exact read budget",
    )!.limits!.read_bytes,
  ).toBe(r);
  const o = bytes(f.bases.observe);
  expect(
    f.scenarios.find(
      (s) => s.name === "observation charges exact retained request only",
    )!.limits!.read_bytes,
  ).toBe(o);
});
