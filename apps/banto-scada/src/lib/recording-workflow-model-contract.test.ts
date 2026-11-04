import { it, expect } from "vitest";
import {
  workflowModelFixtures as f,
  workflowModelDocument,
  workflowModelTranscripts,
} from "./__fixtures__/recording-workflow-model-cases";
import {
  modelBytes,
  modelLifetimeBytes,
} from "./__fixtures__/recording-model-budget";
import {
  parseRecordingWireDocument,
  recordingWireReplyMatchesRequest,
} from "./recording-wire-contract";
import { parseRecordingAdmissionDocument } from "./recording-admission-contract";
import { parseRecordingOperationsDocument } from "./recording-operations-contract";
function parse(v: any) {
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
for (const row of workflowModelTranscripts())
  it("workflow model transcript " + row.name, () => {
    const v = row.document,
      p = parse(v);
    expect(p).toEqual(v);
    expect(p).not.toBe(v);
    expect(frozen(p)).toBe(true);
    if (v.kind.startsWith("recordingWire"))
      expect(recordingWireReplyMatchesRequest(v, v.request)).toBe(true);
  });
for (const s of f.scenarios)
  it("workflow input contracts " + s.name, () => {
    for (const step of s.steps)
      if (step.input)
        expect(() => parse(workflowModelDocument(step.input!))).not.toThrow();
  });
it("whole workflow escrow accounts independently for all four retained records and leases", () => {
  const max = "r".repeat(64);
  let total = modelBytes(f.bases.change) + 1024;
  for (const k of ["p", "s", "a", "d"]) {
    const q = structuredClone(f.bases[k + "Admit"]);
    q.admissionId = max;
    q.deadlineLeaseRef = max;
    if (k !== "p") q.action.changeRef = max;
    if (k === "s" || k === "a") q.action.operation.operationId = max;
    const lease = {
      ...structuredClone(f.bases.pLease),
      admissionId: max,
      leaseRequestId: max,
    };
    const reply = {
      version: 1,
      kind: "recordingWireLeaseReply",
      request: lease,
      outcome: { kind: "issued", deadlineLeaseRef: max, grantedBudgetMs: 1 },
    };
    total += modelLifetimeBytes(q) + modelBytes(lease) + modelBytes(reply);
  }
  const exact = f.scenarios.find(
    (s) =>
      s.name ===
      "exact whole workflow retained budget survives all reserved stages",
  )!.limits!;
  const smaller = f.scenarios.find(
    (s) => s.name === "one byte below whole workflow reservation is atomic",
  )!.limits!;
  expect(exact.total_bytes - exact.read_bytes).toBe(total);
  expect(smaller.total_bytes - smaller.read_bytes).toBe(total - 1);
  expect(total).toBeLessThan(6 * 1024 * 1024);
});
