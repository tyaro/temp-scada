import { expect, it } from "vitest";
import cases from "../../../../examples/history-contract-cases.json";
import queryCases from "../../../../examples/history-query-cases.json";
import minmaxCases from "../../../../examples/history-minmax-cases.json";
import retentionCases from "../../../../examples/history-retention-cases.json";
import coverageCases from "../../../../examples/history-coverage-cases.json";
import {
  parseHistoryContract,
  validateHistoryContract,
} from "./history-contract";

it.each(cases)("shared Rust contract fixture: $name", (fixture) => {
  expect(validateHistoryContract(fixture.input)).toBe(fixture.expected);
  if (fixture.expected === "accepted") {
    const owned = parseHistoryContract(fixture.input);
    expect(owned).toEqual(fixture.input);
    expect(owned).not.toBe(fixture.input);
    expect(validateHistoryContract(JSON.parse(JSON.stringify(owned)))).toBe(
      "accepted",
    );
  } else
    expect(() => parseHistoryContract(fixture.input)).toThrow(
      `History contract: ${fixture.expected}`,
    );
});

it.each(queryCases)("SQLite query result fixture: $name", (fixture) => {
  expect(validateHistoryContract(fixture.expected)).toBe("accepted");
  expect(parseHistoryContract(fixture.expected)).toEqual(fixture.expected);
});

it.each(coverageCases)("SQLite coverage result fixture: $name", (fixture) => {
  expect(validateHistoryContract(fixture.expected)).toBe("accepted");
  expect(parseHistoryContract(fixture.expected)).toEqual(fixture.expected);
});

it.each(minmaxCases.filter((fixture) => fixture.expected))(
  "SQLite minmax result fixture: $name",
  (fixture) => {
    expect(validateHistoryContract(fixture.expected)).toBe("accepted");
    expect(parseHistoryContract(fixture.expected)).toEqual(fixture.expected);
  },
);

it("rejects non-finite numeric samples that JSON cannot represent", () => {
  const fixture = cases.find((row) => row.name === "sample-good-zero")!;
  for (const number of [NaN, Infinity, -Infinity]) {
    const value = structuredClone(fixture.input) as any;
    value.samples[0].value = number;
    expect(validateHistoryContract(value)).toBe("semantic");
  }
});

it("classifies uncloneable input without forwarding an input accessor's error", () => {
  const input = {
    get version() {
      throw Error("untrusted accessor");
    },
  };
  expect(validateHistoryContract(input)).toBe("schema");
  expect(() => parseHistoryContract(input)).toThrow("History contract: schema");
});

it.each(retentionCases)("SQLite retention result fixture: $name", (fixture) => {
  expect(validateHistoryContract(fixture.expected)).toBe("accepted");
  expect(parseHistoryContract(fixture.expected)).toEqual(fixture.expected);
});
