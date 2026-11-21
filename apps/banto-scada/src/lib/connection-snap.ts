// Issue #306 E3: 線の端のドラッグで anchor へ吸着する判定。純粋関数で、Project を変えない。
// 確定は既存の `set-line-connection`（editor の finish が端点を anchor へ追従させる）に任せる。
import type { Point, PolylineObject, Screen, ScreenObject } from "./project";
import {
  CONNECTION_ANCHORS,
  connectionAnchorPoint,
  isConnectionTarget,
  type ConnectionAnchor,
} from "./connection-geometry";
import {
  resolveConnectionObjects,
  type ConnectionEnd,
  type EndpointConnection,
} from "./connections";

/** 吸着の距離（画面の CSS px）。表示の倍率で world の距離へ換算して使う。 */
export const CONNECTION_SNAP_PX = 12;

export interface ConnectionSnap {
  endpoint: ConnectionEnd;
  connection: EndpointConnection;
  /** anchor の world 座標。 */
  point: Point;
}

/** 吸着の対象になる端か。中間の頂点・接続中の端・group の中の線・ロックした線は対象外。 */
export function snappableEndpoint(
  screen: Pick<Screen, "objects" | "groups">,
  line: ScreenObject,
  index: number,
): ConnectionEnd | undefined {
  if (line.shape.type !== "polyline" || line.locked || line.visible === false)
    return undefined;
  const last = line.shape.points.length - 1;
  const endpoint = index === 0 ? "start" : index === last ? "end" : undefined;
  if (!endpoint || line.shape.connections?.[endpoint]) return undefined;
  if (screen.groups.some((group) => group.memberIds.includes(line.id)))
    return undefined;
  return endpoint;
}

/**
 * `pointer`（world、グリッドの丸めの前）から `radius`（world）以内で最も近い anchor。
 * 候補は同じ画面の表示中の接続先（ロック中も可）。同じ距離なら前面（order の大きい配置）、
 * 次に `CONNECTION_ANCHORS` の順。`candidate` は保存済みの線（確定の `set-line-connection`
 * と同じ入力。途中の頂点はグリッドで反対の端に重なることがある）で、接続した結果が解決
 * できない候補（両端が同じ点になるなど）は除く。`candidate` が null（線を描き始める前の
 * 始点、#306 E4）なら解決の検査を省き、最も近い候補を返す。
 */
export function findConnectionSnap(
  objects: readonly ScreenObject[],
  candidate: PolylineObject | null,
  endpoint: ConnectionEnd,
  pointer: Point,
  radius: number,
): ConnectionSnap | null {
  const snaps = connectionSnapCandidates(
    objects,
    candidate?.id,
    endpoint,
    pointer,
    radius,
  );
  if (!candidate) return snaps[0] ?? null;
  for (const snap of snaps) {
    const line = withConnection(candidate, snap);
    try {
      resolveConnectionObjects(
        objects.map((object) => (object.id === line.id ? line : object)),
      );
      return snap;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * `pointer` から `radius` 以内の anchor を、選ぶ順（距離・前面・anchor の順）に並べる。
 * 解決の検査はしない。`excludeId` の配置（線自身）は候補にしない。
 */
export function connectionSnapCandidates(
  objects: readonly ScreenObject[],
  excludeId: string | undefined,
  endpoint: ConnectionEnd,
  pointer: Point,
  radius: number,
): ConnectionSnap[] {
  if (!(radius > 0) || !Number.isFinite(pointer.x + pointer.y)) return [];
  const hits: { snap: ConnectionSnap; distance: number; order: number }[] = [];
  for (const target of objects) {
    if (
      target.id === excludeId ||
      target.visible === false ||
      !isConnectionTarget(target)
    )
      continue;
    for (const anchor of CONNECTION_ANCHORS) {
      let point: Point;
      try {
        point = connectionAnchorPoint(target, anchor);
      } catch {
        continue;
      }
      const distance = Math.hypot(point.x - pointer.x, point.y - pointer.y);
      if (distance <= radius)
        hits.push({
          snap: {
            endpoint,
            connection: { targetObjectId: target.id, anchor },
            point,
          },
          distance,
          order: target.order,
        });
    }
  }
  hits.sort(
    (a, b) =>
      a.distance - b.distance ||
      b.order - a.order ||
      anchorRank(a.snap.connection.anchor) -
        anchorRank(b.snap.connection.anchor),
  );
  return hits.map((hit) => hit.snap);
}

/** 途中の線に一時の接続を足す（表示・判定の候補）。 */
export function withConnection(
  line: PolylineObject,
  snap: ConnectionSnap,
): PolylineObject {
  return {
    ...line,
    shape: {
      ...line.shape,
      connections: {
        ...line.shape.connections,
        [snap.endpoint]: snap.connection,
      },
    },
  };
}

function anchorRank(anchor: ConnectionAnchor) {
  return CONNECTION_ANCHORS.indexOf(anchor);
}
