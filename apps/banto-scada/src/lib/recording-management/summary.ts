import type { StatusBadgeVariant } from "@banto/ui";
import type {
  HostPhase,
  RecordingInspectionResponse,
} from "../recording-management-contract";
import { hostPhaseLabels } from "./labels";

/**
 * The one-line answer to "is it recording now?" drawn from the last
 * inspection (UX review 2026-11-11 P0-1). The DB's active session decides;
 * a Host phase that cannot be recording turns it into "needs a look". It is
 * the state at the inspection time, not a live value: the caller shows that
 * time with it.
 */
export type RecordingSummaryState =
  | "recording"
  | "attention"
  | "stopped"
  | "interrupted"
  | "unconfigured"
  | "unknown";

export interface RecordingSummary {
  readonly state: RecordingSummaryState;
  readonly label: string;
  readonly detail: string;
  readonly variant: StatusBadgeVariant;
}

const recordingHostPhases: ReadonlySet<HostPhase> = new Set([
  "starting",
  "running",
  "retaining",
  "managingPlan",
]);

export function recordingSummary(
  response: RecordingInspectionResponse,
): RecordingSummary {
  const db = response.database;
  if (db.state === "unavailable")
    return {
      state: "unknown",
      label: "記録状態不明",
      detail: "DBを照会できませんでした",
      variant: "warning",
    };
  const host = response.host;
  if (db.activeSessionId !== null) {
    if (host.state === "observed" && !recordingHostPhases.has(host.phase))
      return {
        state: "attention",
        label: "記録要確認",
        detail: `DBは記録中ですが、Hostは「${hostPhaseLabels[host.phase]}」です`,
        variant: "danger",
      };
    return {
      state: "recording",
      label: "記録中",
      detail: `記録セッション ${db.activeSessionId}`,
      variant: "success",
    };
  }
  if (db.latestActivation?.state === "interrupted")
    return {
      state: "interrupted",
      label: "記録中断",
      detail:
        "前回の記録は終了を確認できないまま中断しました。「記録を再開」で再開します",
      variant: "danger",
    };
  if (db.applied === null)
    return {
      state: "unconfigured",
      label: "記録未設定",
      detail: "DBに適用済みの計画はありません",
      variant: "neutral",
    };
  return {
    state: "stopped",
    label: "記録停止中",
    detail: db.applied.desired.enabled
      ? "記録していません。「記録を再開」で再開します"
      : "計画が無効（enabled: false）なので記録していません",
    variant: "warning",
  };
}

/** Local wall-clock time of an inspection, `HH:MM`. */
export function inspectedAtLabel(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
