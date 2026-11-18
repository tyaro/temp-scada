import type { Point } from "./project";

/** 多角形の配置（枠と割合の頂点）。`ScreenObject` の polygon に当たる部分だけを取る。 */
export interface PolygonPlacement {
  width: number;
  height: number;
  shape: { type: "polygon"; points: readonly Point[] };
}

/** SVG の `stroke-miterlimit` の既定。描画もこの値で行う。 */
export const POLYGON_MITER_LIMIT = 4;

/**
 * 実寸の頂点（配置の枠の左上を原点とする座標）。頂点 (u, v) を (u × width, v × height)
 * へ直す。幾何の関数（外形・当たり判定・描画）へは割合の点を渡さず、必ずこれを通す。
 */
export function polygonLocalPoints(object: PolygonPlacement): Point[] {
  return object.shape.points.map((p) => ({
    x: p.x * object.width,
    y: p.y * object.height,
  }));
}

/** SVG の `points` 属性の文字列。 */
export function polygonPointsAttribute(points: readonly Point[]): string {
  return points.map((p) => `${p.x},${p.y}`).join(" ");
}

/**
 * 枠線を含めた描画の外形（配置の中の座標の外接矩形）。各辺を法線方向に ±線幅/2 ずらした
 * 長方形と、miter の比 1/sin(θ/2) が limit 以下の角の先端の和をとる。limit を超える角は
 * SVG が bevel に切り替えるので、辺の長方形に含まれる。線幅が 0 以下なら頂点の外接矩形。
 */
export function polygonStrokeBounds(
  points: readonly Point[],
  strokeWidth: number,
  miterLimit = POLYGON_MITER_LIMIT,
): { x: number; y: number; width: number; height: number } {
  const xs: number[] = [],
    ys: number[] = [];
  const add = (x: number, y: number) => {
    xs.push(x);
    ys.push(y);
  };
  for (const p of points) add(p.x, p.y);
  const half = strokeWidth / 2;
  const n = points.length;
  if (half > 0 && n >= 2) {
    for (let i = 0; i < n; i++) {
      const a = points[i],
        b = points[(i + 1) % n];
      const dx = b.x - a.x,
        dy = b.y - a.y,
        length = Math.hypot(dx, dy);
      if (length === 0) continue;
      const nx = (-dy / length) * half,
        ny = (dx / length) * half;
      add(a.x + nx, a.y + ny);
      add(a.x - nx, a.y - ny);
      add(b.x + nx, b.y + ny);
      add(b.x - nx, b.y - ny);
    }
    for (let i = 0; i < n; i++) {
      const p = points[i],
        prev = points[(i + n - 1) % n],
        next = points[(i + 1) % n];
      const la = Math.hypot(prev.x - p.x, prev.y - p.y),
        lb = Math.hypot(next.x - p.x, next.y - p.y);
      if (la === 0 || lb === 0) continue;
      // 頂点から隣の点へ向かう単位ベクトル。sin(θ/2) = |a − b| / 2。
      const ax = (prev.x - p.x) / la,
        ay = (prev.y - p.y) / la,
        bx = (next.x - p.x) / lb,
        by = (next.y - p.y) / lb;
      const sinHalf = Math.hypot(ax - bx, ay - by) / 2;
      if (sinHalf === 0 || 1 / sinHalf > miterLimit) continue;
      // 内側の二等分線 a + b の逆向きに、半幅 / sin(θ/2) だけ離れた点が先端。
      const sx = ax + bx,
        sy = ay + by,
        s = Math.hypot(sx, sy);
      if (s === 0) continue; // 180° の頂点。辺の長方形が法線方向の張り出しを含む。
      const tip = half / sinHalf;
      add(p.x - (sx / s) * tip, p.y - (sy / s) * tip);
    }
  }
  const minX = Math.min(...xs),
    minY = Math.min(...ys),
    maxX = Math.max(...xs),
    maxY = Math.max(...ys);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * 当たり判定の透明な線の幅。Polyline と同じ `max(12, 線幅 + 8)` で、塗りも枠線もない形・
 * 面積 0 の形・細い三角形も輪郭の近くでつかめる。
 */
export function polygonHitStrokeWidth(shape: {
  paint: { stroke: { width: number } | null };
}): number {
  return Math.max(12, (shape.paint.stroke?.width ?? 0) + 8);
}
