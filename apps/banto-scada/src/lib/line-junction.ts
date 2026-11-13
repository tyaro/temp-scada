import type { Point, ScreenObject } from "./project";
import { objectToWorld } from "./rotation";
import { compositedOpacity } from "./opacity";

/**
 * 画面直下の Polyline 同士の分岐の点（T 字・3 本以上の端点の集まり）を描画時に計算する。
 * 保存モデルは変えない。仕様: docs/design/graphics/line-junction.md
 *
 * 後で交差のまたぎを足すときも、`worldLines` と `SegmentIndex` を同じく使う。
 */

/** 端点が線に乗っているとみなす距離（画面座標）。格子の 1 単位の半分。 */
export const junctionTolerance = 0.5;
/** 分岐の点の最小の直径。 */
export const junctionMinDiameter = 6;
export function junctionDiameter(strokeWidth: number) {
  return Math.max(junctionMinDiameter, strokeWidth * 3);
}

/** 回転・反転を適用した world 座標の Polyline。`order` の昇順に並べる。 */
export interface WorldLine {
  id: string;
  order: number;
  color: string;
  opacity: number | undefined;
  strokeWidth: number;
  points: Point[];
}

/** 表示されている画面直下の Polyline を world 座標にする（頂点が 2 つ未満のものは除く）。 */
export function worldLines(objects: readonly ScreenObject[]): WorldLine[] {
  const lines: WorldLine[] = [];
  for (const object of objects) {
    if (object.visible === false || object.shape.type !== "polyline") continue;
    if (object.shape.points.length < 2) continue;
    lines.push({
      id: object.id,
      order: object.order,
      color: object.fill ?? "#000000",
      opacity: compositedOpacity(object),
      strokeWidth: object.shape.strokeWidth,
      points: object.shape.points.map((p) => objectToWorld(object, p)),
    });
  }
  return lines.sort((a, b) => a.order - b.order);
}

/** 線分の格子の大きさ。配管の長さに比べて小さすぎない値にする。 */
const cellSize = 64;
const cell = (value: number) => Math.floor(value / cellSize);
const cellKey = (cx: number, cy: number) => `${cx},${cy}`;

export interface IndexedSegment {
  line: number;
  a: Point;
  b: Point;
}

/** 線分を格子に入れ、点の近くの線分だけを調べる（全組合せの O(n^2) を避ける）。 */
export class SegmentIndex {
  readonly segments: IndexedSegment[] = [];
  private readonly cells = new Map<string, number[]>();
  constructor(lines: readonly WorldLine[], margin = junctionTolerance) {
    lines.forEach((line, index) => {
      for (let i = 1; i < line.points.length; i++) {
        const a = line.points[i - 1],
          b = line.points[i];
        const id = this.segments.push({ line: index, a, b }) - 1;
        const x0 = cell(Math.min(a.x, b.x) - margin),
          x1 = cell(Math.max(a.x, b.x) + margin),
          y0 = cell(Math.min(a.y, b.y) - margin),
          y1 = cell(Math.max(a.y, b.y) + margin);
        for (let cx = x0; cx <= x1; cx++)
          for (let cy = y0; cy <= y1; cy++) {
            const key = cellKey(cx, cy),
              list = this.cells.get(key);
            if (list) list.push(id);
            else this.cells.set(key, [id]);
          }
      }
    });
  }
  /** 点を含む格子の線分（`margin` 以内の線分はすべて含む）。 */
  near(point: Point): IndexedSegment[] {
    return (this.cells.get(cellKey(cell(point.x), cell(point.y))) ?? []).map(
      (id) => this.segments[id],
    );
  }
}

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** 点から線分への最も近い点。 */
export function closestOnSegment(point: Point, a: Point, b: Point): Point {
  const dx = b.x - a.x,
    dy = b.y - a.y,
    length2 = dx * dx + dy * dy;
  if (length2 === 0) return a;
  const t = Math.max(
    0,
    Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length2),
  );
  return { x: a.x + t * dx, y: a.y + t * dy };
}

