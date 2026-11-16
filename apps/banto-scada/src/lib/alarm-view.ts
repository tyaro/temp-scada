import type { AlarmConditionState, AlarmSnapshot } from "./alarm-mirror";
import type { AlarmSeverity } from "./alarms";

/**
 * 画面側の警報表示状態の導出（純関数）。仕様: docs/design/graphics/alarm-badge.md、
 * docs/design/runtime/alarm-stage3-design.md §4.1・§7。
 *
 * host の snapshot は display を送らないので、`scada_alarm::ConditionState::display()` と
 * 同じ規則（active・acked・timer.kind == "onDelay"）でここで導く。
 */

/** 不明の理由。Normal に見せず「不明」で示す。 */
export type AlarmUnknownReason =
  /** snapshot がまだ無い（取得前・ブラウザ版で Engine が無い）。 */
  | "noSnapshot"
  /** Engine が動いていない（停止中・未適用など）。 */
  | "notRunning"
  /** Engine 単位の評価不能（未接続・受信の途絶）。 */
  | "engineUnavailable"
  /** 監視中・適用中の Project が編集中の Project と違う。 */
  | "otherProject"
  /** 指す condition が適用中の定義に無い（保存前の新しい定義など）。 */
  | "notApplied";

export type AlarmViewState =
  | "unknown"
  | "normal"
  | "activeUnacked"
  | "activeAcked"
  | "returnedUnacked"
  | "unavailable";

export interface AlarmView {
  state: AlarmViewState;
  /** state が unknown のときの理由。 */
  reason?: AlarmUnknownReason;
  /** 発生中（未確認・確認済み）に condition 単位の評価不能が重なった（「?」の印）。 */
  unavailableMark: boolean;
  /** 適用中の表示情報の severity（high・medium・low）。 */
  severity?: AlarmSeverity;
}

/** §4.1 の表示の状態。`ConditionState::display()` と同じ規則。 */
export type AlarmDisplayState =
  "normal" | "pending" | "activeUnacked" | "activeAcked" | "returnedUnacked";
export function conditionDisplay(
  condition: Pick<AlarmConditionState, "active" | "acked" | "timer">,
): AlarmDisplayState {
  if (condition.active)
    return condition.acked ? "activeAcked" : "activeUnacked";
  if (!condition.acked) return "returnedUnacked";
  return condition.timer?.kind === "onDelay" ? "pending" : "normal";
}

const SEVERITIES: readonly string[] = ["high", "medium", "low"];

/**
 * 小札などが指す condition の表示状態。
 * - Engine が動いていない・Engine 単位の評価不能・別の Project・適用中に無い condition は unknown。
 * - 発生待ち（pending）は Normal と同じに扱う。
 * - Normal（発生待ちを含む）で condition 単位の評価不能なら unavailable。発生中に重なったら
 *   発生中の状態のまま `unavailableMark` を立てる（発生中を隠さない）。
 */
export function alarmConditionView(
  snapshot: AlarmSnapshot | null,
  projectId: string,
  conditionId: string,
): AlarmView {
  const unknown = (reason: AlarmUnknownReason): AlarmView => ({
    state: "unknown",
    reason,
    unavailableMark: false,
  });
  if (!snapshot) return unknown("noSnapshot");
  if (snapshot.status !== "running" || !snapshot.engine)
    return unknown("notRunning");
  if (snapshot.engine.unavailable) return unknown("engineUnavailable");
  if (
    snapshot.monitored?.projectId !== projectId ||
    (snapshot.applied && snapshot.applied.projectId !== projectId)
  )
    return unknown("otherProject");
  const condition = Object.hasOwn(snapshot.engine.conditions, conditionId)
    ? snapshot.engine.conditions[conditionId]
    : undefined;
  if (!condition) return unknown("notApplied");
  const raw = snapshot.applied?.displays[conditionId]?.severity;
  const severity =
    raw !== undefined && SEVERITIES.includes(raw)
      ? (raw as AlarmSeverity)
      : undefined;
  const display = conditionDisplay(condition);
  const unavailable = condition.unavailable !== null;
  if (display === "normal" || display === "pending")
    return {
      state: unavailable ? "unavailable" : "normal",
      unavailableMark: false,
      ...(severity ? { severity } : {}),
    };
  return {
    state: display,
    unavailableMark:
      unavailable && (display === "activeUnacked" || display === "activeAcked"),
    ...(severity ? { severity } : {}),
  };
}

export const ALARM_VIEW_LABELS: Record<AlarmViewState, string> = {
  unknown: "不明",
  normal: "正常",
  activeUnacked: "未確認（発生中）",
  activeAcked: "発生中",
  returnedUnacked: "復帰・未確認",
  unavailable: "評価不能",
};
export const ALARM_UNKNOWN_REASON_LABELS: Record<AlarmUnknownReason, string> = {
  noSnapshot: "警報の状態を受け取っていません",
  notRunning: "警報の Engine が動いていません",
  engineUnavailable: "監視できていません",
  otherProject: "別の Project を監視中です",
  notApplied: "この警報は適用されていません",
};

/** 状態の文字（aria-label・title に使う）。例「未確認（発生中）」「不明（監視できていません）」。 */
export function alarmViewText(view: AlarmView): string {
  const base = ALARM_VIEW_LABELS[view.state];
  if (view.state === "unknown" && view.reason)
    return `${base}（${ALARM_UNKNOWN_REASON_LABELS[view.reason]}）`;
  return view.unavailableMark ? `${base}・評価不能` : base;
}
