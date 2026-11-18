import type { Point } from "./project";

/**
 * 多角形を挿入するときの初期形。頂点は枠に対する割合で、外接矩形は 0〜1 にぴったり合う。
 * 枠の大きさは矩形の挿入と同じ（160 × 100）。設計は `docs/design/graphics/polygon.md` の「編集」。
 */
export const POLYGON_PRESETS = {
  polygon: {
    label: "多角形",
    points: [
      { x: 0.5, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ],
  },
  /** ホッパー・シュートの胴。上が広い。 */
  trapezoid: {
    label: "台形",
    points: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0.75, y: 1 },
      { x: 0.25, y: 1 },
    ],
  },
  /** フロー図の分岐。 */
  diamond: {
    label: "ひし形",
    points: [
      { x: 0.5, y: 0 },
      { x: 1, y: 0.5 },
      { x: 0.5, y: 1 },
      { x: 0, y: 0.5 },
    ],
  },
  /** 行き先の札。右側が矢じり形の五角形。 */
  arrowTag: {
    label: "行き先の札",
    points: [
      { x: 0, y: 0 },
      { x: 0.8, y: 0 },
      { x: 1, y: 0.5 },
      { x: 0.8, y: 1 },
      { x: 0, y: 1 },
    ],
  },
} as const satisfies Record<string, { label: string; points: Point[] }>;

export type PolygonPresetKind = keyof typeof POLYGON_PRESETS;

export function isPolygonPreset(kind: string): kind is PolygonPresetKind {
  return Object.hasOwn(POLYGON_PRESETS, kind);
}

/** 初期形の頂点の写し（Project へ入れる値を定数と共有しない）。 */
export function polygonPresetPoints(kind: PolygonPresetKind): Point[] {
  return POLYGON_PRESETS[kind].points.map((p) => ({ x: p.x, y: p.y }));
}

/** 部品パレット・お気に入りのアイコン用に、初期形を箱へ当てはめた `points` 属性。 */
export function polygonPresetIcon(
  kind: PolygonPresetKind,
  box: { x: number; y: number; width: number; height: number },
): string {
  return POLYGON_PRESETS[kind].points
    .map((p) => `${box.x + p.x * box.width},${box.y + p.y * box.height}`)
    .join(" ");
}
