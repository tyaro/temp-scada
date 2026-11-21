import { describe, expect, it } from "vitest";
import rawCases from "../../../../../examples/history-query-cases.json";
import minmaxCases from "../../../../../examples/history-minmax-cases.json";
import coverageCases from "../../../../../examples/history-coverage-cases.json";
import retentionCases from "../../../../../examples/history-retention-cases.json";
import { parseHistoryContract, type HistoryResult } from "../history-contract";
import {
  historyResultToTrendSeries,
  historyTrendPens,
  isBoolSeries,
  nearestColorSlots,
} from "./trend-adapter";

function parsed(input: unknown): HistoryResult {
  const value = parseHistoryContract(input);
  if (value.kind !== "result") throw Error("fixture");
  return value;
}

const results = [
  ...rawCases,
  ...minmaxCases,
  ...coverageCases,
  ...retentionCases,
].filter(
  (fixture) =>
    fixture.expected &&
    "kind" in fixture.expected &&
    fixture.expected.kind === "result",
);

describe("historyResultToTrendSeries", () => {
  it.each(results)(
    "keeps every ready series' points in time order: $name",
    ({ expected }) => {
      const input = parsed(expected);
      const original = structuredClone(input);
      const out = historyResultToTrendSeries(input);
      expect(input).toEqual(original);
      for (const row of input.series) {
        const series = out[row.seriesId];
        if (row.status !== "ready") {
          expect(series).toBeUndefined();
          continue;
        }
        const sorted = [...row.bins].sort((a, b) => a.fromMs - b.fromMs);
        const switches = sorted.filter(
          (bin, i) =>
            i > 0 &&
            bin.segmentId !== null &&
            sorted[i - 1].segmentId !== null &&
            sorted[i - 1].segmentId !== bin.segmentId &&
            bin.fromMs > sorted[i - 1].fromMs,
        ).length;
        const count =
          input.query.mode === "raw"
            ? row.raw.length
            : row.bins.length + switches;
        expect(series.bins).toHaveLength(count);
        expect(series.binMs).toBeGreaterThanOrEqual(1);
        const times = series.bins.map((bin) => bin.tMs);
        expect(times).toEqual([...times].sort((a, b) => a - b));
        for (const bin of series.bins)
          expect(bin.min === null).toBe(bin.max === null);
      }
    },
  );

  it("treats gap and mixedSegment bins as missing and keeps partial values", () => {
    const base = {
      min: 1,
      max: 2,
      validCount: 1,
      invalidCount: 0,
      segmentId: "s",
      source: "real" as const,
    };
    const result = {
      version: 1,
      kind: "result",
      status: "ready",
      snapshotId: null,
      query: {
        version: 1,
        kind: "query",
        requestId: "r",
        seriesIds: ["a"],
        fromMs: 0,
        toMs: 400,
        mode: "minmax",
        maxPointsPerSeries: 4,
      },
      series: [
        {
          seriesId: "a",
          status: "ready",
          segments: [],
          raw: [],
          coverage: [],
          watermark: null,
          bins: [
            { ...base, fromMs: 300, toMs: 400, state: "mixedSegment" },
            { ...base, fromMs: 0, toMs: 100, state: "complete" },
            { ...base, fromMs: 100, toMs: 201, state: "partial" },
            {
              ...base,
              fromMs: 201,
              toMs: 300,
              state: "gap",
              min: null,
              max: null,
            },
          ],
        },
      ],
    } as HistoryResult;
    expect(historyResultToTrendSeries(result).a).toEqual({
      binMs: 101,
      bins: [
        { tMs: 0, min: 1, max: 2 },
        { tMs: 100, min: 1, max: 2 },
        { tMs: 201, min: null, max: null },
        { tMs: 300, min: null, max: null },
      ],
    });
  });

  it("maps raw bool samples to 0/1 and uses the segment period", () => {
    const sample = (t: number, value: boolean | null) => ({
      seriesId: "b",
      segmentId: "s",
      recordId: { sessionId: "x", sequence: t },
      clockEpoch: "c",
      sampleTimeMs: t,
      sourceTimeMs: t,
      ingestedAtMs: t,
      quality: "good" as const,
      source: "real" as const,
      value,
      reason: null,
    });
    const segment = {
      seriesId: "b",
      hubInstanceId: "h",
      incarnationId: "i",
      externalName: "b",
      segmentId: "s",
      valueType: "bool" as const,
      unit: null,
      periodMs: 500,
      source: "real" as const,
    };
    const row = {
      seriesId: "b",
      status: "ready" as const,
      segments: [segment],
      raw: [sample(1000, true), sample(0, false), sample(500, null)],
      bins: [],
      coverage: [],
      watermark: null,
    };
    const result = {
      version: 1,
      kind: "result",
      status: "ready",
      snapshotId: null,
      query: {
        version: 1,
        kind: "query",
        requestId: "r",
        seriesIds: ["b"],
        fromMs: 0,
        toMs: 1500,
        mode: "raw",
        maxPointsPerSeries: 10,
      },
      series: [row],
    } as HistoryResult;
    expect(isBoolSeries(row)).toBe(true);
    expect(historyResultToTrendSeries(result).b).toEqual({
      binMs: 500,
      bins: [
        { tMs: 0, min: 0, max: 0 },
        { tMs: 500, min: null, max: null },
        { tMs: 1000, min: 1, max: 1 },
      ],
    });
  });

  it("breaks the line where the segment changes", () => {
    const bin = (fromMs: number, segmentId: string) => ({
      fromMs,
      toMs: fromMs + 100,
      min: 1,
      max: 2,
      validCount: 1,
      invalidCount: 0,
      state: "complete" as const,
      segmentId,
      source: "real" as const,
    });
    const result = {
      version: 1,
      kind: "result",
      status: "ready",
      snapshotId: null,
      query: {
        version: 1,
        kind: "query",
        requestId: "r",
        seriesIds: ["a"],
        fromMs: 0,
        toMs: 300,
        mode: "minmax",
        maxPointsPerSeries: 3,
      },
      series: [
        {
          seriesId: "a",
          status: "ready",
          segments: [],
          raw: [],
          coverage: [],
          watermark: null,
          bins: [bin(0, "s1"), bin(100, "s1"), bin(200, "s2")],
        },
      ],
    } as HistoryResult;
    expect(historyResultToTrendSeries(result).a.bins).toEqual([
      { tMs: 0, min: 1, max: 2 },
      { tMs: 100, min: 1, max: 2 },
      { tMs: 199, min: null, max: null },
      { tMs: 200, min: 1, max: 2 },
    ]);
  });
});

