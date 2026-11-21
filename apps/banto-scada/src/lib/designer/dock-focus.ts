import { isDockRearranging } from "@banto/dock-svelte";

/**
 * blur で確定する欄の共通の口（#331 D2）。`Element.moveBefore` の無い古い WebView2
 * では、dock がパネルを組み替える間（狭い表示への切り替えで帯へ移すときも含む）に
 * 欄から一度 `blur` が出る。そのときは確定しない（dock がフォーカスを戻す。戻らない
 * ときは、次に欄から離れたときに今までどおり確定する）。Tab やクリックで離れた
 * ときは `false` で、今までどおり 1 回確定する。
 */
export function isRearrangingBlur(event: FocusEvent): boolean {
  return isDockRearranging(
    (event.currentTarget ?? event.target) as Node | null,
  );
}
