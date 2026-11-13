import type {
  LineHopStyle,
  Point,
  PolylineObject,
  ScreenObject,
} from "./project";
import { objectToWorld, worldToObject } from "./rotation";
import {
  closestOnSegment,
  junctionTolerance,
  lineJunctions,
  SegmentIndex,
  segmentCells,
  worldLines,
  type IndexedSegment,
  type LineJunction,
  type WorldLine,
} from "./line-junction";

/**
 * 画面直下の Polyline の交差のまたぎ（ジャンプ）を描画時に計算する。保存の points は変えず、
 * またぐ線の SVG パスだけを「直線＋半円の弧」に置き換える。仕様: docs/design/graphics/line-hop.md
 */

/** またぎの半円の最小の半径。 */
export const hopMinRadius = 4;
/** またぎの半径。またぐ線・またがれる線の太い方の線幅の 2 倍、最小 4。 */
export function hopRadius(hopWidth: number, crossedWidth: number) {
  return Math.max(hopMinRadius, Math.max(hopWidth, crossedWidth) * 2);
}
/** 線分の端に近くて縮めた半径がこれ未満なら、またがずに交差のまま描く。 */
const hopShrinkLimit = hopMinRadius / 2;

/**
 * 線の 1 つの線分の上の、描画を置き換える区間（線分の始点からの距離）。
 * 既定はまたぐ線の弧。`kind: "gap"` は、下の線を切る形（`"cut"`、弧は描かない）で、またがれる線を描かない区間。
 */
export interface HopSpan {
  /** 線の中の線分の番号（始点の頂点の番号）。 */
  segment: number;
  from: number;
  to: number;
  kind?: "gap";
}

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
const at = (a: Point, b: Point, ratio: number): Point => ({
  x: a.x + (b.x - a.x) * ratio,
  y: a.y + (b.y - a.y) * ratio,
});

/** 線分 a–b と c–d の真の交差点（端点・平行・重なりは除く）。a–b 上の距離を返す。 */
function properCrossing(
  a: Point,
  b: Point,
  c: Point,
  d: Point,
): { at: Point; along: number } | null {
  const r = { x: b.x - a.x, y: b.y - a.y },
    s = { x: d.x - c.x, y: d.y - c.y };
  const denominator = cross(r, s);
  const lengthR = Math.hypot(r.x, r.y),
    lengthS = Math.hypot(s.x, s.y);
  // 平行・重なり（角度がほぼ 0）は交差としない。
  if (Math.abs(denominator) <= 1e-9 * lengthR * lengthS) return null;
  const q = { x: c.x - a.x, y: c.y - a.y };
  const t = cross(q, s) / denominator,
    u = cross(q, r) / denominator;
  if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return null;
  const at = { x: a.x + t * r.x, y: a.y + t * r.y };
  // 端点（曲がり角を含む）の近く（`junctionTolerance` 以内）で交わるのは接触とみなす。
  if ([a, b, c, d].some((p) => distance(p, at) <= junctionTolerance))
    return null;
  return { at, along: t * lengthR };
}

/** 分岐の点の円（半径＋許容値）の中か。点を格子に入れ、交差点の格子の点だけを見る。 */
function junctionCover(junctions: readonly LineJunction[]) {
  const size = 64,
    cells = new Map<string, LineJunction[]>();
  for (const junction of junctions) {
    const reach = junction.diameter / 2 + junctionTolerance;
    for (
      let cx = Math.floor((junction.x - reach) / size);
      cx <= Math.floor((junction.x + reach) / size);
      cx++
    )
      for (
        let cy = Math.floor((junction.y - reach) / size);
        cy <= Math.floor((junction.y + reach) / size);
        cy++
      ) {
        const key = `${cx},${cy}`,
          list = cells.get(key);
        if (list) list.push(junction);
        else cells.set(key, [junction]);
      }
  }
  return {
    covers: (point: Point) =>
      (
        cells.get(
          `${Math.floor(point.x / size)},${Math.floor(point.y / size)}`,
        ) ?? []
      ).some(
        (junction) =>
          distance(junction, point) <=
          junction.diameter / 2 + junctionTolerance,
      ),
    /**
     * 線分 a–b に円（半径＋許容値）がかかる分岐の点の、a からの距離と半径。
     * 円は格子の範囲（半径＋許容値）に入れてあるので、線分の通る格子だけを見ればよい。
     */
    along(a: Point, b: Point): { along: number; reach: number }[] {
      const seen = new Set<LineJunction>(),
        result: { along: number; reach: number }[] = [];
      for (const key of segmentCells(a, b, 0))
        for (const junction of cells.get(key) ?? []) {
          if (seen.has(junction)) continue;
          seen.add(junction);
          const reach = junction.diameter / 2 + junctionTolerance;
          const on = closestOnSegment(junction, a, b);
          if (distance(junction, on) > reach) continue;
          result.push({ along: distance(a, on), reach });
        }
      return result;
    },
  };
}