export interface LineJunction {
  x: number;
  y: number;
  diameter: number;
  color: string;
  opacity: number | undefined;
  /** この Polyline の直後に描く（関わる線のうち後に描かれる線）。 */
  afterId: string;
}

interface Endpoint {
  line: number;
  point: Point;
}

/**
 * 分岐の点。ある線の始点・終点が別の線の途中（その線の両端以外。途中の頂点を含む）に
 * `junctionTolerance` 以内で乗るとき、または 3 つ以上の端点が同じ位置に集まるときに描く。
 * 2 つの端点がつながるだけ（継ぎ足し）では描かない。同じ線の自分自身への接続は見ない。
 */
export function lineJunctions(lines: readonly WorldLine[]): LineJunction[] {
  const tolerance = junctionTolerance;
  const endpoints: Endpoint[] = lines.flatMap((line, index) => [
    { line: index, point: line.points[0] },
    { line: index, point: line.points.at(-1)! },
  ]);

  // 近い端点をまとめる（union-find、格子の近傍 3×3 だけを見る）。
  const parent = endpoints.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const pointCells = new Map<string, number[]>();
  endpoints.forEach((endpoint, i) => {
    const cx = cell(endpoint.point.x),
      cy = cell(endpoint.point.y);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const j of pointCells.get(cellKey(cx + dx, cy + dy)) ?? [])
          if (distance(endpoint.point, endpoints[j].point) <= tolerance)
            parent[find(i)] = find(j);
    const key = cellKey(cx, cy),
      list = pointCells.get(key);
    if (list) list.push(i);
    else pointCells.set(key, [i]);
  });
  const groups = new Map<number, number[]>();
  endpoints.forEach((_, i) => {
    const root = find(i),
      list = groups.get(root);
    if (list) list.push(i);
    else groups.set(root, [i]);
  });

  const index = new SegmentIndex(lines);
  const junctions: LineJunction[] = [];
  for (const members of groups.values()) {
    // 端点が別の線の途中に乗るか（通る側の線と、その線の上の位置）。
    const through = new Map<number, Point>();
    for (const m of members) {
      const { line, point } = endpoints[m];
      for (const segment of index.near(point)) {
        if (segment.line === line || through.has(segment.line)) continue;
        const on = closestOnSegment(point, segment.a, segment.b);
        if (distance(point, on) > tolerance) continue;
        const other = lines[segment.line].points;
        if (
          distance(point, other[0]) <= tolerance ||
          distance(point, other.at(-1)!) <= tolerance
        )
          continue;
        through.set(segment.line, on);
      }
    }
    if (through.size === 0 && members.length < 3) continue;
    const involved = new Set([
      ...through.keys(),
      ...members.map((m) => endpoints[m].line),
    ]);
    const last = Math.max(...involved),
      // 色は通る側の線（複数なら後に描かれる線）。T 字でなければ後に描かれる線。
      colorLine = through.size > 0 ? Math.max(...through.keys()) : last;
    const at =
      through.get(colorLine) ??
      members.reduce(
        (sum, m) => ({
          x: sum.x + endpoints[m].point.x / members.length,
          y: sum.y + endpoints[m].point.y / members.length,
        }),
        { x: 0, y: 0 },
      );
    junctions.push({
      x: at.x,
      y: at.y,
      diameter: junctionDiameter(
        Math.max(...[...involved].map((i) => lines[i].strokeWidth)),
      ),
      color: lines[colorLine].color,
      opacity: lines[colorLine].opacity,
      afterId: lines[last].id,
    });
  }
  return junctions.sort(
    (a, b) => a.afterId.localeCompare(b.afterId) || a.x - b.x || a.y - b.y,
  );
}

/** 画面の配置から、Polyline の id ごとにその直後に描く分岐の点を求める。 */
export function screenJunctions(
  objects: readonly ScreenObject[],
): Map<string, LineJunction[]> {
  const result = new Map<string, LineJunction[]>();
  for (const junction of lineJunctions(worldLines(objects))) {
    const list = result.get(junction.afterId);
    if (list) list.push(junction);
    else result.set(junction.afterId, [junction]);
  }
  return result;
}
