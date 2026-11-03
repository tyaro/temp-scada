import type {
  DesiredAppliedComparison,
  HostPhase,
  HostIssue,
  InspectionError,
} from "../recording-management-contract";
import type { RecordingManagementState } from "./controller";
export const inspectionPhaseLabels: Record<
  RecordingManagementState["phase"],
  string
> = {
  offline: "記録管理サービスは未接続です",
  invalidContext: "接続元の対象情報を確認できません",
  contextMismatch: "接続元の対象情報が現在のProjectと一致しません",
  idle: "未照会です。照会ボタンで状態を取得します",
  loading: "管理状態を照会中です",
  ready: "照会結果を受信しました",
  cancelled: "照会を取り消しました",
  timeout: "照会の期限を過ぎました",
  serviceFailure: "管理サービスの照会に失敗しました",
  invalidResponse: "照会応答を確認できません。接続元の確認が必要です",
};
const comparisons: Record<DesiredAppliedComparison["kind"], string> = {
  unavailable: "DB照会が失敗したため比較できません",
  absent: "希望設定・DB適用設定ともにありません",
  localAbsent: "Projectに希望設定はなく、DBには適用済み設定があります",
  notApplied: "希望設定はDBに未適用です",
  differentPlan: "希望設定とDB適用設定の計画IDが異なります",
  sameRevisionConflict: "同じ計画ID・希望設定版で内容が異なります（競合）",
  matches: "希望設定とDB適用設定は一致しています",
  localNewer: "Projectの希望設定版がDBより新しい状態です",
  localOlder: "Projectの希望設定版がDBより古い状態です",
};
export function comparisonLabel(value: DesiredAppliedComparison): string {
  return (
    comparisons[value.kind] +
    ("sameContent" in value
      ? value.sameContent
        ? "（版以外の内容は一致）"
        : "（内容にも差があります）"
      : "")
  );
}
export const hostPhaseLabels: Record<HostPhase, string> = {
  idle: "待機",
  starting: "起動受付後",
  running: "記録worker稼働",
  stopping: "停止処理中",
  finishedUnjoined: "worker終了・join未完了",
  joined: "join完了",
  faulted: "異常",
  noStore: "store未保持",
  retaining: "保持処理中",
  managingPlan: "計画管理処理中",
};
export const hostIssueLabels: Record<HostIssue, string> = {
  none: "報告された障害なし",
  clock: "時計",
  source: "値の取得元",
  store: "保存先",
  invalidObservation: "不正な観測",
  arithmeticOverflow: "演算の範囲超過",
  unclassified: "分類未提供",
};
export const inspectionErrorLabels: Record<InspectionError, string> = {
  unavailable: "取得不能",
  busy: "使用中",
  cancelled: "取消",
  deadlineExceeded: "期限切れ",
  budgetExceeded: "照会上限超過",
  corruptData: "整合性エラー",
  needsReopen: "再openが必要",
  readerUnusable: "reader使用不能",
  projectionFailed: "表示用データへの変換失敗",
  internal: "内部エラー",
};
export const knownFlag = (value: boolean | null) =>
  value === null ? "未提供" : value ? "必要 / あり" : "不要 / なし";