/** 区間の列を、重なる・間の直線が最小半径より短いものから 1 つにまとめる。間に分岐の点があればまとめない。 */
function mergeSpans<T extends { from: number; to: number }>(
  spans: T[],
  blocked: readonly { along: number; reach: number }[],
  keepApart: (last: T, span: T) => boolean = () => false,
): T[] {
  spans.sort((a, b) => a.from - b.from);
  const merged = [spans[0]];
  for (const span of spans.slice(1)) {
    const last = merged.at(-1)!;
    // 間に分岐の点があれば、まとめると点の下の直線が消えるのでまとめない。
    const junctionBetween = blocked.some(
      (junction) =>
        junction.along > last.to - junction.reach &&
        junction.along < span.from + junction.reach,
    );
    if (
      span.from - last.to < hopMinRadius &&
      !junctionBetween &&
      !keepApart(last, span)
    )
      last.to = Math.max(last.to, span.to);
    else merged.push(span);
  }
  return merged;
}

/**
 * 交差のまたぎ。2 本の線の線分が互いの途中で真に交差するとき、後に描かれる線（`order` が大きい線）に
 * またぎの弧を置く。同じ線どうしの交差、分岐の点の円の中の交差は見ない。
 * `style` が `"cut"` なら弧は描かず、またぐ線は直線のまま、またがれる線（先に描かれる線）を交差点から
 * 弧の半径と同じ距離だけ切る（`kind: "gap"`）。
 * 返り値は、`lines` の番号ごとの、線分の番号順・距離順の区間。
 */
export function lineHopSpans(
  lines: readonly WorldLine[],
  style: LineHopStyle = "arc",
): Map<number, HopSpan[]> {
  const index = new SegmentIndex(lines);
  const covered = junctionCover(lineJunctions(lines));
  const arcs = new Map<IndexedSegment, { from: number; to: number }[]>();
  /** 切る区間の候補。またがれる線の線分ごと。 */
  const gaps = new Map<IndexedSegment, { from: number; to: number }[]>();
  for (const segment of index.segments) {
    const hopper = lines[segment.line];
    const length = distance(segment.a, segment.b);
    const spans: { from: number; to: number }[] = [];
    // この線分にかかる分岐の点。またぎはその手前で止め、点の下の直線を消さない。
    let blocked: { along: number; reach: number }[] | undefined;
    for (const other of index.alongSegment(segment.a, segment.b)) {
      // 後に描かれる線の側だけでまたぐ（同じ線どうしは見ない）。
      if (other.line >= segment.line) continue;
      const crossing = properCrossing(segment.a, segment.b, other.a, other.b);
      if (!crossing) continue;
      if (covered.covers(crossing.at)) continue;
      if (style === "cut") {
        // 下の線を切る形では、またぐ線は直線のまま描き、またがれる線だけを切る（弧は描かない）。
        const crossedLine = lines[other.line];
        const crossedLength = distance(other.a, other.b);
        const crossedAlong = distance(other.a, crossing.at);
        const cut = hopRadius(hopper.strokeWidth, crossedLine.strokeWidth);
        const list = gaps.get(other) ?? [];
        list.push({
          from: Math.max(0, crossedAlong - cut),
          to: Math.min(crossedLength, crossedAlong + cut),
        });
        gaps.set(other, list);
        continue;
      }
      blocked ??= covered.along(segment.a, segment.b);
      const radius = Math.min(
        hopRadius(hopper.strokeWidth, lines[other.line].strokeWidth),
        crossing.along,
        length - crossing.along,
        ...blocked.map(
          (junction) =>
            Math.abs(junction.along - crossing.along) - junction.reach,
        ),
      );
      if (radius < hopShrinkLimit) continue;
      spans.push({
        from: crossing.along - radius,
        to: crossing.along + radius,
      });
    }
    if (spans.length === 0) continue;
    const merged = mergeSpans(spans, blocked ?? []);
    arcs.set(segment, merged);
  }
  const result = new Map<number, HopSpan[]>();
  const add = (segment: IndexedSegment, span: HopSpan) => {
    const list = result.get(segment.line) ?? [];
    list.push(span);
    result.set(segment.line, list);
  };
  for (const [segment, list] of arcs)
    for (const span of list)
      add(segment, { segment: segment.index, from: span.from, to: span.to });
  for (const [segment, candidates] of gaps) {
    const blocked = covered.along(segment.a, segment.b);
    const arcsHere = arcs.get(segment) ?? [];
    const overlapsArc = (from: number, to: number) =>
      arcsHere.some((arc) => from < arc.to && arc.from < to);
    // 分岐の点にかかる区間・この線分自身の弧に重なる区間は切らない（点の下の線・弧を消さない）。
    const allowed = candidates.filter(
      (gap) =>
        !overlapsArc(gap.from, gap.to) &&
        !blocked.some(
          (junction) =>
            junction.along + junction.reach > gap.from &&
            junction.along - junction.reach < gap.to,
        ),
    );
    if (allowed.length === 0) continue;
    for (const gap of mergeSpans(allowed, blocked, (last, span) =>
      overlapsArc(last.to, span.from),
    ))
      add(segment, {
        segment: segment.index,
        from: gap.from,
        to: gap.to,
        kind: "gap",
      });
  }
  for (const list of result.values())
    list.sort((a, b) => a.segment - b.segment || a.from - b.from);
  return result;
}

