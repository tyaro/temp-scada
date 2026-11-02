import { describe, expect, it } from "vitest";
import sample from "../../../../../examples/minimal.project.json";
import { parseProject } from "../project";
import {
  historyContext,
  historyFormQuery,
  newHistoryForm,
  type HistoryContext,
  type HistoryForm,
} from "./workspace-model";

const project = parseProject(JSON.stringify(sample));
function context(): HistoryContext {
  return {
    version: 1,
    kind: "historyContext",
    contextId: "context:1",
    projectId: project.manifest.projectId,
    projectRevision: project.manifest.projectRevision,
    series: Array.from({ length: 10 }, (_, i) => ({
      seriesId: `history:${i}`,
      label: `温度 ${i}`,
    })),
  };
}
const source = {
  query: async () => {
    throw Error("must not query");
  },
};
const check = (input: unknown) =>
  historyContext({ source, context: input }, project);
const form = (): HistoryForm => ({
  ...newHistoryForm(),
  selected: ["history:1", "history:0"],
  from: "2026-11-02T00:00:00.000Z",
  to: "2026-11-02T01:00:00.000Z",
});

it("owns and freezes context without mutating caller input; no implicit series mapping", () => {
  const input = context();
  const result = check(input);
  expect(result.phase).toBe("ready");
  if (result.phase !== "ready") throw Error("ready");
  input.series[0].label = "changed";
  input.series.length = 0;
  expect(result.context.series[0]).toEqual({
    seriesId: "history:0",
    label: "温度 0",
  });
  expect(Object.isFrozen(result.context.series[0])).toBe(true);
  expect(Object.isFrozen(input)).toBe(false);
});
it("distinguishes offline, empty selection snapshot and Project mismatch", () => {
  expect(historyContext(undefined, project).phase).toBe("offline");
  const input = context();
  input.series = [];
  expect(check(input).phase).toBe("ready");
  input.projectRevision++;
  expect(check(input).phase).toBe("mismatch");
  input.projectRevision--;
  input.projectId = "another-project";
  expect(check(input).phase).toBe("mismatch");
});
describe("finite strict selection context", () => {
  it.each([
    ["invalid context ID", (c: any): unknown => (c.contextId = "id@invalid")],
    ["invalid series ID", (c: any): unknown => (c.series[0].seriesId = "id\n")],
    ["duplicate ID", (c: any): unknown => c.series.push(c.series[0])],
    [
      "unknown field",
      (c: any): unknown => (c.series[0].externalName = "not an ID mapping"),
    ],
    ["missing field", (c: any): unknown => delete c.projectId],
    [
      "unsafe revision",
      (c: any): unknown => (c.projectRevision = Number.MAX_SAFE_INTEGER + 1),
    ],
    ["negative revision", (c: any): unknown => (c.projectRevision = -1)],
    ["whitespace label", (c: any): unknown => (c.series[0].label = " \n\t")],
    ["long label", (c: any): unknown => (c.series[0].label = "😀".repeat(513))],
    [
      "large list",
      (c: any): unknown =>
        (c.series = Array.from({ length: 257 }, (_, i) => ({
          seriesId: `id:${i}`,
          label: "label",
        }))),
    ],
    ["large body", (c: any): unknown => (c.extra = "x".repeat(1024 * 1024))],
    ["cyclic body", (c: any): unknown => (c.extra = c)],
    [
      "custom prototype",
      (c: any): unknown => Object.setPrototypeOf(c.series[0], { extra: true }),
    ],
  ] as const)("rejects %s", (_, mutate) => {
    const input = context();
    mutate(input);
    expect(check(input).phase).toBe("invalid");
  });
  it("does not evaluate context accessors", () => {
    const input = context();
    let calls = 0;
    Object.defineProperty(input.series[0], "label", {
      get: () => {
        calls++;
        return "secret";
      },
      enumerable: true,
    });
    expect(check(input).phase).toBe("invalid");
    expect(calls).toBe(0);
  });
  it("accepts exact limits and duplicate labels without merging series", () => {
    const input = context();
    input.series = Array.from({ length: 256 }, (_, i) => ({
      seriesId: `id:${i}`,
      label: "😀".repeat(512),
    }));
    expect(check(input).phase).toBe("ready");
  });
});
it("builds an H1 query in context order with an explicit half-open UTC hour", () => {
  const result = historyFormQuery(context(), form(), "query:1");
  expect(result.query).toMatchObject({
    version: 1,
    kind: "query",
    requestId: "query:1",
    seriesIds: ["history:0", "history:1"],
    fromMs: 1793577600000,
    toMs: 1793581200000,
    mode: "raw",
    maxPointsPerSeries: 100,
  });
});
it.each([
  "2026-02-30T00:00:00.000Z",
  "2026-11-02T24:00:00.000Z",
  "2026-11-02T00:00:00.000+00:00",
  "2026-11-02T00:00",
  "2026-11-02T00:00:00Z",
  "2026-11-02T00:00:60.000Z",
  "2026-11-02T00:00:00.000Z\n",
])("rejects noncanonical or nonexistent UTC: %s", (from) => {
  expect(
    historyFormQuery(context(), { ...form(), from }, "query:1").issue,
  ).toContain("UTC");
});
it.each([
  { selected: [] },
  { selected: ["unknown"] },
  { selected: ["history:0", "history:0"] },
  { selected: Array.from({ length: 9 }, (_, i) => `history:${i}`) },
  { to: "2026-11-02T00:00:00.000Z" },
  { to: "2026-11-01T23:59:59.999Z" },
  { to: "2026-11-02T01:00:00.001Z" },
  { mode: "auto" },
  { points: "1.5" },
  { points: "1e3" },
  { points: "0" },
  { points: "2001" },
  {
    points: "2000",
    selected: Array.from({ length: 5 }, (_, i) => `history:${i}`),
  },
])("rejects invalid form %j without silently changing it", (patch) => {
  const input = { ...form(), ...patch };
  const before = structuredClone(input);
  expect(historyFormQuery(context(), input, "query:1").query).toBeUndefined();
  expect(input).toEqual(before);
});
it("allows an exact 8000-point minmax budget and delegates final query grammar to H1", () => {
  const input = {
    ...form(),
    points: "1000",
    mode: "minmax",
    selected: Array.from({ length: 8 }, (_, i) => `history:${i}`),
  };
  expect(historyFormQuery(context(), input, "valid:1").query?.mode).toBe(
    "minmax",
  );
  expect(historyFormQuery(context(), input, "invalid@1").query).toBeUndefined();
});
