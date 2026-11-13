import type { LineArrow, Point } from "./project";

export const lineArrows = ["none", "start", "end", "both"] as const;
export const lineArrowLabels: Record<LineArrow, string> = {
  none: "なし",
  start: "始点",
  end: "終点",
  both: "両端",
};

export function parseLineArrow(value: unknown): LineArrow {
  if (!lineArrows.includes(value as LineArrow))
    throw new Error(
      "矢印はなし・始点・終点・両端のいずれかで指定してください。",
    );
  return value as LineArrow;
}

export function arrowAtStart(arrow: LineArrow) {
  return arrow === "start" || arrow === "both";
}
export function arrowAtEnd(arrow: LineArrow) {
  return arrow === "end" || arrow === "both";
}

/** 矢印の大きさ。boundsの余白にも使う。 */
export function arrowSize(strokeWidth: number) {
  return Math.max(8, strokeWidth * 3);
}

/**
 * 端点 `tip` に先端を置き、`points` を `tip` から順にたどって最初に重ならない頂点の
 * 向きへ開く三角形の頂点列。全頂点が重なる（ドラッグ途中など）ときは空文字。
 */
function head(tip: Point, toward: Point[], size: number): string {
  const before = toward.find((p) => p.x !== tip.x || p.y !== tip.y);
  if (!before) return "";
  const length = Math.hypot(tip.x - before.x, tip.y - before.y);
  const ux = (tip.x - before.x) / length,
    uy = (tip.y - before.y) / length;
  return `${tip.x},${tip.y} ${tip.x - ux * size - (uy * size) / 2},${tip.y - uy * size + (ux * size) / 2} ${tip.x - ux * size + (uy * size) / 2},${tip.y - uy * size - (ux * size) / 2}`;
}

/** 描く矢印の polygon の points 属性の列（始点・終点の順、描かない端は含めない）。 */
export function arrowHeads(shape: {
  points: Point[];
  strokeWidth: number;
  arrow: LineArrow;
}): string[] {
  const size = arrowSize(shape.strokeWidth),
    points = shape.points,
    heads: string[] = [];
  if (points.length === 0) return heads;
  if (arrowAtStart(shape.arrow)) heads.push(head(points[0], points, size));
  if (arrowAtEnd(shape.arrow))
    heads.push(head(points.at(-1)!, [...points].reverse(), size));
  return heads.filter((h) => h !== "");
}