/**
 * またぎの膨らむ向き（world 座標の単位法線）。画面の上（y が小さい側）。
 * 垂直な線分だけは右（x が大きい側）。線を描いた向きによらない。
 */
export function hopSide(a: Point, b: Point): Point {
  const length = distance(a, b);
  let n = { x: -(b.y - a.y) / length, y: (b.x - a.x) / length };
  if (Math.abs(n.y) < 1e-6) {
    if (n.x < 0) n = { x: -n.x, y: -n.y };
  } else if (n.y > 0) n = { x: -n.x, y: -n.y };
  return n;
}

const format = (value: number) => String(Math.round(value * 1000) / 1000);
const xy = (p: Point) => `${format(p.x)} ${format(p.y)}`;

/**
 * またぎのある Polyline の SVG パス（配置のローカル座標。`objectTransform` の中で描く）。
 * 回転・反転は長さを変えないので、線分の上の距離はローカルでも同じ。弧の向きは world で決めた
 * 頂点をローカルへ戻して求める（反転で回り方が変わっても見た目の向きは同じ）。
 */
export function hopPath(object: PolylineObject, spans: readonly HopSpan[]) {
  const points = object.shape.points;
  const parts = [`M ${xy(points[0])}`];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i],
      length = distance(a, b);
    let reachedEnd = false;
    for (const span of spans) {
      if (span.segment !== i - 1) continue;
      if (span.kind === "gap") {
        // 下の線を切る形: 区間を描かず、区間の終わりから描き直す（線分の端で止めた区間は端へ移るだけ）。
        if (span.from > 0) parts.push(`L ${xy(at(a, b, span.from / length))}`);
        parts.push(`M ${xy(at(a, b, span.to / length))}`);
        reachedEnd = span.to >= length;
        continue;
      }
      reachedEnd = false;
      const start = at(a, b, span.from / length),
        end = at(a, b, span.to / length),
        middle = at(a, b, (span.from + span.to) / 2 / length),
        radius = (span.to - span.from) / 2;
      const worldA = objectToWorld(object, a),
        worldB = objectToWorld(object, b),
        worldMiddle = objectToWorld(object, middle),
        side = hopSide(worldA, worldB);
      const apex = worldToObject(object, {
        x: worldMiddle.x + side.x * radius,
        y: worldMiddle.y + side.y * radius,
      });
      // SVG（y が下向き）で sweep=1 は時計回り。進む向きの左に頂点があれば時計回り。
      const sweep =
        cross(
          { x: b.x - a.x, y: b.y - a.y },
          { x: apex.x - middle.x, y: apex.y - middle.y },
        ) < 0
          ? 1
          : 0;
      parts.push(
        `L ${xy(start)}`,
        `A ${format(radius)} ${format(radius)} 0 0 ${sweep} ${xy(end)}`,
      );
    }
    if (!reachedEnd) parts.push(`L ${xy(b)}`);
  }
  return parts.join(" ");
}

/**
 * 画面の配置から、またぎのある Polyline の id ごとにローカル座標の SVG パスを求める。
 * `style` が無い（画面の `lineHops` が無い）なら空。
 */
export function screenHopPaths(
  objects: readonly ScreenObject[],
  style: LineHopStyle | undefined,
): Map<string, string> {
  const result = new Map<string, string>();
  if (!style) return result;
  const lines = worldLines(objects);
  const byId = new Map(objects.map((object) => [object.id, object]));
  for (const [line, spans] of lineHopSpans(lines, style)) {
    const object = byId.get(lines[line].id);
    if (object?.shape.type !== "polyline") continue;
    result.set(object.id, hopPath(object as PolylineObject, spans));
  }
  return result;
}
