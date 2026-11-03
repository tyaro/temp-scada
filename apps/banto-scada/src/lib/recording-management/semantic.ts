import type { DatabaseView } from "./types";

/** Only call after schema validation. Host and SDK were observed separately. */
export function databaseConsistent(db: DatabaseView): boolean {
  if (db.state === "unavailable") return true;
  const {
    applied,
    latestActivation: activation,
    retentionFence: fence,
    snapshotCommit: snapshot,
  } = db;
  if (db.activeSessionId !== null && db.activeRetentionJobId !== null)
    return false;
  if (
    (fence.cutoffMs === null
      ? fence.commitVersion !== 0
      : fence.commitVersion < 1) ||
    fence.commitVersion > snapshot
  )
    return false;
  if (
    snapshot === 0 &&
    [
      db.currentMappingRevision,
      db.currentRetentionAppliedRevision,
      applied,
      activation,
      db.activeSessionId,
      db.activeRetentionJobId,
    ].some((v) => v !== null)
  )
    return false;
  if (applied) {
    if (applied.commitVersion > snapshot) return false;
    for (const [bound, current] of [
      [applied.mappingRevision, db.currentMappingRevision],
      [applied.retentionAppliedRevision, db.currentRetentionAppliedRevision],
    ]) {
      if (
        applied.desired.enabled !== (bound !== null) ||
        (bound !== null && (current === null || bound > current))
      )
        return false;
    }
  }
  if (activation) {
    if (
      !applied ||
      activation.appliedRevision > applied.appliedRevision ||
      activation.commitVersion > snapshot
    )
      return false;
    const end = activation.endCommitVersion;
    if (activation.state === "active" ? end !== null : end === null)
      return false;
    if (end !== null && (end <= activation.commitVersion || end > snapshot))
      return false;
    if (activation.appliedRevision === applied.appliedRevision) {
      if (
        !applied.desired.enabled ||
        activation.commitVersion <= applied.commitVersion
      )
        return false;
    } else if (end === null || end >= applied.commitVersion) return false;
    if (
      activation.state === "active" &&
      (activation.appliedRevision !== applied.appliedRevision ||
        activation.sessionId !== db.activeSessionId)
    )
      return false;
  }
  if (
    applied &&
    db.activeSessionId !== null &&
    (activation?.state !== "active" ||
      activation.sessionId !== db.activeSessionId)
  )
    return false;
  return true;
}
