import type { Point } from "./project";
export interface Size {
  width: number;
  height: number;
}
export interface ViewState {
  zoom: number | null;
  left: number;
  top: number;
}
export const zoomLevels = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4] as const;
export const VIEW_PADDING = 24;
function positiveSize(size: Size) {
  if (![size.width, size.height].every((v) => Number.isFinite(v) && v > 0))
    throw new Error("表示領域と画面サイズは正の有限数にしてください");
}
export function fitZoom(screen: Size, viewport: Size): number {
  positiveSize(screen);
  positiveSize(viewport);
  return Math.min(
    4,
    Math.max(1, viewport.width - VIEW_PADDING * 2) / screen.width,
    Math.max(1, viewport.height - VIEW_PADDING * 2) / screen.height,
  );
}
export function viewLayout(screen: Size, viewport: Size, zoom: number) {
  positiveSize(screen);
  positiveSize(viewport);
  if (!Number.isFinite(zoom) || zoom <= 0)
    throw new Error("倍率は正の有限数にしてください");
  const width = screen.width * zoom,
    height = screen.height * zoom;
  const worldWidth = Math.max(viewport.width, width + VIEW_PADDING * 2),
    worldHeight = Math.max(viewport.height, height + VIEW_PADDING * 2);
  return {
    width,
    height,
    worldWidth,
    worldHeight,
    x: (worldWidth - width) / 2,
    y: (worldHeight - height) / 2,
  };
}
/** 同じ design 座標を倍率変更前後の anchor に保つ。端ではスクロール領域へ制限する。 */
export function zoomAt(
  screen: Size,
  viewport: Size,
  before: number,
  after: number,
  scroll: Point,
  anchor: Point,
): ViewState {
  const old = viewLayout(screen, viewport, before),
    next = viewLayout(screen, viewport, after);
  const design = {
    x: (scroll.x + anchor.x - old.x) / before,
    y: (scroll.y + anchor.y - old.y) / before,
  };
  return {
    zoom: after,
    left: Math.max(
      0,
      Math.min(
        next.worldWidth - viewport.width,
        design.x * after + next.x - anchor.x,
      ),
    ),
    top: Math.max(
      0,
      Math.min(
        next.worldHeight - viewport.height,
        design.y * after + next.y - anchor.y,
      ),
    ),
  };
}
