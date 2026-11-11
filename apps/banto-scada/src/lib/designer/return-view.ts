import { expandGroupSelection, type GroupOwner } from "../geometric-groups";
import type { Point } from "../project";

/**
 * 編集 → 表示プレビュー → 編集、画面 → Symbol 定義 → 画面 の往復で戻す、画面ごとの編集状態。
 * 選択は Project の変更ではないので Undo 履歴に入れない。
 */
export interface ReturnView {
  selectedIds: string[];
  /** null は全体表示（fit）。このときは表示中心を持たない。 */
  zoom: number | null;
  center: Point | null;
}
export type ReturnViews = Readonly<Record<string, ReturnView>>;

export function rememberReturnView(
  views: ReturnViews,
  screenId: string,
  view: ReturnView,
): ReturnViews {
  return {
    ...views,
    [screenId]: {
      selectedIds: [...view.selectedIds],
      zoom: view.zoom,
      center: view.zoom === null || !view.center ? null : { ...view.center },
    },
  };
}

/**
 * 保存した選択のうち、今も存在する配置だけを返す（削除済みは落とす）。
 * definitionId を渡したとき（Symbol 定義の編集から戻るとき）は、その定義を参照する
 * 配置が選択に含まれていればそれだけを選ぶ（入口になった配置）。グループは丸ごと選ぶ。
 */
export function restoredSelection(
  owner: GroupOwner,
  saved: readonly string[],
  definitionId?: string,
): string[] {
  const existing = owner.objects.filter((object) => saved.includes(object.id));
  const entries = definitionId
    ? existing.filter(
        (object) =>
          object.shape.type === "symbol" &&
          object.shape.symbolId === definitionId,
      )
    : [];
  const ids = (entries.length ? entries : existing).map((object) => object.id);
  return ids.length ? expandGroupSelection(owner, ids) : [];
}
