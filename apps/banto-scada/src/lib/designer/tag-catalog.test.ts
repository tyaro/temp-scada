import { expect, it } from "vitest";
import {
  sampleCatalog,
  catalogNodes,
  numericTag,
  selectedCatalogTag,
  type TagType,
} from "./tag-catalog";
const expanded = new Set(sampleCatalog.groups.map((g) => g.id));
it("uses explicit metadata hierarchy, searches fields and preserves opaque external names", () => {
  const catalog = {
    ...sampleCatalog,
    tags: sampleCatalog.tags.map((t) => ({
      ...t,
      externalName: t.id === "level" ? "opaque-without-dots" : t.externalName,
    })),
  };
  const nodes = catalogNodes(catalog, "opaque-without-dots", true, new Set());
  expect(nodes.map((n) => n.id)).toEqual([
    "group:water",
    "group:tank",
    "tag:level",
  ]);
  expect(nodes.at(-1)?.tag?.externalName).toBe("opaque-without-dots");
  expect(catalogNodes(catalog, "MPa", true, expanded).at(-1)?.tag?.id).toBe(
    "pressure",
  );
  expect(
    catalogNodes(catalog, "ポンプ", true, expanded).filter((n) => n.tag),
  ).toHaveLength(1);
});
it("filters incompatible types, rejects hidden and obsolete candidates, and never infers values", () => {
  const visible = catalogNodes(sampleCatalog, "", true, expanded);
  expect(visible.filter((n) => n.tag)).toHaveLength(4);
  expect(
    selectedCatalogTag(
      sampleCatalog,
      sampleCatalog.revision,
      visible,
      "tag:level",
    )?.id,
  ).toBe("level");
  expect(
    selectedCatalogTag(sampleCatalog, "old-revision", visible, "tag:level"),
  ).toBeUndefined();
  expect(
    selectedCatalogTag(
      sampleCatalog,
      sampleCatalog.revision,
      catalogNodes(sampleCatalog, "pressure", true, expanded),
      "tag:level",
    ),
  ).toBeUndefined();
  const all = catalogNodes(sampleCatalog, "", false, expanded);
  expect(all.filter((n) => n.tag)).toHaveLength(6);
  expect(
    selectedCatalogTag(
      sampleCatalog,
      sampleCatalog.revision,
      all,
      "tag:running",
    ),
  ).toBeUndefined();
  expect(
    selectedCatalogTag(
      sampleCatalog,
      sampleCatalog.revision,
      all,
      "group:water",
    ),
  ).toBeUndefined();
  for (const type of [
    "i16",
    "u16",
    "i32",
    "u32",
    "f32",
    "i64",
    "u64",
    "f64",
  ] as TagType[])
    expect(numericTag({ ...sampleCatalog.tags[0], type })).toBe(true);
  for (const type of ["bit", "string"] as TagType[])
    expect(numericTag({ ...sampleCatalog.tags[0], type })).toBe(false);
  expect(sampleCatalog.tags.every((t) => !("value" in t))).toBe(true);
});
