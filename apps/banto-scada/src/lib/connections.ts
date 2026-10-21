import type { Project, Screen, ScreenObject, PolylineObject } from "./project";
import {
  symbolAnchorPoint,
  followPolylineEndpoints,
  sameConnectionPoint,
} from "./connection-geometry";
import { objectToWorld } from "./rotation";
export {
  CONNECTION_ANCHORS,
  type ConnectionAnchor,
} from "./connection-geometry";
export type ConnectionEnd = "start" | "end";
export interface EndpointConnection {
  targetObjectId: string;
  anchor: import("./connection-geometry").ConnectionAnchor;
}
export interface LineConnections {
  start?: EndpointConnection;
  end?: EndpointConnection;
}
const ends = ["start", "end"] as const;
export function connectedVertex(object: ScreenObject, index: number): boolean {
  return (
    object.shape.type === "polyline" &&
    !!(index === 0
      ? object.shape.connections?.start
      : index === object.shape.points.length - 1
        ? object.shape.connections?.end
        : undefined)
  );
}
function targets(
  object: PolylineObject,
  byId: ReadonlyMap<string, ScreenObject>,
) {
  const result: {
    start?: { x: number; y: number };
    end?: { x: number; y: number };
  } = {};
  for (const end of ends) {
    const connection = object.shape.connections?.[end];
    if (!connection) continue;
    const target = byId.get(connection.targetObjectId);
    if (!target || !("width" in target) || target.shape.type !== "symbol")
      throw new Error(
        `接続先のSymbol配置が見つかりません（配管: ${object.name ?? object.id}）。先に接続を解除するか、参照中の線も一緒に削除してください。`,
      );
    result[end] = symbolAnchorPoint(target, connection.anchor);
  }
  return result;
}
/** Resolve a complete candidate screen, including temporary pointer previews. No mutation. */
export function resolveConnectionObjects(
  objects: readonly ScreenObject[],
): ScreenObject[] {
  const byId = new Map(objects.map((o) => [o.id, o]));
  return objects.map((object) => {
    if (object.shape.type !== "polyline" || !object.shape.connections)
      return object;
    const result = followPolylineEndpoints(
      object as PolylineObject,
      targets(object as PolylineObject, byId),
    );
    if (object.locked && result !== object)
      throw new Error(
        "接続中の配管がロックされているため移動できません。配管のロックを解除してください。",
      );
    return result;
  });
}
/** Validation never repairs saved points or removes dangling references. Called after schema/groups. */
export function validateConnections(project: Project): void {
  for (const definition of project.symbols)
    if (
      definition.objects.some(
        (o) => o.shape.type === "polyline" && o.shape.connections,
      )
    )
      throw new Error("Symbol定義内の配管接続には対応していません");
  for (const screen of project.screens) {
    const connected = screen.objects.filter(
      (o) => o.shape.type === "polyline" && o.shape.connections,
    );
    if (!connected.length) continue;
    const byId = new Map(screen.objects.map((o) => [o.id, o]));
    for (const object of connected) {
      if (object.shape.type !== "polyline" || !object.shape.connections)
        continue;
      if (screen.groups.some((g) => g.memberIds.includes(object.id)))
        throw new Error(
          "接続中の配管はグループへ入れられません。先に接続を解除してください。",
        );
      const world = object.shape.points.map((point) =>
        objectToWorld(object, point),
      );
      if (
        world.some(
          (point) => !Number.isFinite(point.x) || !Number.isFinite(point.y),
        )
      )
        throw new Error("接続点には有限の座標が必要です");
      const points = targets(object as PolylineObject, byId);
      for (const end of ends) {
        const target = points[end];
        if (
          target &&
          !sameConnectionPoint(
            objectToWorld(
              object,
              object.shape.points[
                end === "start" ? 0 : object.shape.points.length - 1
              ],
            ),
            target,
          )
        )
          throw new Error("保存された配管端点が接続先の位置と一致していません");
      }
    }
  }
}
/** Candidate only. Reader validation and final serialization remain the caller's responsibility. */
export function followProjectConnections(project: Project): void {
  for (const screen of project.screens)
    if (
      screen.objects.some(
        (o) => o.shape.type === "polyline" && o.shape.connections,
      )
    )
      screen.objects = resolveConnectionObjects(screen.objects);
}
/** Copies retain only connections whose targets belong to the copied set. */
export function remapConnections(
  object: ScreenObject,
  ids: ReadonlyMap<string, string>,
): void {
  if (object.shape.type !== "polyline" || !object.shape.connections) return;
  const next: LineConnections = {};
  for (const end of ends) {
    const source = object.shape.connections[end];
    const id = source && ids.get(source.targetObjectId);
    if (source && id) next[end] = { ...source, targetObjectId: id };
  }
  object.shape = { ...object.shape };
  if (next.start || next.end) object.shape.connections = next;
  else delete object.shape.connections;
}
export function connectionUsages(
  screen: Pick<Screen, "objects">,
  targetId: string,
) {
  return screen.objects.flatMap((object) =>
    object.shape.type === "polyline"
      ? ends.flatMap((end) =>
          object.shape.type === "polyline" &&
          object.shape.connections?.[end]?.targetObjectId === targetId
            ? [
                {
                  objectId: object.id,
                  name: object.name,
                  end,
                  anchor: object.shape.connections[end]!.anchor,
                },
              ]
            : [],
        )
      : [],
  );
}
