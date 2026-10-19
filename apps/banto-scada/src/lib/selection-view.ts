import { getBounds, type Point, type ScreenObject } from "./project";
import { viewFromCenter, type Size } from "./viewport";
export const SELECTION_VIEW_PADDING = 32;
export interface SelectionBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface SelectionTarget {
  bounds: SelectionBounds | null;
  reason: string;
  clippedCount: number;
  outsideCount: number;
}
/** Intersect each placement first; disjoint off-sheet placements never create a false target. */
export function selectionTarget(
  owner: Size & { objects: ScreenObject[] },
  ids: string[],
): SelectionTarget {
  const unavailable = (reason: string): SelectionTarget => ({
    bounds: null,
    reason,
    clippedCount: 0,
    outsideCount: 0,
  });
  if (!ids.length) return unavailable("図形を選択してください");
  const unique = new Set(ids),
    objects = owner.objects.filter((object) => unique.has(object.id));
  if (unique.size !== ids.length || objects.length !== unique.size)
    return unavailable("選択した図形が見つかりません");
  if (objects.some((object) => object.visible === false))
    return unavailable("非表示の配置を含むため表示できません");
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity,
    clippedCount = 0,
    outsideCount = 0;
  for (const object of objects) {
    const b = getBounds(object),
      x = object.x + b.x,
      y = object.y + b.y,
      r = x + b.width,
      d = y + b.height;
    const l = Math.max(0, x),
      t = Math.max(0, y),
      rr = Math.min(owner.width, r),
      dd = Math.min(owner.height, d);
    if (rr <= l || dd <= t) {
      outsideCount++;
      continue;
    }
    if (l !== x || t !== y || rr !== r || dd !== d) clippedCount++;
    left = Math.min(left, l);
    top = Math.min(top, t);
    right = Math.max(right, rr);
    bottom = Math.max(bottom, dd);
  }
  if (!Number.isFinite(left))
    return unavailable("選択した配置はすべて画面外です");
  return {
    bounds: { x: left, y: top, width: right - left, height: bottom - top },
    reason: "",
    clippedCount,
    outsideCount,
  };
}
/** One-shot manual zoom; limits take precedence when the selection cannot fit at 25%. */
export function selectionView(
  owner: Size,
  viewport: Size,
  bounds: SelectionBounds,
) {
  if (
    ![
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      viewport.width,
      viewport.height,
      owner.width,
      owner.height,
    ].every(Number.isFinite) ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    owner.width <= 0 ||
    owner.height <= 0
  )
    throw new Error("選択範囲と表示領域を計算できません");
  const zoom = Math.max(
    0.25,
    Math.min(
      4,
      Math.max(1, viewport.width - 2 * SELECTION_VIEW_PADDING) / bounds.width,
      Math.max(1, viewport.height - 2 * SELECTION_VIEW_PADDING) / bounds.height,
    ),
  );
  const center: Point = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
  const state = viewFromCenter(owner, viewport, zoom, center, true);
  if (
    ![state.left, state.top, owner.width * zoom, owner.height * zoom].every(
      Number.isFinite,
    )
  )
    throw new Error("選択範囲を表示できる倍率を計算できません");
  return state;
}
