export type TagType =
  | "i16"
  | "u16"
  | "i32"
  | "u32"
  | "f32"
  | "i64"
  | "u64"
  | "f64"
  | "bit"
  | "string"
  | (string & {});
export interface CatalogTag {
  id: string;
  groupId: string;
  name: string;
  externalName: string;
  type: TagType;
  unit?: string;
  description: string;
  enabled?: boolean;
}
export interface CatalogGroup {
  id: string;
  parentId?: string;
  name: string;
}
export interface TagCatalog {
  revision: string;
  groups: readonly CatalogGroup[];
  tags: readonly CatalogTag[];
}
export const MAX_CATALOG_CANDIDATES = 200;
export const sampleCatalog: TagCatalog = {
  revision: "scada-sample-tags-1",
  groups: [
    { id: "water", name: "サンプル水処理" },
    { id: "tank", parentId: "water", name: "タンク" },
    { id: "pump", parentId: "water", name: "ポンプ" },
    { id: "line", name: "サンプルライン" },
  ],
  tags: [
    {
      id: "level",
      groupId: "tank",
      name: "原水タンク 液位",
      externalName: "Demo.Water.Tank01.Level",
      type: "f64",
      unit: "%",
      description: "原水タンクの液位（サンプル定義）",
    },
    {
      id: "temperature",
      groupId: "tank",
      name: "原水タンク 温度",
      externalName: "Demo.Water.Tank01.Temperature",
      type: "f32",
      unit: "°C",
      description: "原水タンクの温度（サンプル定義）",
    },
    {
      id: "pressure",
      groupId: "pump",
      name: "原水ポンプ 吐出圧力",
      externalName: "Demo.Water.Pump01.Pressure",
      type: "f64",
      unit: "MPa",
      description: "原水ポンプの圧力（サンプル定義）",
    },
    {
      id: "running",
      groupId: "pump",
      name: "原水ポンプ 運転状態",
      externalName: "Demo.Water.Pump01.Running",
      type: "bit",
      description: "数値Textの対象外。状態表示は後続です",
    },
    {
      id: "count",
      groupId: "line",
      name: "搬送数",
      externalName: "Demo.Line.WorkCount",
      type: "u32",
      unit: "個",
      description: "ラインの搬送数（サンプル定義）",
    },
    {
      id: "recipe",
      groupId: "line",
      name: "品種名",
      externalName: "Demo.Line.RecipeName",
      type: "string",
      description: "数値Textの対象外。文字列表示は後続です",
    },
  ],
};
export function numericTag(tag: CatalogTag) {
  return (
    tag.enabled !== false &&
    ["i16", "u16", "i32", "u32", "f32", "i64", "u64", "f64"].includes(tag.type)
  );
}
export function compatibleTag(
  tag: CatalogTag,
  expected: "number" | "bool" = "number",
) {
  return (
    tag.enabled !== false &&
    (expected === "bool" ? tag.type === "bit" : numericTag(tag))
  );
}
export interface CatalogNode {
  id: string;
  label: string;
  parentId?: string;
  depth: number;
  tag?: CatalogTag;
  expanded?: boolean;
}
/** Metadata defines hierarchy; externalName is an opaque identity. */
export function catalogNodes(
  catalog: TagCatalog,
  query: string,
  compatibleOnly: boolean,
  expanded: ReadonlySet<string>,
  expected: "number" | "bool" = "number",
): CatalogNode[] {
  const text = query.trim().toLocaleLowerCase();
  const groups = new Map(catalog.groups.map((g) => [g.id, g]));
  function ancestry(id: string): CatalogGroup[] {
    const chain: CatalogGroup[] = [],
      seen = new Set<string>();
    let group = groups.get(id);
    while (group && !seen.has(group.id)) {
      seen.add(group.id);
      chain.unshift(group);
      group = group.parentId ? groups.get(group.parentId) : undefined;
    }
    return chain;
  }
  const tags = catalog.tags
    .filter(
      (t) =>
        (!compatibleOnly || compatibleTag(t, expected)) &&
        (!text ||
          [
            t.name,
            t.externalName,
            t.type,
            t.unit ?? "",
            t.description,
            ...ancestry(t.groupId).map((g) => g.name),
          ]
            .join(" ")
            .toLocaleLowerCase()
            .includes(text)),
    )
    .slice(0, MAX_CATALOG_CANDIDATES);
  const included = new Set(
    tags.flatMap((t) => ancestry(t.groupId).map((g) => g.id)),
  );
  const visibleGroups = catalog.groups.filter((group) =>
    included.has(group.id),
  );
  const nodes: CatalogNode[] = [];
  function visit(
    parentId: string | undefined,
    depth: number,
    seen: ReadonlySet<string>,
  ) {
    for (const group of visibleGroups.filter(
      (g) => g.parentId === parentId && included.has(g.id) && !seen.has(g.id),
    )) {
      const open = !!text || expanded.has(group.id);
      nodes.push({
        id: `group:${group.id}`,
        label: group.name,
        parentId: parentId ? `group:${parentId}` : undefined,
        depth,
        expanded: open,
      });
      if (open) {
        visit(group.id, depth + 1, new Set([...seen, group.id]));
        for (const tag of tags.filter((t) => t.groupId === group.id))
          nodes.push({
            id: `tag:${tag.id}`,
            label: tag.name,
            parentId: `group:${group.id}`,
            depth: depth + 1,
            tag,
          });
      }
    }
  }
  visit(undefined, 1, new Set());
  return nodes;
}
export function selectedCatalogTag(
  catalog: TagCatalog,
  revision: string,
  nodes: CatalogNode[],
  id: string | null,
  expected: "number" | "bool" = "number",
) {
  if (catalog.revision !== revision) return undefined;
  const candidate = nodes.find((n) => n.id === id)?.tag;
  return candidate && compatibleTag(candidate, expected)
    ? catalog.tags.find(
        (t) =>
          t.id === candidate.id &&
          t.externalName === candidate.externalName &&
          compatibleTag(t, expected),
      )
    : undefined;
}
