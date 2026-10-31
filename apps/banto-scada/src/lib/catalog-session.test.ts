import { expect, it } from "vitest";
import fixture from "../../../../examples/catalog-view.json";
import sample from "../../../../examples/minimal.project.json";
import { parseProject } from "./project";
import { createCatalogSession } from "./catalog-session";
import {
  catalogNodes,
  compatibleTag,
  selectedCatalogTag,
} from "./designer/tag-catalog";

const project = () => parseProject(JSON.stringify(sample));
it("bounds visible candidates and still finds tags beyond the initial window", () => {
  const p = project(),
    session = createCatalogSession(p);
  const view = structuredClone(fixture.view);
  view.tags = Array.from({ length: 205 }, (_, i) => ({
    ...view.tags[0],
    externalName: `tag-${i}`,
    name: `number-${i}`,
  }));
  session.receive(session.begin(), view);
  const catalog = session.selection(p).catalog;
  const expanded = new Set(catalog.groups.map((g) => g.id));
  const nodes = catalogNodes(catalog, "", true, expanded);
  expect(nodes.filter((n) => n.tag)).toHaveLength(200);
  expect(
    selectedCatalogTag(catalog, catalog.revision, nodes, "tag:tag-204"),
  ).toBeUndefined();
  expect(
    catalogNodes(catalog, "number-204", true, expanded)
      .filter((n) => n.tag)
      .map((n) => n.tag!.externalName),
  ).toEqual(["tag-204"]);
});
it("accepts the Rust fixture, uses explicit metadata hierarchy and filters target types", () => {
  const p = project(),
    session = createCatalogSession(p);
  expect(session.receive(session.begin(), fixture.view)).toBe(true);
  const selection = session.selection(p),
    catalog = selection.catalog;
  expect(selection.isCurrent()).toBe(true);
  expect(catalog.groups).toHaveLength(4);
  const all = catalogNodes(
    catalog,
    "",
    false,
    new Set(catalog.groups.map((g) => g.id)),
  );
  expect(all.filter((n) => n.tag)).toHaveLength(5);
  expect(
    catalogNodes(
      catalog,
      "",
      true,
      new Set(catalog.groups.map((g) => g.id)),
    ).filter((n) => n.tag),
  ).toHaveLength(2);
  const bool = catalogNodes(
    catalog,
    "",
    true,
    new Set(catalog.groups.map((g) => g.id)),
    "bool",
  );
  expect(bool.filter((n) => n.tag).map((n) => n.tag!.externalName)).toEqual([
    "opaque-running",
  ]);
  expect(
    selectedCatalogTag(
      catalog,
      catalog.revision,
      bool,
      "tag:opaque-running",
      "bool",
    )?.externalName,
  ).toBe("opaque-running");
  expect(
    selectedCatalogTag(catalog, catalog.revision, all, "tag:disabled-number"),
  ).toBeUndefined();
  expect(compatibleTag(catalog.tags[3])).toBe(false);
  expect(
    catalogNodes(catalog, "dotted.name", true, new Set()).map((n) => n.label),
  ).toEqual(["PLC", "A.Fast.Group", "温度"]);
});

const corruptions: [string, (v: any) => void][] = [
  ["extra secret", (v) => (v.secret = "not allowed")],
  ["wire address", (v) => (v.tags[0].address = "D100")],
  ["wrong project", (v) => (v.projectId = "other")],
  ["wrong revision", (v) => v.projectRevision++],
  ["unsafe revision", (v) => (v.catalogRevision = Number.MAX_SAFE_INTEGER + 1)],
  ["unsafe run", (v) => (v.runId = Number.MAX_SAFE_INTEGER + 1)],
  ["unknown mode", (v) => (v.collectionMode = "future")],
  ["duplicate names", (v) => v.tags.push(v.tags[0])],
  ["empty metadata", (v) => (v.tags[0].group = " ")],
  ["control in external name", (v) => (v.tags[0].externalName = "line\nbreak")],
  ["nonboolean enabled", (v) => (v.tags[0].enabled = 1)],
];
it.each(corruptions)(
  "rejects %s without retaining candidates",
  (_, corrupt) => {
    const p = project(),
      session = createCatalogSession(p);
    const bad = structuredClone(fixture.view);
    corrupt(bad);
    expect(session.receive(session.begin(), bad)).toBe(false);
    expect(session.selection(p).available).toBe(false);
    expect(session.selection(p).catalog.tags).toHaveLength(0);
  },
);

it("rejects obsolete and duplicate replies, owns immutable data and retires held selections", () => {
  const p = project(),
    session = createCatalogSession(p);
  const old = session.begin(),
    token = session.begin();
  expect(session.receive(old, fixture.view)).toBe(false);
  const payload = structuredClone(fixture.view);
  expect(session.receive(token, payload)).toBe(true);
  const held = session.selection(p);
  payload.tags[0].externalName = "mutated";
  expect(held.catalog.tags[0].externalName).toBe("opaque-level");
  expect(Object.isFrozen(held.catalog.tags[0])).toBe(true);
  expect(session.receive(token, null)).toBe(false);
  expect(held.isCurrent()).toBe(true);
  expect(session.selection(project()).available).toBe(false);
  expect(session.end(old)).toBe(false);
  expect(session.end(token)).toBe(true);
  expect(held.isCurrent()).toBe(false);
  expect(session.receive(token, fixture.view)).toBe(false);
  const next = session.begin();
  expect(session.receive(next, fixture.view)).toBe(true);
  p.manifest.projectRevision++;
  expect(session.selection(p).available).toBe(false);
});
