import { validatePolygonPoints, type Point } from "./project";
import { placementVector } from "./rotation";

/** 枠の作り直しに要る配置の部分（多角形の配置）。 */
export interface PolygonFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  flipX?: boolean;
  flipY?: boolean;
  shape: { type: "polygon"; points: readonly Point[] };
}

/**
 * 編集後の頂点の 1 つ。`{ keep: i }` は今の i 番目の頂点を触らずに残す指定、点は実寸の頂点
 * （今の枠の左上を原点とする配置の中の座標）。
 */
export type PolygonVertexEdit = { keep: number } | Point;

export type PolygonReframe =
  | {
      ok: true;
      x: number;
      y: number;
      width: number;
      height: number;
      points: Point[];
    }
  | { ok: false; reason: string };

const reject = (reason: string): PolygonReframe => ({ ok: false, reason });

/**
 * 頂点を変える編集の確定（Inspector の頂点の欄、P2 のドラッグ）で通す純関数。
 * 頂点の外接矩形を新しい枠にし、動かしていない頂点の画面上の位置を保つよう位置を補正する。
 * 設計は `docs/design/graphics/polygon.md` の「枠の作り直し」。
 *
 * - 軸ごとに、外接矩形がその軸で今の枠と同じなら、触っていない頂点の割合をそのまま残す
 *   （(u × w) / w = u は浮動小数点で保証されないので、作り直すたびにずれるのを防ぐ）。
 * - 補正は (x′, y′) = (x, y) + c − c′ + M(m + c′ − c)。M は「反転してから回転」の変換。
 *   どの頂点を動かしたかに依らないので、頂点数が変わる編集にも使える。
 */
export function reframePolygon(
  object: PolygonFrame,
  vertices: readonly PolygonVertexEdit[],
): PolygonReframe {
  if (vertices.length < 3 || vertices.length > 64)
    return reject("多角形の頂点は3〜64個です");
  const current = object.shape.points;
  const local: Point[] = [];
  for (const vertex of vertices) {
    if ("keep" in vertex) {
      const kept = current[vertex.keep];
      if (!Number.isInteger(vertex.keep) || !kept)
        return reject("残す頂点が見つかりません");
      local.push({ x: kept.x * object.width, y: kept.y * object.height });
    } else {
      if (!Number.isFinite(vertex.x) || !Number.isFinite(vertex.y))
        return reject("頂点には有限の座標が必要です");
      local.push({ x: vertex.x, y: vertex.y });
    }
  }
  let minX = local[0].x,
    maxX = local[0].x,
    minY = local[0].y,
    maxY = local[0].y;
  for (const p of local) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const width = maxX - minX,
    height = maxY - minY;
  // 割合の式が 0/0 にならないよう、割合を作る前に判定する（枠のハンドルの最小 1 と揃える）。
  if (!(width >= 1) || !(height >= 1))
    return reject(
      "頂点の幅と高さは1以上にしてください（一直線には並べられません）",
    );
  if (!Number.isFinite(width) || !Number.isFinite(height))
    return reject("頂点には有限の座標が必要です");
  const sameX = minX === 0 && width === object.width,
    sameY = minY === 0 && height === object.height;
  const points = vertices.map((vertex, i) => {
    const kept = "keep" in vertex ? current[vertex.keep] : undefined;
    return {
      x: kept && sameX ? kept.x : (local[i].x - minX) / width,
      y: kept && sameY ? kept.y : (local[i].y - minY) / height,
    };
  });
  try {
    validatePolygonPoints(points);
  } catch (error) {
    return reject(error instanceof Error ? error.message : String(error));
  }
  const before = { x: object.width / 2, y: object.height / 2 },
    after = { x: width / 2, y: height / 2 };
  const shift = placementVector(object, {
    x: minX + after.x - before.x,
    y: minY + after.y - before.y,
  });
  return {
    ok: true,
    x: object.x + before.x - after.x + shift.x,
    y: object.y + before.y - after.y + shift.y,
    width,
    height,
    points,
  };
}

/** Inspector の頂点の欄の 1 行（実寸、全桁）。 */
export function polygonVertexLine(object: PolygonFrame, index: number): string {
  const p = object.shape.points[index];
  return `${p.x * object.width},${p.y * object.height}`;
}

/** Inspector の頂点の欄の文字（実寸の頂点を 1 行ずつ）。 */
export function polygonVertexText(object: PolygonFrame): string {
  return object.shape.points
    .map((_, i) => polygonVertexLine(object, i))
    .join("\n");
}

/**
 * 頂点の欄の文字を編集の列へ直す。行ごとに今の値の文字と比べ、同じ位置で文字が変わって
 * いない行は `{ keep: i }` にする（表示の丸め・全桁表示の往復で触っていない頂点を動かさない）。
 * 頂点を何も変えていなければ undefined を返す。形式が違う行は例外を投げる。
 */
export function parsePolygonVertexText(
  text: string,
  object: PolygonFrame,
): PolygonVertexEdit[] | undefined {
  const lines = text.trim().split(/\r?\n/);
  let changed = lines.length !== object.shape.points.length;
  const edits = lines.map((line, i): PolygonVertexEdit => {
    const trimmed = line.trim();
    if (
      i < object.shape.points.length &&
      trimmed === polygonVertexLine(object, i)
    )
      return { keep: i };
    changed = true;
    const parts = trimmed.split(",").map((p) => p.trim());
    if (
      parts.length !== 2 ||
      parts.some((p) => p === "") ||
      parts.some((p) => !Number.isFinite(Number(p)))
    )
      throw new Error("頂点は1行に x,y の形式で入力してください");
    return { x: Number(parts[0]), y: Number(parts[1]) };
  });
  return changed ? edits : undefined;
}
