import { expect, it } from "vitest";
import sample from "../../../../../examples/trend.project.json";
import { parseProject } from "../project";
import {
  historyContext,
  historyPresetDefinition,
  historyPresetQuery,
  type HistoryContext,
} from "./workspace-model";
const project = parseProject(JSON.stringify(sample));
const definition = {
  ...project.trends![0],
  pens: [
    { id: "pen:b", seriesId: "series:b", color: "#00ffAA", label: " 温度 " },
    { id: "pen:a", seriesId: "series:a", color: "#aB12Ef" },
  ],
};
const saved = { ...project, trends: [definition] };
const context = (): HistoryContext => ({
  version: 2,
  kind: "historyContext",
  contextId: "context:1",
  projectId: project.manifest.projectId,
  projectRevision: project.manifest.projectRevision,
  historianNamespace: definition.historianNamespace,
  series: [
    { seriesId: "series:a", label: "一覧の過去名ではない" },
    { seriesId: "series:b", label: "一覧" },
  ],
});
const source = {
  query: async () => {
    throw Error("not queried");
  },
};
it("accepts, owns and freezes v2 without aliasing caller declaration", () => {
  const input = context();
  const result = historyContext({ source, context: input }, project);
  expect(result.phase).toBe("ready");
  if (result.phase !== "ready") throw Error("ready");
  input.series[0].label = "mutated";
  expect(result.context.series[0].label).toBe("一覧の過去名ではない");
  expect(Object.isFrozen(result.context)).toBe(true);
});
it.each([
  ["missing namespace", (c: any) => delete c.historianNamespace],
  ["invalid namespace", (c: any) => (c.historianNamespace = "archive/invalid")],
  ["unknown version", (c: any) => (c.version = 3)],
  ["v1 cannot carry namespace", (c: any) => (c.version = 1)],
  ["extra field", (c: any) => (c.url = "not a namespace")],
])("rejects invalid v2 context: %s", (_, change) => {
  const input = context();
  change(input);
  expect(historyContext({ source, context: input }, project).phase).toBe(
    "invalid",
  );
});
it("keeps Project revision mismatch gate for v2", () => {
  expect(
    historyContext(
      {
        source,
        context: {
          ...context(),
          projectRevision: project.manifest.projectRevision + 1,
        },
      },
      project,
    ).phase,
  ).toBe("mismatch");
});
it("resolves an owned definition preserving pen order, color case and alias spaces", () => {
  const resolved = historyPresetDefinition(saved, context(), definition.id);
  expect(resolved.definition).toEqual(definition);
  expect(resolved.definition).not.toBe(definition);
  expect(Object.isFrozen(resolved.definition?.pens)).toBe(true);
});
it("requires namespace and all IDs, never labels or list order", () => {
  const c = context();
  expect(
    historyPresetDefinition(saved, { ...c, version: 1 }, definition.id).issue,
  ).toContain("保存Trend");
  expect(
    historyPresetDefinition(
      saved,
      { ...c, version: 2, historianNamespace: "archive:other" },
      definition.id,
    ).issue,
  ).toContain("namespace");
  expect(
    historyPresetDefinition(
      saved,
      { ...c, series: c.series.slice(0, 1) },
      definition.id,
    ).issue,
  ).toContain("全系列");
  expect(historyPresetDefinition(saved, c, "absent").issue).toContain(
    "見つかりません",
  );
});
it("uses definition order and exact H1 fields without namespace or presentation", () => {
  const result = historyPresetQuery(
    context(),
    definition,
    "1970-01-01T00:00:02.000Z",
    "request:1",
  );
  expect(result.query).toEqual({
    version: 1,
    kind: "query",
    requestId: "request:1",
    seriesIds: ["series:b", "series:a"],
    fromMs: 2000 - definition.windowMs,
    toMs: 2000,
    mode: "raw",
    maxPointsPerSeries: 100,
  });
});
it.each([
  "",
  "1970-01-01T00:00:02Z",
  "1970-01-01T00:00:02.000+00:00",
  "2026-02-29T00:00:00.000Z",
  "+010000-01-01T00:00:00.000Z",
  "0000-01-01T00:00:00.000Z",
])("rejects absent/noncanonical/unrepresentable range end %s", (to) => {
  expect(
    historyPresetQuery(context(), definition, to, "request:1").query,
  ).toBeUndefined();
});
it("allows pre-epoch and four digit year edges without clamping", () => {
  expect(
    historyPresetQuery(
      context(),
      { ...definition, windowMs: 1 },
      "0000-01-01T00:00:00.001Z",
      "request:1",
    ).query?.fromMs,
  ).toBe(Date.parse("0000-01-01T00:00:00.000Z"));
  expect(
    historyPresetQuery(
      context(),
      definition,
      "1969-12-31T23:59:59.999Z",
      "request:1",
    ).query?.toMs,
  ).toBe(-1);
  expect(
    historyPresetQuery(
      context(),
      definition,
      "9999-12-31T23:59:59.999Z",
      "request:1",
    ).query,
  ).toBeDefined();
});
it("revalidates settings, namespace and IDs at final submission boundary", () => {
  for (const patch of [
    { windowMs: 0 },
    { windowMs: NaN },
    { mode: "invalid" },
    { maxPointsPerSeries: 2001 },
    { historianNamespace: "archive:other" },
    { pens: [{ id: "p:1", seriesId: "missing", color: "#000000" }] },
  ])
    expect(
      historyPresetQuery(
        context(),
        { ...definition, ...patch } as typeof definition,
        "1970-01-01T00:00:02.000Z",
        "request:1",
      ).query,
    ).toBeUndefined();
  expect(
    historyPresetQuery(
      context(),
      definition,
      "1970-01-01T00:00:02.000Z",
      "bad@id",
    ).query,
  ).toBeUndefined();
});
