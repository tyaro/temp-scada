import type { AlarmSnapshot } from "../alarm-mirror";
import { ALARM_STATUS_LABELS, labelOf } from "../alarm-banner";

/**
 * 上端（Editor のステータス・Runtime の上端）に出す警報の状態の文。
 * `unavailable` は適用で host が返した理由、`readError` は snapshot を取れなかった理由、
 * `subscribeError` は変化の購読を張れなかった理由（張り直せるまで残す）。
 * `resyncing` は購読を張った（張り直した）後、その後に取り始めた snapshot をまだ受け取っていない間。
 * 購読していない間の警報は変化として届き直さないので、それまでの表示は古いかもしれない。
 */
export function alarmStatusLabel(
  snapshot: AlarmSnapshot | null,
  readError: string | null,
  unavailableReason: string | null,
  projectId: string,
  subscribeError: string | null = null,
  resyncing = false,
): string {
  const unavailable = unavailableReason ?? readError ?? subscribeError;
  if (unavailable && snapshot?.status !== "running") {
    if (unavailable === "terminalUnavailable")
      return "警報: この端末ではEngineを利用できません";
    if (unavailable === "noDataDir") return "警報: 保存先がなく監視できません";
    if (unavailable === "auth_phase_unavailable")
      return "警報: 認証切替中で適用できません";
  }
  if (readError) return "警報: 状態を取得できません";
  // A snapshot alone goes stale: new alarms only arrive via the subscription.
  if (subscribeError) return "警報: 変化を受け取れません";
  if (!snapshot) return "警報: 確認中";
  // Subscribed again, but the shown snapshot predates it: missed alarms are not redelivered.
  if (resyncing) return "警報: 再同期中";
  if (snapshot.status !== "running")
    return `警報: ${labelOf(ALARM_STATUS_LABELS, snapshot.status)}`;
  // Not monitoring outranks the history outage; both are shown together.
  const history = snapshot.historyWriteFailure
    ? `履歴に書けません（未記録 ${snapshot.historyWriteFailure.unrecordedEvents} 件）`
    : null;
  if (snapshot.engine?.unavailable)
    return history
      ? `警報: 監視できていません・${history}`
      : "警報: 監視できていません";
  // Evaluation continues while rereads fail, until the streak's limit.
  const reread = snapshot.rereadFailure
    ? `値の読み直しに失敗（${snapshot.rereadFailure.failures} 回）`
    : null;
  const warnings = [history, reread].filter(Boolean).join("・");
  if (warnings) return `警報: ${warnings}`;
  if (snapshot.monitored?.projectId !== projectId)
    return "警報: 別のProjectを監視中";
  if (snapshot.pendingUnknown) return "警報: 保存済みファイルを確認できません";
  if (snapshot.pendingConditionChanges)
    return "警報: 保存済み定義に未適用の変更あり";
  if (snapshot.pendingDisplayChanges) return "警報: 表示情報に未適用の変更あり";
  return "警報: 監視中";
}

/** 監視中で、知らせることが何も無い（上端の表示を通常の色にする）。 */
export function alarmHealthy(
  snapshot: AlarmSnapshot | null,
  projectId: string,
  subscribeError: string | null = null,
  resyncing = false,
): boolean {
  return (
    !subscribeError &&
    !resyncing &&
    snapshot?.status === "running" &&
    snapshot.monitored?.projectId === projectId &&
    !snapshot.engine?.unavailable &&
    !snapshot.historyWriteFailure &&
    !snapshot.rereadFailure &&
    !snapshot.pendingConditionChanges &&
    !snapshot.pendingDisplayChanges &&
    !snapshot.pendingUnknown
  );
}
