// Test data recipes only; never imported by the normal App or the validator.
import cases from "../../../../../examples/trend-definition-cases.json";
import type { TrendDefinitions } from "../trend-definitions";
type Mutable<T> = { -readonly [P in keyof T]: Mutable<T[P]> };
export { cases };
export interface TrendCase {
  name: string;
  accepted: boolean;
  input?: unknown;
  json?: string;
  build?: string;
  count?: number;
  bytes?: number;
  floatNumbers?: boolean;
}
export function trendCaseInput(fixture: TrendCase): unknown {
  if (fixture.json !== undefined) return JSON.parse(fixture.json);
  if (!fixture.build) return structuredClone(fixture.input);
  const base = structuredClone(cases[0].input!) as Mutable<TrendDefinitions>;
  const row = base.definitions[0];
  if (fixture.build === "definitions") {
    base.definitions = Array.from({ length: fixture.count! }, (_, i) => ({
      ...structuredClone(row),
      id: `trend:${i}`,
    }));
  } else if (fixture.build === "pens") {
    row.pens = Array.from({ length: fixture.count! }, (_, i) => ({
      ...row.pens[0],
      id: `pen:${i}`,
      seriesId: `series:${i}`,
    }));
    row.maxPointsPerSeries = 1000;
  } else if (fixture.build === "byteBudget") {
    // floatNumbers changes serde_json's internal number variants in the native
    // recipe. JavaScript already represents 1 and 1.0 as the same Number.
    base.definitions = Array.from({ length: 128 }, (_, i) => ({
      ...row,
      id: `trend:${i}`,
      name: "x",
      maxPointsPerSeries: 1000,
      pens: Array.from({ length: 8 }, (_, j) => ({
        id: `pen:${j}`,
        seriesId: `series:${j}`,
        color: "#aB12Ef",
        label: "x",
      })),
    }));
    let remaining =
      fixture.bytes! -
      new TextEncoder().encode(JSON.stringify(base)).byteLength;
    if (remaining < 0) throw Error("recipe too small");
    const grow = () => {
      const add = Math.min(remaining, 2000);
      remaining -= add;
      return "x" + "😀".repeat(Math.floor(add / 4)) + "x".repeat(add % 4);
    };
    for (const definition of base.definitions) {
      definition.name = grow();
      for (const pen of definition.pens) pen.label = grow();
    }
    if (remaining) throw Error("recipe too large");
  } else throw Error("unknown recipe");
  return base;
}
