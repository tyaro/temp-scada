import { test, expect } from "@playwright/test";
import cases from "../examples/history-contract-cases.json" with { type: "json" };
import queryCases from "../examples/history-query-cases.json" with { type: "json" };

test("shared Historian contracts have the same outcomes in the browser", async ({
  page,
}) => {
  await page.goto("/");
  const outcomes = await page.evaluate(async (fixtures) => {
    const modulePath = "/src/lib/history-contract.ts";
    const { validateHistoryContract, parseHistoryContract } = await import(
      modulePath
    );
    return fixtures.map((fixture) => {
      const actual = validateHistoryContract(fixture.input);
      if (actual === "accepted") {
        const owned = parseHistoryContract(fixture.input);
        if (
          JSON.stringify(owned) !== JSON.stringify(fixture.input) ||
          owned === fixture.input
        )
          throw Error("contract parsing must preserve an owned document");
      }
      return { name: fixture.name, expected: fixture.expected, actual };
    });
  }, cases);
  expect(outcomes).toEqual(
    cases.map((fixture) => ({
      name: fixture.name,
      expected: fixture.expected,
      actual: fixture.expected,
    })),
  );
});

test("SQLite raw query results satisfy the browser history contract", async ({
  page,
}) => {
  await page.goto("/");
  const outcomes = await page.evaluate(async (fixtures) => {
    const modulePath = "/src/lib/history-contract.ts";
    const { validateHistoryContract, parseHistoryContract } = await import(
      modulePath
    );
    return fixtures.map((fixture) => {
      const actual = validateHistoryContract(fixture.expected);
      const owned = parseHistoryContract(fixture.expected);
      if (
        owned === fixture.expected ||
        JSON.stringify(owned) !== JSON.stringify(fixture.expected)
      )
        throw Error("SQLite result parsing must preserve an owned result");
      return { name: fixture.name, actual };
    });
  }, queryCases);
  expect(outcomes).toEqual(
    queryCases.map((fixture) => ({ name: fixture.name, actual: "accepted" })),
  );
});
