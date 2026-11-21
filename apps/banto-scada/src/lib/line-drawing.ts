// Issue #306 E4: クリックで頂点を足して線を描く作図の状態と判定。純粋関数で、Project を変えない。
// 始点・終点の anchor への吸着は E3 の `findConnectionSnap` を使う。確定は `add-polyline` 1 回。
// 仕様: docs/design/editor/connection-follow-design.md の「E4：線を引きながら接続」。
import type { Point, PolylineObject, ScreenObject } from "./project";
import {
  connectionSnapCandidates,
  type ConnectionSnap,
} from "./connection-snap";
import {
  resolveConnectionObjects,
  type EndpointConnection,
} from "./connections";

export type LineDrawKind = "line" | "pipe";

/** 作図の線の既定の太さ（「線を追加」と同じ）。 */
export const LINE_DRAW_STROKE: Record<LineDrawKind, number> = {
  line: 2,
  pipe: 8,
};

/** 作図中の線。`points` は確定した頂点（world）。 */
export interface LineDraft {
  kind: LineDrawKind;
  points: Point[];
  /** 始点を吸着させた接続。 */
  start?: EndpointConnection;
  /** 最後のクリックの丸めの前の位置（ダブルクリックの 2 回目を再クリックとみなす）。 */
  lastRaw?: Point;
}

export interface FinishedLine {
  kind: LineDrawKind;
  /** world の頂点。2 つ以上の異なる点で、続けて同じ点は無い。 */
  points: Point[];
  connections: { start?: EndpointConnection; end?: EndpointConnection };
}

export interface DrawPointer {
  /** グリッドの丸めと画面の中への収めを済ませた位置。 */
  grid: Point;
  /** 丸めの前のポインタ（吸着の距離はここから測る）。 */
  raw: Point;
  /** Shift: 直前の頂点から水平・垂直にそろえる。 */
  shift: boolean;
  /** Alt: anchor へ吸着しない。 */
  noSnap: boolean;
  /** 吸着の半径（world）。 */
  radius: number;
  /** 直前の頂点の再クリックとみなす半径（world、丸めの前のポインタで測る）。 */
  repeatRadius: number;
}

const DRAFT_ID = "__line-draft__";

/** 直前の頂点から、移動量の大きい方の軸だけを残す。 */
export function constrainToAxis(previous: Point, point: Point): Point {
  return Math.abs(point.x - previous.x) >= Math.abs(point.y - previous.y)
    ? { x: point.x, y: previous.y }
    : { x: previous.x, y: point.y };
}

/** 吸着の判定に使う作図中の線（world の頂点をそのまま持つ、回転 0 の線）。 */
export function draftPolyline(
  kind: LineDrawKind,
  points: readonly Point[],
  connections: FinishedLine["connections"] = {},
): PolylineObject {
  const origin = points[0] ?? { x: 0, y: 0 };
  return {
    id: DRAFT_ID,
    order: Number.MAX_SAFE_INTEGER,
    rotation: 0,
    x: origin.x,
    y: origin.y,
    shape: {
      type: "polyline",
      points: points.map((p) => ({ x: p.x - origin.x, y: p.y - origin.y })),
      strokeWidth: LINE_DRAW_STROKE[kind],
      arrow: "none",
      ...(connections.start || connections.end ? { connections } : {}),
    },
  } as PolylineObject;
}

/**
 * ポインタの位置に置く次の点と、そこで吸着する anchor。`objects` が null（Symbol 定義）
 * か Alt なら吸着しない。始点は解決の検査を省き、終点は始点の接続を含めた線で検査する。
 */
export function draftPointer(
  draft: LineDraft,
  objects: readonly ScreenObject[] | null,
  input: DrawPointer,
): { point: Point; snap: ConnectionSnap | null } {
  const last = draft.points.at(-1);
  const point =
    last && input.shift ? constrainToAxis(last, input.grid) : input.grid;
  if (!objects || input.noSnap) return { point, snap: null };
  const snaps = connectionSnapCandidates(
    objects,
    DRAFT_ID,
    last ? "end" : "start",
    input.raw,
    input.radius,
  );
  if (!last) return { point: snaps[0]?.point ?? point, snap: snaps[0] ?? null };
  // 終点の候補は、終点を anchor の実座標に置いた線で検査する（丸めた位置で検査すると、
  // 始点と同じ点に丸まった別の anchor まで落ちる。#373 のレビュー）。
  for (const snap of snaps) {
    const line = draftPolyline(draft.kind, [...draft.points, snap.point], {
      start: draft.start,
      end: snap.connection,
    });
    try {
      resolveConnectionObjects([...objects, line]);
      return { point: snap.point, snap };
    } catch {
      continue;
    }
  }
  return { point, snap: null };
}

/**
 * クリック 1 回。1 点目は始点（吸着すれば接続）。2 点目以降は、anchor に吸着すれば終点に
 * して確定し、直前の頂点の近くなら確定し、それ以外は頂点を足す。
 */
export function clickDraft(
  draft: LineDraft,
  objects: readonly ScreenObject[] | null,
  input: DrawPointer,
): { draft: LineDraft; finished: FinishedLine | null } {
  const { point, snap } = draftPointer(draft, objects, input);
  const last = draft.points.at(-1);
  if (!last)
    return {
      draft: {
        kind: draft.kind,
        points: [point],
        lastRaw: input.raw,
        ...(snap ? { start: snap.connection } : {}),
      },
      finished: null,
    };
  if (snap) {
    const finished = finishDraft(
      { ...draft, points: [...draft.points, point] },
      snap.connection,
    );
    return finished
      ? { draft: emptyDraft(draft.kind), finished }
      : { draft, finished: null };
  }
  // 再クリックは丸めの前のポインタで測る。離れているのに丸めで直前の頂点と同じ点になった
  // ときは、足しも確定もしない（#373 のレビュー）。
  const near = (p: Point) =>
    Math.hypot(input.raw.x - p.x, input.raw.y - p.y) <= input.repeatRadius;
  if (near(last) || (draft.lastRaw && near(draft.lastRaw))) {
    const finished = finishDraft(draft);
    return finished
      ? { draft: emptyDraft(draft.kind), finished }
      : { draft, finished: null };
  }
  if (point.x === last.x && point.y === last.y)
    return { draft, finished: null };
  return {
    draft: { ...draft, points: [...draft.points, point], lastRaw: input.raw },
    finished: null,
  };
}

/** 確定する線。続けて同じ点を除き、異なる点が 2 つ未満なら null。 */
export function finishDraft(
  draft: LineDraft,
  end?: EndpointConnection,
): FinishedLine | null {
  const points: Point[] = [];
  for (const point of draft.points) {
    const last = points.at(-1);
    if (!last || last.x !== point.x || last.y !== point.y)
      points.push({ x: point.x, y: point.y });
  }
  if (points.length < 2) return null;
  return {
    kind: draft.kind,
    points,
    connections: {
      ...(draft.start ? { start: draft.start } : {}),
      ...(end ? { end } : {}),
    },
  };
}

/** 最後の頂点を消す。始点を消したら始点の接続も消える。 */
export function removeLastVertex(draft: LineDraft): LineDraft {
  const points = draft.points.slice(0, -1);
  // 再クリックの基準は消した頂点のものなので持ち越さない。
  return points.length
    ? {
        kind: draft.kind,
        points,
        ...(draft.start ? { start: draft.start } : {}),
      }
    : emptyDraft(draft.kind);
}

export function emptyDraft(kind: LineDrawKind): LineDraft {
  return { kind, points: [] };
}
