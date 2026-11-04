// Fixture recipes only. Never imported by production parsers or App.
import raw from "../../../../../examples/recording-admission-cases.json";
import {
  operationsFixtures,
  operationCaseInput,
} from "./recording-operations-cases";
export interface AdmissionPatch {
  path: string;
  value?: unknown;
  remove?: boolean;
}
export interface AdmissionCase {
  name: string;
  base: string;
  accepted?: boolean;
  patch?: AdmissionPatch[];
  json?: string;
}
export const admissionFixtures: {
  bases: Record<string, any>;
  cases: AdmissionCase[];
  equalities: (AdmissionCase & { expected: boolean })[];
  matches: {
    name: string;
    left: string;
    right: string;
    check: string;
    patch?: AdmissionPatch[];
    expected: boolean;
  }[];
  capacity: {
    base: string;
    maxBytes: number;
    maxNodes: number;
    branches: number;
  }[];
  accounting: {
    name: string;
    input?: unknown;
    build?: string;
    count?: number;
    unit?: string;
    bytes: number;
    nodes: number;
    accepted: boolean;
  }[];
} = raw;
export function admissionCaseInput(row: AdmissionCase): any {
  if (row.json !== undefined) return JSON.parse(row.json);
  return patched(admissionFixtures.bases[row.base], row.patch);
}
export function patched(value: unknown, patches?: AdmissionPatch[]): any {
  const result = structuredClone(value);
  for (const patch of patches ?? []) {
    const parts = patch.path.slice(1).split("/");
    let target: any = result;
    for (const key of parts.slice(0, -1)) target = target[key];
    const key = parts.at(-1)!;
    if (patch.remove) delete target[key];
    else target[key] = structuredClone(patch.value);
  }
  return result;
}
export function accountingInput(
  row: (typeof admissionFixtures.accounting)[number],
): unknown {
  if (row.build === "string") return (row.unit ?? "x").repeat(row.count!);
  if (row.build === "array")
    return Array.from({ length: row.count! }, () => null);
  if (row.build === "depth") {
    let value: unknown = null;
    for (let i = 0; i < row.count!; i++) value = [value];
    return value;
  }
  return structuredClone(row.input);
}
export function nestedAdmissionPlan(desired: any): any {
  const value = admissionCaseInput({ name: "nested", base: "discard" }),
    apply = value.action.change.apply;
  apply.desired = desired;
  apply.expectedMappingRevision = desired?.enabled === true ? 11 : null;
  apply.expectedRetentionAppliedRevision =
    desired?.enabled === true ? 13 : null;
  return value;
}
export function nestedAdmissionTarget(target: unknown): any {
  const value = admissionCaseInput({ name: "target", base: "discard" });
  value.context.target = target;
  value.action.change.context.target = target;
  return value;
}
export const legacyAdmissionCases = operationsFixtures.cases.filter((row) =>
  [
    "context",
    "change",
    "operation",
    "reconciliation",
    "reconciliationResult",
  ].includes(row.base ?? ""),
);
export function nestedAdmissionOperation(
  row: (typeof legacyAdmissionCases)[number],
): any {
  const input = operationCaseInput(row),
    base = row.base;
  const request = admissionCaseInput({ name: "legacy", base: "discard" });
  if (base === "context") {
    request.context = input;
    request.action.change.context = input;
    return request;
  }
  if (base === "change") {
    request.action.change = input;
    request.context = input?.context;
    return request;
  }
  if (base === "reconciliationResult") {
    const value = admissionCaseInput({ name: "legacy", base: "delivery" });
    value.request = input?.request;
    value.outcome.result = input;
    return value;
  }
  if (base === "reconciliation") {
    request.context = input?.operation?.change?.context;
    request.action = {
      kind: "reconcile",
      changeRef: "change-ref",
      operationRef: "operation-ref",
      reconciliation: input,
    };
    return request;
  }
  const reply = admissionCaseInput({ name: "legacy", base: "preflightReply" });
  if (input?.stage === "preflight") reply.request.action.change = input.change;
  else
    reply.request.action = {
      kind: input?.stage,
      changeRef: "change-ref",
      operation: input,
    };
  reply.request.context = input?.change?.context;
  reply.outcome.handle.request = input;
  return reply;
}
