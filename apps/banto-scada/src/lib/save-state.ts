import type { Project } from "./project";
/** revision は編集世代なので内容比較から除く。配列順・ID・schema 等は保存内容として比較する。 */
export function projectContent(project: Project): string {
  const { projectRevision: _revision, ...manifest } = project.manifest;
  return JSON.stringify({ ...project, manifest }, (_key, value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value))
      return Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
      );
    return value;
  });
}
