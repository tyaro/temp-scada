import { it, expect } from "vitest";
import {
  registryModelFixtures as f,
  registryModelDocument,
  registryModelTranscripts,
} from "./__fixtures__/recording-registry-model-cases";
import {
  parseRecordingWireDocument,
  recordingWireReplyMatchesRequest,
} from "./recording-wire-contract";
import { parseRecordingAdmissionDocument } from "./recording-admission-contract";
import { WIRE_OPERATION_RESULT_UPPER } from "./recording-wire/capacity";
import { ownMeasuredHistoryJson } from "./history/owned-json";
for (const row of registryModelTranscripts())
  it("Rust model transcript " + row.name, () => {
    const v = row.document;
    const parsed = v.kind.startsWith("recordingWire")
      ? parseRecordingWireDocument(v)
      : parseRecordingAdmissionDocument(v);
    expect(parsed).toEqual(v);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parsed).not.toBe(v);
    if (v.kind.startsWith("recordingWire"))
      expect(recordingWireReplyMatchesRequest(v, v.request)).toBe(true);
  });
it("all model scenario JSON inputs remain existing independent contracts", () => {
  for (const scenario of f.scenarios)
    for (const step of scenario.steps) {
      if (!step.input) continue;
      const v = registryModelDocument(step.input);
      expect(() =>
        v.kind.startsWith("recordingWire")
          ? parseRecordingWireDocument(v)
          : parseRecordingAdmissionDocument(v),
      ).not.toThrow();
    }
});
it("fixed registry reservation oracle agrees with conservative browser accounting", () => {
  const measure = (v: unknown) =>
    ownMeasuredHistoryJson(v, 4 * 1024 * 1024, 196608, "wireInspectionReply")
      .bytes;
  const cost =
    measure(f.bases.lease) +
    measure(f.bases.issued) +
    measure(f.bases.admit) +
    2 * 512 * 1024 +
    WIRE_OPERATION_RESULT_UPPER.bytes;
  const exact = f.scenarios.find(
    (s) => s.name === "exact retained mutation budget accepts",
  )!;
  expect(exact.limits!.total_bytes).toBe(cost + 1024);
  const read = f.scenarios.find(
    (s) => s.name === "exact read budget holds inspection binding",
  )!;
  expect(read.limits!.read_bytes).toBe(measure(f.bases.call) + 1024);
});
