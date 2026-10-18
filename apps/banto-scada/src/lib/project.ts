import Ajv2020 from "ajv/dist/2020.js";
import schema from "../../../../crates/scada-model/schema/project.schema.json";
import legacySchema from "../../../../crates/scada-model/schema/legacy.project.schema.json";
export interface Point {
  x: number;
  y: number;
}
interface BaseObject {
  id: string;
  order: number;
  x: number;
  y: number;
  fill: string;
}
export interface LayoutObject extends BaseObject {
  width: number;
  height: number;
  shape:
    | { type: "rectangle" }
    | { type: "ellipse" }
    | { type: "text"; text: string }
    | { type: "symbol"; symbolId: string };
}
export interface PolylineObject extends BaseObject {
  shape: {
    type: "polyline";
    points: Point[];
    strokeWidth: number;
    arrow: "none" | "end";
  };
}
export type ScreenObject = LayoutObject | PolylineObject;
export interface Screen {
  id: string;
  name: string;
  width: number;
  height: number;
  objects: ScreenObject[];
}
export interface SymbolDefinition {
  id: string;
  name: string;
  width: number;
  height: number;
  objects: ScreenObject[];
}
export interface Project {
  manifest: {
    product: "banto-scada";
    schemaVersion: "0.2.0";
    projectId: string;
    projectRevision: number;
    minRuntimeVersion: "0.2.0";
    name: string;
  };
  screens: Screen[];
  symbols: SymbolDefinition[];
}
const ajv = new Ajv2020({ allErrors: true, strictNumbers: true });
const validate = ajv.compile<Project>(schema);
const legacy = ajv.compile(legacySchema);
export function parseProject(json: string): Project {
  let value: unknown = JSON.parse(json);
  if (
    (value as { manifest?: { schemaVersion?: unknown } } | null)?.manifest
      ?.schemaVersion === "0.1.0"
  ) {
    if (!legacy(value)) throw new Error("旧 Project の形式が不正です");
    const old = value as unknown as Project;
    value = {
      ...old,
      manifest: {
        ...old.manifest,
        schemaVersion: "0.2.0",
        minRuntimeVersion: "0.2.0",
      },
      symbols: [],
    };
  }
  if (!validate(value))
    throw new Error(
      validate.errors
        ?.map((e) => `${e.instancePath || "/"} ${e.message}`)
        .join(" / "),
    );
  const project = value;
  const ids = new Set([project.manifest.projectId]);
  const symbolIds = new Set(project.symbols.map((s) => s.id));
  for (const owner of [...project.screens, ...project.symbols]) {
    if (ids.has(owner.id)) throw new Error("ID が重複しています");
    ids.add(owner.id);
    const orders = new Set<number>();
    for (const object of owner.objects) {
      const shape = object.shape;
      if (ids.has(object.id)) throw new Error("ID が重複しています");
      ids.add(object.id);
      if (!Number.isSafeInteger(object.order))
        throw new Error("order is out of range");
      if (orders.has(object.order))
        throw new Error("同一定義内の order が重複しています");
      orders.add(object.order);
      if (shape.type === "symbol" && !symbolIds.has(shape.symbolId))
        throw new Error("Symbol 定義が見つかりません");
      if (
        shape.type === "polyline" &&
        shape.points.every(
          (p) => p.x === shape.points[0].x && p.y === shape.points[0].y,
        )
      )
        throw new Error("線には異なる2点が必要です");
    }
  }
  return project;
}
export function serializeProject(project: Project): string {
  const json = JSON.stringify(project, null, 2) + "\n";
  parseProject(json);
  return json;
}
export function getBounds(object: ScreenObject) {
  if ("width" in object)
    return { x: 0, y: 0, width: object.width, height: object.height };
  const xs = object.shape.points.map((p) => p.x),
    ys = object.shape.points.map((p) => p.y);
  const pad =
    object.shape.arrow === "end"
      ? Math.max(8, object.shape.strokeWidth * 3)
      : object.shape.strokeWidth / 2;
  return {
    x: Math.min(...xs) - pad,
    y: Math.min(...ys) - pad,
    width: Math.max(...xs) - Math.min(...xs) + 2 * pad,
    height: Math.max(...ys) - Math.min(...ys) + 2 * pad,
  };
}
export function parsePoints(text: string): Point[] {
  return text
    .trim()
    .split(/\n/)
    .map((line) => {
      const parts = line
        .trim()
        .split(",")
        .map((p) => p.trim());
      if (
        parts.length !== 2 ||
        parts.some((p) => p === "") ||
        parts.some((p) => !Number.isFinite(Number(p)))
      )
        throw new Error("頂点は1行に x,y の形式で入力してください");
      return { x: Number(parts[0]), y: Number(parts[1]) };
    });
}
