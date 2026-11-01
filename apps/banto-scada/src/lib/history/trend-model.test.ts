import { expect, it } from "vitest";
import rawCases from "../../../../../examples/history-query-cases.json";
import minmaxCases from "../../../../../examples/history-minmax-cases.json";
import coverageCases from "../../../../../examples/history-coverage-cases.json";
import retentionCases from "../../../../../examples/history-retention-cases.json";
import { parseHistoryContract, type HistoryResult } from "../history-contract";
import { historyTime, projectHistoryTrend, trendY } from "./trend-model";

function parsed(input: unknown): HistoryResult {
  const value = parseHistoryContract(input);
  if (value.kind !== "result") throw Error("fixture");
  return value;
}
it.each(
  [...rawCases, ...minmaxCases, ...coverageCases, ...retentionCases].filter(
    (fixture) =>
      fixture.expected &&
      "kind" in fixture.expected &&
      fixture.expected.kind === "result",
  ),
)("preserves observations, bins and coverage: $name", ({ expected }) => {
  const input = parsed(expected),
    original = structuredClone(input),
    model = projectHistoryTrend(input);
  expect(input).toEqual(original);
  expect(Object.isFrozen(input)).toBe(false);
  for (let i = 0; i < input.series.length; i++) {
    const row = input.series[i],
      series = model.series[i];
    expect(series.status).toBe(row.status);
    expect(series.coverage).toEqual(row.coverage);
    expect(
      series.lanes.reduce(
        (sum, lane) => sum + lane.points.length + lane.nulls.length,
        0,
      ),
    ).toBe(row.raw.length);
    expect(
      series.lanes.reduce(
        (sum, lane) => sum + lane.ranges.length + lane.gaps.length,
        0,
      ) + series.mixed.length,
    ).toBe(row.bins.length);
    expect(
      series.mixed.every((bin) => bin.min === null && bin.max === null),
    ).toBe(true);
    expect(
      series.lanes.every(
        (lane) =>
          lane.identity.valueType !== "bool" ||
          lane.points.every((point) => point.value === 0 || point.value === 1),
      ),
    ).toBe(true);
  }
  expect(Object.isFrozen(model.query.seriesIds)).toBe(true);
});

it("keeps simultaneous records in separate lanes and does not invent raw paths", () => {
  const model = projectHistoryTrend(parsed(rawCases[0].expected));
  const series = model.series.find((row) => row.seriesId === "number")!;
  expect(series.lanes.flatMap((lane) => lane.points).length).toBeGreaterThan(0);
  expect(JSON.stringify(model)).not.toContain('"paths"');
  expect(
    series.coverage.some((range) => range.reason === "unknownCoverage"),
  ).toBe(true);
});
it("normalizes extreme finite bounds and formats epochs outside Date range", () => {
  for (const bounds of [
    [-Number.MAX_VALUE, Number.MAX_VALUE],
    [1e-320, 2e-320],
    [42, 42],
  ] as [number, number][]) {
    for (const value of bounds)
      expect(Number.isFinite(trendY(value, bounds))).toBe(true);
  }
  expect(trendY(-Number.MAX_VALUE, [-Number.MAX_VALUE, Number.MAX_VALUE])).toBe(
    0,
  );
  expect(trendY(Number.MAX_VALUE, [-Number.MAX_VALUE, Number.MAX_VALUE])).toBe(
    1,
  );
  expect(historyTime(Number.MAX_SAFE_INTEGER)).toBe(
    `${Number.MAX_SAFE_INTEGER} ms`,
  );
});