describe("segment breaks between 1 ms bins", () => {
  it("still breaks the line when adjacent bins are 1 ms apart", () => {
    const bin = (fromMs: number, segmentId: string) => ({
      fromMs,
      toMs: fromMs + 1,
      min: 1,
      max: 2,
      validCount: 1,
      invalidCount: 0,
      state: "complete" as const,
      segmentId,
      source: "real" as const,
    });
    const result = {
      version: 1,
      kind: "result",
      status: "ready",
      snapshotId: null,
      query: {
        version: 1,
        kind: "query",
        requestId: "r",
        seriesIds: ["a"],
        fromMs: 0,
        toMs: 2,
        mode: "minmax",
        maxPointsPerSeries: 2,
      },
      series: [
        {
          seriesId: "a",
          status: "ready",
          segments: [],
          raw: [],
          coverage: [],
          watermark: null,
          bins: [bin(0, "s1"), bin(1, "s2")],
        },
      ],
    } as HistoryResult;
    expect(historyResultToTrendSeries(result).a.bins).toEqual([
      { tMs: 0, min: 1, max: 2 },
      { tMs: 0.5, min: null, max: null },
      { tMs: 1, min: 1, max: 2 },
    ]);
  });
});

describe("historyTrendPens", () => {
  const identity = (segmentId: string, unit: string) => ({
    seriesId: "t",
    hubInstanceId: "h",
    incarnationId: "i",
    externalName: "温度",
    segmentId,
    valueType: "number" as const,
    unit,
    periodMs: 1000,
    source: "real" as const,
  });
  const bin = (fromMs: number, segmentId: string, value: number) => ({
    fromMs,
    toMs: fromMs + 100,
    min: value,
    max: value,
    validCount: 1,
    invalidCount: 0,
    state: "complete" as const,
    segmentId,
    source: "real" as const,
  });
  const result = (segments: ReturnType<typeof identity>[]) =>
    ({
      version: 1,
      kind: "result",
      status: "ready",
      snapshotId: null,
      query: {
        version: 1,
        kind: "query",
        requestId: "r",
        seriesIds: ["t"],
        fromMs: 0,
        toMs: 400,
        mode: "minmax",
        maxPointsPerSeries: 4,
      },
      series: [
        {
          seriesId: "t",
          status: "ready",
          segments,
          raw: [],
          coverage: [],
          watermark: null,
          bins: [
            bin(0, "c", 20),
            bin(100, "c", 21),
            bin(200, "f", 70),
            bin(300, "f", 71),
          ],
        },
      ],
    }) as HistoryResult;

  it("keeps one pen with its unit when the unit does not change", () => {
    const pens = historyTrendPens(
      result([identity("c", "C"), identity("f", "C")]),
    );
    expect(pens.map((pen) => [pen.id, pen.unit, pen.split])).toEqual([
      ["t", "C", false],
    ]);
  });

  it("splits a series whose unit changes and blanks the other unit's bins", () => {
    const pens = historyTrendPens(
      result([identity("c", "C"), identity("f", "F")]),
    );
    expect(pens.map((pen) => [pen.id, pen.unit, pen.split])).toEqual([
      ["t~1", "C", true],
      ["t~2", "F", true],
    ]);
    const values = (index: number) =>
      pens[index].series.bins
        .filter((b) => b.tMs % 100 === 0)
        .map((b) => b.max);
    expect(values(0)).toEqual([20, 21, null, null]);
    expect(values(1)).toEqual([null, null, 70, 71]);
  });
});

describe("nearestColorSlots", () => {
  const palette = [[37, 99, 235], [234, 88, 12], [22, 163, 74], null] as const;
  it("picks the closest unused slot for each hex color", () => {
    expect(nearestColorSlots(["#f97316", "#2563eb"], palette)).toEqual([2, 1]);
  });
  it("does not give two pens the same slot", () => {
    expect(nearestColorSlots(["#ea580c", "#f97316"], palette)).toEqual([2, 3]);
  });
  it("gives pens without a valid hex the remaining slots in order", () => {
    expect(nearestColorSlots([undefined, "#16a34a", "red"], palette)).toEqual([
      1, 3, 2,
    ]);
  });
  it("falls back to slots 9-16 when the palette is exhausted", () => {
    const colors = Array.from({ length: 10 }, () => undefined);
    expect(nearestColorSlots(colors, [])).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });
});
