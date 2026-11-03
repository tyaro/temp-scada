// Shared recipe interpretation only, never imported by App or the validator.
import fixtures from "../../../../../examples/recording-management-cases.json";
import {
  recordingPlanCaseInput,
  type RecordingPlanCase,
} from "./recording-plan-cases";
export { fixtures };
export interface ManagementCase {
  readonly name: string;
  readonly base: string;
  readonly accepted?: boolean;
  readonly patch?: readonly {
    readonly path: string;
    readonly value?: unknown;
    readonly remove?: boolean;
  }[];
  readonly json?: string;
  readonly build?: string;
  readonly count?: number;
}
export function managementCaseInput(row: ManagementCase): any {
  if (row.json !== undefined) return JSON.parse(row.json);
  if (row.build) return recordingPlanCaseInput(row as RecordingPlanCase);
  const value = structuredClone(
    (fixtures.bases as Record<string, unknown>)[row.base],
  );
  for (const patch of row.patch ?? []) {
    const parts = patch.path.slice(1).split("/");
    let target: any = value;
    for (const key of parts.slice(0, -1)) target = target[key];
    const key = parts.at(-1)!;
    if (patch.remove) delete target[key];
    else target[key] = structuredClone(patch.value);
  }
  return value;
}
export function nestedPlanResponse(input: unknown): any {
  const response = structuredClone(fixtures.bases.active) as any;
  response.database.latestActivation = null;
  response.database.activeSessionId = null;
  response.database.applied.desired = input;
  const enabled =
    input !== null &&
    typeof input === "object" &&
    (input as any).enabled === true;
  response.database.applied.mappingRevision = enabled ? 2 : null;
  response.database.applied.retentionAppliedRevision = enabled ? 1 : null;
  return response;
}
