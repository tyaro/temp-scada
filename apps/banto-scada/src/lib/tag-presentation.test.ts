import { expect, it } from "vitest";
import { presentNumeric, type NumericReading } from "./tag-presentation";
import { levelFromReading } from "./level";
it("shows only finite Good values, including zero and negative numbers", () => {
  for (const numericValue of [0, -4.5, 12.34])
    expect(
      presentNumeric({ state: "resolved", quality: "good", numericValue }),
    ).toEqual({
      state: "good",
      label: "Good",
      text: String(numericValue),
    });
});
it("never shows a retained numeric value as current when quality is Stale or Bad", () => {
  for (const quality of ["stale", "bad"] as const) {
    const view = presentNumeric({
      state: "resolved",
      quality,
      numericValue: 123.45,
    });
    expect(view.state).toBe(quality);
    expect(view.text).not.toContain("123.45");
    expect(view.text).toContain(view.label);
  }
});
it("distinguishes disconnected, unresolved, invalid and missing values", () => {
  expect(presentNumeric().text).toBe("-- · 未接続");
  for (const state of ["disconnected", "unresolved", "invalid"] as const) {
    const view = presentNumeric({ state });
    expect(view.state).toBe(state);
    expect(view.text).toContain(view.label);
  }
  for (const numericValue of [null, NaN, Infinity, -Infinity])
    expect(
      presentNumeric({ state: "resolved", quality: "good", numericValue })
        .state,
    ).toBe("invalid");
});
it("a reconnect must supply a new valid reading before showing a number again", () => {
  const sequence: (NumericReading | undefined)[] = [
    { state: "resolved", quality: "good", numericValue: 42 },
    { state: "disconnected" },
    { state: "unresolved" },
    undefined,
    { state: "resolved", quality: "good", numericValue: 0 },
  ];
  expect(sequence.map((value) => presentNumeric(value).text)).toEqual([
    "42",
    "-- · 未接続",
    "-- · 未解決",
    "-- · 未接続",
    "0",
  ]);
});

import runtimeCases from "../../../../examples/runtime-reading-cases.json";
it("renders the reading DTO fixtures also checked by the Rust SDK adapter", () => {
  for (const fixture of runtimeCases)
    expect(
      presentNumeric(fixture.reading as NumericReading).text,
      fixture.name,
    ).toBe(fixture.display);
});
it("shows a Good bit reading as true or false and keeps the SIM prefix", () => {
  for (const boolValue of [true, false])
    expect(
      presentNumeric(
        { state: "resolved", quality: "good", numericValue: null, boolValue },
        { decimals: 2, unit: "kW" },
      ),
    ).toEqual({ state: "good", label: "Good", text: String(boolValue) });
  const simulated = presentNumeric({
    state: "resolved",
    quality: "good",
    numericValue: null,
    boolValue: false,
    provenance: {
      catalogRevision: 1,
      runId: 1,
      collectionMode: "all_simulation",
      valueSource: "simulation",
      sourceTimestampMs: 1,
    },
  } as NumericReading);
  expect(simulated.text).toBe("SIM · false");
  for (const quality of ["stale", "bad"] as const)
    expect(
      presentNumeric({ state: "resolved", quality, numericValue: null }).text,
    ).toContain("--");
});
it("a level treats a bit reading as an invalid value", () => {
  const view = levelFromReading(
    { min: 0, max: 100 },
    { state: "resolved", quality: "good", numericValue: null, boolValue: true },
  );
  expect(view.description).toBe("-- · 値が不正");
});
