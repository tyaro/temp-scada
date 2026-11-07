import { describe, expect, it } from "vitest";
import {
  parseRecordingWireDocument,
  recordingWireFrameMatchesSubscription,
  recordingWireReplyMatchesRequest,
} from "./recording-wire-contract";
import {
  parseRecordingAdmissionDocument,
  recordingAdmissionInspectionReplyMatchesRequest,
  recordingAdmissionReplyMatchesRequest,
  recordingReconciliationDeliveryMatchesAdmission,
} from "./recording-admission-contract";
import { nativeWireFixtures as f } from "./__fixtures__/recording-registry-native-wire-cases";

// Rust-generated DTOs from one real-owner workflow (adapter design §7 acceptance 6).
const kindOf = (v: unknown) => (v as { kind: string }).kind;
const isWire = (v: unknown) => kindOf(v).startsWith("recordingWire");
const parse = (v: unknown) =>
  isWire(v)
    ? parseRecordingWireDocument(v)
    : parseRecordingAdmissionDocument(v);
const byName = (name: string) => {
  const row = f.cases.find((c) => c.name === name);
  if (!row) throw Error(`missing case ${name}`);
  return row.value;
};

describe("native registry wire DTOs against the TS validators", () => {
  it("covers every reply, frame and delivery kind the registry returns", () => {
    expect(new Set(f.cases.map((c) => kindOf(c.value)))).toEqual(
      new Set([
        "recordingAdmissionReply",
        "recordingAdmissionInspectionReply",
        "recordingReconciliationDelivery",
        "recordingWireLeaseReply",
        "recordingWireObservationReply",
        "recordingWireCancelReply",
        "recordingWireAttachReply",
        "recordingWireStateFrame",
        "recordingWireControlReply",
        "recordingWireControlFrame",
      ]),
    );
  });
  for (const row of f.cases)
    it(row.name, () => {
      expect(parse(row.value)).toEqual(row.value);
      if (row.request === undefined) return;
      expect(parse(row.request)).toEqual(row.request);
      const kind = kindOf(row.value);
      if (kind === "recordingAdmissionReply")
        expect(
          recordingAdmissionReplyMatchesRequest(row.value, row.request),
        ).toBe(true);
      else if (kind === "recordingAdmissionInspectionReply")
        expect(
          recordingAdmissionInspectionReplyMatchesRequest(
            row.value,
            row.request,
          ),
        ).toBe(true);
      else
        expect(recordingWireReplyMatchesRequest(row.value, row.request)).toBe(
          true,
        );
    });
  it("frames belong to the attached subscription", () => {
    const attach = byName("subscription.attachReply.attached");
    const frames = f.cases.filter((c) =>
      ["recordingWireStateFrame", "recordingWireControlFrame"].includes(
        kindOf(c.value),
      ),
    );
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames)
      expect(recordingWireFrameMatchesSubscription(frame.value, attach)).toBe(
        true,
      );
  });
  it("the delivery matches the accepted reconciliation reply", () => {
    expect(
      recordingReconciliationDeliveryMatchesAdmission(
        byName("read.reconciliationDelivery.receiptFound"),
        byName("read.admissionReply.accepted"),
      ),
    ).toBe(true);
  });
});
