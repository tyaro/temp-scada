import { expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import schema from "../../../../crates/scada-model/schema/trend-definition.schema.json";
import { cases, trendCaseInput } from "./__fixtures__/trend-definition-cases";
import {
  MAX_TREND_JSON_BYTES,
  parseTrendDefinitions,
  validateTrendDefinitions,
} from "./trend-definitions";

it.each(cases)("shared native/browser Trend case: $name", (fixture) => {
  let input: unknown;
  try {
    input = trendCaseInput(fixture);
  } catch (error) {
    if (fixture.json === undefined) throw error;
    expect(fixture.accepted).toBe(false);
    return;
  }
  expect(validateTrendDefinitions(input)).toBe(fixture.accepted);
  if (fixture.accepted) {
    const owned = parseTrendDefinitions(input);
    expect(owned).toEqual(input);
    expect(owned).not.toBe(input);
    expect(Object.isFrozen(owned.definitions)).toBe(true);
    expect(validateTrendDefinitions(JSON.parse(JSON.stringify(owned)))).toBe(
      true,
    );
  } else
    expect(() => parseTrendDefinitions(input)).toThrow(
      "Trend definitions: invalid",
    );
  if (fixture.build === "byteBudget")
    expect(new TextEncoder().encode(JSON.stringify(input)).byteLength).toBe(
      fixture.bytes,
    );
});
it("keeps caller ownership separate and freezes the full returned definition", () => {
  const input = trendCaseInput(cases[0]) as any;
  const owned = parseTrendDefinitions(input);
  input.definitions[0].name = "changed";
  input.definitions[0].pens[0].color = "#000000";
  expect(owned.definitions[0].name).toBe("工程温度");
  expect(owned.definitions[0].pens[0].color).toBe("#aB12Ef");
  expect(Object.isFrozen(owned.definitions[0].pens[0])).toBe(true);
  expect(Object.isFrozen(input)).toBe(false);
});
it("requires the canonical H1 resource rather than duplicating ID grammar", () => {
  expect(() => new Ajv2020().compile(schema)).toThrow();
});
it.each([undefined, NaN, Infinity, BigInt(1), () => {}, new Date(), new Map()])(
  "rejects non-JSON input at index %#",
  (input) => {
    expect(validateTrendDefinitions(input)).toBe(false);
  },
);
it("rejects accessor/custom-prototype/cycle/sparse/nonenumerable/symbol input without evaluating getters", () => {
  let reads = 0;
  const input = trendCaseInput(cases[0]) as any;
  Object.defineProperty(input.definitions[0], "name", {
    get: () => {
      reads++;
      throw Error("secret");
    },
    enumerable: true,
  });
  expect(validateTrendDefinitions(input)).toBe(false);
  expect(reads).toBe(0);
  const bad: any[] = [
    Object.assign(Object.create({}), { ...cases[0].input }),
    [, ,],
  ];
  const cyclic: any = {};
  cyclic.self = cyclic;
  bad.push(cyclic);
  const hidden = {};
  Object.defineProperty(hidden, "secret", { value: true });
  bad.push(hidden);
  bad.push({ [Symbol("secret")]: true });
  for (const row of bad) expect(validateTrendDefinitions(row)).toBe(false);
});
it("bounds large/deep structured input without changing existing History JSON contracts", () => {
  expect(
    validateTrendDefinitions({ text: "x".repeat(MAX_TREND_JSON_BYTES) }),
  ).toBe(false);
  let deep: unknown = null;
  for (let i = 0; i < 33; i++) deep = [deep];
  expect(validateTrendDefinitions(deep)).toBe(false);
  expect(validateTrendDefinitions(Array(250_000).fill(0))).toBe(false);
});
