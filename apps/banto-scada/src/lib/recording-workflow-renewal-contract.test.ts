import { it, expect } from "vitest";
import {
  workflowRenewalFixtures as f,
  workflowRenewalDocument,
  workflowRenewalTranscripts,
} from "./__fixtures__/recording-workflow-renewal-cases";
import {
  modelBytes,
  modelLifetimeBytes,
} from "./__fixtures__/recording-model-budget";
import {
  parseRecordingWireDocument,
  parseRecordingWireStateFrame,
  recordingWireReplyMatchesRequest,
} from "./recording-wire-contract";
import { parseRecordingAdmissionDocument } from "./recording-admission-contract";
import { parseRecordingOperationsDocument } from "./recording-operations-contract";
function parse(v: any) {
  return !v.kind
    ? parseRecordingWireStateFrame({
        version: 1,
        kind: "recordingWireStateFrame",
        subscriptionRef: "validation",
        snapshot: v,
      }).snapshot
    : v.kind.startsWith("recordingWire")
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
for (const row of workflowRenewalTranscripts())
  it("workflow model transcript " + row.name, () => {
    const v = row.document,
      p = parse(v);
    expect(p).toEqual(v);
    expect(p).not.toBe(v);
    expect(frozen(p)).toBe(true);
    if (v.kind?.startsWith("recordingWire") && v.kind.endsWith("Reply"))
      expect(recordingWireReplyMatchesRequest(v, v.request)).toBe(true);
  });
for (const s of f.scenarios)
  it("workflow input contracts " + s.name, () => {
    for (const step of s.steps)
      if (step.input)
        expect(() => parse(workflowRenewalDocument(step.input!))).not.toThrow();
  });
it("renewal escrow retains history and adds metadata and four future lifetimes independently", () => {
  function escrow(change: any) {
    const max = "r".repeat(64);
    const parts: Record<string, number> = {};
    for (const kind of ["preflight", "pauseJoin", "apply", "discard"]) {
      const action =
        kind === "preflight"
          ? { kind, change }
          : {
              kind,
              changeRef: max,
              ...(kind === "discard"
                ? { change }
                : {
                    operation: {
                      version: 1,
                      kind: "recordingOperationRequest",
                      operationId: max,
                      stage: kind,
                      change,
                    },
                  }),
            };
      const q = {
        version: 1,
        kind: "recordingAdmissionRequest",
        ownerRef: change.context.ownerRef,
        context: change.context,
        admissionId: max,
        deadlineLeaseRef: max,
        action,
      };
      // The envelope owner belongs to the model scope, independently of target context.
      q.ownerRef = Object.values(f.bases).find(
        (v) => v.kind === "recordingWireLeaseRequest",
      ).scope.ownerRef;
      const scope = Object.values(f.bases).find(
        (v) => v.kind === "recordingWireLeaseRequest",
      ).scope;
      const lease = {
        version: 1,
        kind: "recordingWireLeaseRequest",
        scope,
        leaseRequestId: max,
        admissionId: max,
        role: "mutation",
        requestedBudgetMs: 1,
      };
      const reply = {
        version: 1,
        kind: "recordingWireLeaseReply",
        request: lease,
        outcome: { kind: "issued", deadlineLeaseRef: max, grantedBudgetMs: 1 },
      };
      parts[kind] =
        modelLifetimeBytes(q) + modelBytes(lease) + modelBytes(reply);
    }
    return {
      parts,
      total:
        modelBytes(change) +
        1024 +
        Object.values(parts).reduce((a, b) => a + b, 0),
    };
  }
  const exact = f.scenarios.find(
    (s) =>
      s.name ===
      "exact retained history and next escrow fit the mutation partition",
  )!;
  const smaller = f.scenarios.find(
    (s) => s.name === "one byte below cumulative escrow preserves predecessor",
  )!;
  const first = escrow(workflowRenewalDocument(exact.steps[0].input!));
  const next = escrow(
    workflowRenewalDocument(exact.steps.find((s) => s.op === "renew")!.input!),
  );
  const retained = first.total - first.parts.pauseJoin - first.parts.apply;
  expect(exact.limits!.total_bytes - exact.limits!.read_bytes).toBe(
    retained + next.total,
  );
  expect(smaller.limits!.total_bytes - smaller.limits!.read_bytes).toBe(
    retained + next.total - 1,
  );
});
