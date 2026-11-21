import { describe, expect, it } from "vitest";
import { binAt, envelopePath } from "@banto-industrial/trend";
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
        const count =
          input.query.mode === "raw" ? row.raw.length : row.bins.length;
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

  it("keeps one pen when the series has a single segment", () => {
    const one = result([identity("c", "C")]);
    one.series[0].bins.forEach((b) => (b.segmentId = "c"));
    const pens = historyTrendPens(one);
    expect(pens.map((pen) => [pen.id, pen.unit, pen.part])).toEqual([
      ["t", "C", null],
    ]);
  });

  it("splits a series per segment and blanks the other segment's bins", () => {
    for (const units of [
      ["C", "F"],
      ["C", "C"],
    ]) {
      const pens = historyTrendPens(
        result([identity("c", units[0]), identity("f", units[1])]),
      );
      expect(pens.map((pen) => [pen.id, pen.unit, pen.part])).toEqual([
        ["t~1", units[0], { index: 1, count: 2 }],
        ["t~2", units[1], { index: 2, count: 2 }],
      ]);
      expect(pens[0].series.bins.map((b) => b.max)).toEqual([
        20,
        21,
        null,
        null,
      ]);
      expect(pens[1].series.bins.map((b) => b.max)).toEqual([
        null,
        null,
        70,
        71,
      ]);
    }
  });

  it("keeps the full length of the last bin before a segment change", () => {
    const pens = historyTrendPens(
      result([identity("c", "C"), identity("f", "F")]),
    );
    const { bins, binMs } = pens[0].series;
    expect(binAt(bins, binMs, 98)?.max).toBe(20);
    expect(binAt(bins, binMs, 199)?.max).toBe(21);
    expect(binAt(bins, binMs, 200)).toBeNull();
  });
});

describe("bool steps", () => {
  const bool = (
    fromMs: number,
    state: "complete" | "gap",
    min: number | null,
    max: number | null,
  ) => ({
    fromMs,
    toMs: fromMs + 100,
    min,
    max,
    validCount: state === "gap" ? 0 : 1,
    invalidCount: 0,
    state,
    segmentId: "b",
    source: "real" as const,
  });
  // OFF・ON・欠測・両方（mixed）の 4 区間。
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
      toMs: 400,
      mode: "minmax",
      maxPointsPerSeries: 4,
    },
    series: [
      {
        seriesId: "b",
        status: "ready",
        segments: [
          {
            seriesId: "b",
            hubInstanceId: "h",
            incarnationId: "i",
            externalName: "運転",
            segmentId: "b",
            valueType: "bool",
            unit: null,
            periodMs: 1000,
            source: "real",
          },
        ],
        raw: [],
        coverage: [],
        watermark: null,
        bins: [
          bool(0, "complete", 0, 0),
          bool(100, "complete", 1, 1),
          bool(200, "gap", null, null),
          bool(300, "complete", 0, 1),
        ],
      },
    ],
  } as HistoryResult;

  /** 部品の実際の包絡の path を、x = 時刻、y = 値 で作って点の列に分ける。 */
  function subpaths() {
    const [pen] = historyTrendPens(result);
    const d = envelopePath(
      pen.series.bins,
      pen.series.binMs,
      (t) => t,
      (v) => v,
      { startMs: 0, endMs: 400 },
    );
    return d
      .split("M")
      .filter(Boolean)
      .map((part) =>
        part.split("L").map((point) => point.split(",").map(Number)),
      );
  }

  it("draws OFF and ON as flat steps with a near-vertical change, and breaks at the gap", () => {
    const [first, second] = subpaths();
    expect(subpaths()).toHaveLength(2);
    // OFF の区間は y = 0、ON の区間は y = 1 の水平。間の変わり目はほぼ垂直（x の差が 1 未満）。
    const off = first.filter(([x]) => x < 100);
    const on = first.filter(([x]) => x >= 100);
    expect(off.length).toBeGreaterThanOrEqual(2);
    expect(off.every(([, y]) => y === 0)).toBe(true);
    expect(on.every(([, y]) => y === 1)).toBe(true);
    for (let i = 1; i < first.length; i++) {
      const [x0, y0] = first[i - 1];
      const [x1, y1] = first[i];
      expect(y0 === y1 || Math.abs(x1 - x0) < 1).toBe(true);
    }
    // 欠測の区間 [200, 300) には点が無い。
    expect([...first, ...second].some(([x]) => x >= 200 && x < 300)).toBe(
      false,
    );
    // 両方の状態を含む区間は 0 と 1 の両方に届く。
    expect(second.some(([, y]) => y === 0)).toBe(true);
    expect(second.some(([, y]) => y === 1)).toBe(true);
    expect(second.every(([x]) => x >= 300 && x <= 400)).toBe(true);
  });

  it("keeps the state readable anywhere inside a bin", () => {
    const [pen] = historyTrendPens(result);
    const at = (t: number) => binAt(pen.series.bins, pen.series.binMs, t);
    expect(at(1)?.max).toBe(0);
    expect(at(99)?.max).toBe(0);
    expect(at(150)?.max).toBe(1);
    expect(at(250)).toBeNull();
    expect([at(350)?.min, at(350)?.max]).toEqual([0, 1]);
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
