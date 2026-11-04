// Test/browser recipes only. Production never imports fixtures.
import raw from "../../../../../examples/recording-wire-cases.json";
import { patched, type AdmissionCase } from "./recording-admission-cases";
export { patched };
export const wireFixtures = raw as {
  bases: Record<string, any>;
  cases: AdmissionCase[];
  equalities: (AdmissionCase & { expected: boolean })[];
  matches: {
    name: string;
    left: string;
    right: string;
    check: string;
    patch?: AdmissionCase["patch"];
    expected: boolean;
  }[];
  capacity: {
    base: string;
    reply: { bytes: number; nodes: number; depth: number };
    callInspection: { bytes: number; nodes: number; depth: number } | null;
  }[];
  accounting: {
    name: string;
    input?: unknown;
    build?: string;
    count?: number;
    bytes: number;
    nodes: number;
    depth: number;
    profile: any;
    accepted: boolean;
  }[];
};
export function wireCaseInput(row: AdmissionCase): any {
  return row.json === undefined
    ? patched(wireFixtures.bases[row.base], row.patch)
    : JSON.parse(row.json);
}
export function wireAccountingInput(
  row: (typeof wireFixtures.accounting)[number],
): unknown {
  let value: unknown = structuredClone(row.input);
  if (row.build === "string") return "x".repeat(row.count!);
  if (row.build === "array") return Array(row.count!).fill(null);
  if (row.build === "depth") {
    value = null;
    for (let i = 0; i < row.count!; i++) value = [value];
  }
  return value;
}
/** Preserve the old root unchanged, add only a matching scope and closed envelope. */
export function wrapAdmission(v: any): any {
  let q = v?.kind?.endsWith("Reply") ? v.request : v;
  const original =
    q?.kind === "recordingAdmissionInspectionRequest" ? q.original : q;
  const scope = {
    ownerRef: original?.ownerRef ?? "owner",
    ownerEpoch: "epoch:1",
    context: original?.context ?? wireFixtures.bases.lease.scope.context,
  };
  if (v?.kind === "recordingReconciliationDelivery") {
    scope.ownerRef = v.ownerRef;
    scope.context = v.request?.operation?.change?.context ?? scope.context;
    const request = {
      version: 1,
      kind: "recordingWireObservationRequest",
      scope,
      observationId: "nested",
      target: {
        kind: "reconciliation",
        readRef: v.readRef,
        request: v.request,
      },
    };
    return {
      version: 1,
      kind: "recordingWireObservationReply",
      request,
      outcome: { kind: "reconciliation", delivery: v },
    };
  }
  const request = {
    version: 1,
    kind: "recordingWireCallInspectionRequest",
    scope,
    callInspectionId: "nested",
    original: q,
  };
  return v?.kind?.endsWith("Reply")
    ? {
        version: 1,
        kind: "recordingWireCallInspectionReply",
        request,
        outcome: { kind: "terminal", reply: v },
      }
    : request;
}
