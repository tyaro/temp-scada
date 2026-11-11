/** 通知の種類。@banto/admin-core の NotificationKind と同じ値。 */
export type ReportKind = "info" | "success" | "warning" | "error";

export interface ReportOptions {
  /** true でトーストを必ず出す。false でステータス行だけにする。 */
  toast?: boolean;
}

/**
 * トーストを出すかを決める。
 * 通常の編集成功（success）と明示の指定がない通知はステータス行だけにし、
 * 失敗・警告・案内（info）と、明示した重要な成功（書き出し・保存など）だけトーストに出す。
 */
export function shouldShowToast(
  kind: ReportKind,
  options?: ReportOptions,
): boolean {
  if (options?.toast !== undefined) return options.toast;
  return kind !== "success";
}
