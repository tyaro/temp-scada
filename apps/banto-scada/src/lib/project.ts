import Ajv2020 from "ajv/dist/2020.js";
import schema from "../../../../crates/scada-model/schema/project.schema.json";
export interface ScreenObject {
  id: string;
  order: number;
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  shape:
    | { type: "rectangle" }
    | { type: "ellipse" }
    | { type: "text"; text: string };
}
export interface Screen {
  id: string;
  name: string;
  width: number;
  height: number;
  objects: ScreenObject[];
}
export interface Project {
  manifest: {
    product: "banto-scada";
    schemaVersion: "0.1.0";
    projectId: string;
    projectRevision: number;
    minRuntimeVersion: "0.1.0";
    name: string;
  };
  screens: Screen[];
}
const validate = new Ajv2020({
  allErrors: true,
  strictNumbers: true,
}).compile<Project>(schema);
export function parseProject(json: string): Project {
  const value: unknown = JSON.parse(json);
  if (!validate(value))
    throw new Error(
      validate.errors
        ?.map((e) => `${e.instancePath || "/"} ${e.message}`)
        .join(" / "),
    );
  const project = value;
  const ids = new Set([project.manifest.projectId]);
  for (const screen of project.screens) {
    if (ids.has(screen.id)) throw new Error("ID が重複しています");
    ids.add(screen.id);
    const orders = new Set<number>();
    for (const object of screen.objects) {
      if (ids.has(object.id)) throw new Error("ID が重複しています");
      ids.add(object.id);
      if (!Number.isSafeInteger(object.order))
        throw new Error("order is out of range");
      if (orders.has(object.order))
        throw new Error("同一画面の order が重複しています");
      orders.add(object.order);
    }
  }
  return project;
}
export function serializeProject(project: Project): string {
  const json = JSON.stringify(project, null, 2) + "\n";
  parseProject(json);
  return json;
}
