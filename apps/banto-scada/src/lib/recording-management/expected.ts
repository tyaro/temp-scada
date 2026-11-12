import type {
  RecordingInspectionResponse,
  RecordingManagementContext,
} from "../recording-management-contract";

/**
 * The revisions a new recording change expects, as read by the last
 * inspection (UX review 2026-11-11 P1-7). The operations dialog fills its
 * expected-revision fields from this instead of having them copied by hand.
 * It is the DB state at the inspection time, not a proof: a change made since
 * then is refused by the store as a conflict, and the fields stay editable.
 */
export interface ExpectedRevisions {
  readonly target: RecordingManagementContext;
  readonly applied: number | null;
  readonly mapping: number | null;
  readonly retention: number | null;
  /** Local time (ms) the inspection arrived. */
  readonly inspectedAt: number;
}

/** Undefined when the inspection could not read the DB. */
export function expectedRevisionsFrom(
  response: RecordingInspectionResponse,
  inspectedAt: number,
): ExpectedRevisions | undefined {
  const db = response.database;
  if (db.state !== "available") return undefined;
  return {
    target: response.request.context,
    applied: db.applied?.appliedRevision ?? null,
    mapping: db.currentMappingRevision,
    retention: db.currentRetentionAppliedRevision,
    inspectedAt,
  };
}

/** The same Project revision, deployment, store and historian namespace. */
export function sameRecordingTarget(
  a: RecordingManagementContext,
  b: RecordingManagementContext,
): boolean {
  return (
    a.projectId === b.projectId &&
    a.projectRevision === b.projectRevision &&
    a.deploymentId === b.deploymentId &&
    a.storeId === b.storeId &&
    a.historianNamespace === b.historianNamespace
  );
}

/** The expected revisions for this target, or undefined if read for another. */
export function expectedRevisionsFor(
  expected: ExpectedRevisions | undefined,
  target: RecordingManagementContext | undefined,
): ExpectedRevisions | undefined {
  return expected && target && sameRecordingTarget(expected.target, target)
    ? expected
    : undefined;
}

/** The field text for a revision: an empty field means "no revision". */
export function revisionText(value: number | null): string {
  return value === null ? "" : String(value);
}
