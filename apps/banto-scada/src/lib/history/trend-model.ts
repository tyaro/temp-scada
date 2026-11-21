/**
 * 履歴の時刻の文字列。UTC の ISO 表記で、JS の Date で表せない値は `<n> ms` にする。
 * 描画は共通部品 `@banto-industrial/trend`（#359）で、H1 の応答からの写しは `trend-adapter.ts`。
 */
export function historyTime(time: number): string {
  const date = new Date(time);
  return Number.isFinite(date.getTime()) ? date.toISOString() : `${time} ms`;
}
