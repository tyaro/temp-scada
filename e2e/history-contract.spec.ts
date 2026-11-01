import { test, expect } from "@playwright/test";
import cases from "../examples/history-contract-cases.json" with { type: "json" };
import queryCases from "../examples/history-query-cases.json" with { type: "json" };
import minmaxCases from "../examples/history-minmax-cases.json" with { type: "json" };
import retentionJobCases from "../examples/history-retention-job-cases.json" with { type: "json" };
import retentionCases from "../examples/history-retention-cases.json" with { type: "json" };
import coverageCases from "../examples/history-coverage-cases.json" with { type: "json" };

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

test("SQLite coverage projection satisfies the browser history contract", async ({
  page,
}) => {
  await page.goto("/");
  const outcomes = await page.evaluate(async (fixtures) => {
    const modulePath = "/src/lib/history-contract.ts";
    const { validateHistoryContract, parseHistoryContract } = await import(
      modulePath
    );
    return fixtures.map((fixture) => {
      const owned = parseHistoryContract(fixture.expected);
      if (
        owned === fixture.expected ||
        JSON.stringify(owned) !== JSON.stringify(fixture.expected)
      )
        throw Error("coverage parsing must preserve an owned result");
      return {
        name: fixture.name,
        actual: validateHistoryContract(fixture.expected),
      };
    });
  }, coverageCases);
  expect(outcomes).toEqual(
    coverageCases.map((fixture) => ({
      name: fixture.name,
      actual: "accepted",
    })),
  );
});

test("SQLite minmax results satisfy the browser history contract", async ({
  page,
}) => {
  await page.goto("/");
  const fixtures = minmaxCases.filter((fixture) => fixture.expected);
  const outcomes = await page.evaluate(async (cases) => {
    const modulePath = "/src/lib/history-contract.ts";
    const { validateHistoryContract, parseHistoryContract } = await import(
      modulePath
    );
    return cases.map((fixture) => {
      const owned = parseHistoryContract(fixture.expected);
      if (
        owned === fixture.expected ||
        JSON.stringify(owned) !== JSON.stringify(fixture.expected)
      )
        throw Error("minmax result parsing must preserve an owned result");
      return {
        name: fixture.name,
        actual: validateHistoryContract(fixture.expected),
      };
    });
  }, fixtures);
  expect(outcomes).toEqual(
    fixtures.map((fixture) => ({ name: fixture.name, actual: "accepted" })),
  );
});

test("SQLite retention projection satisfies the browser history contract", async ({
  page,
}) => {
  await page.goto("/");
  const outcomes = await page.evaluate(async (fixtures) => {
    const modulePath = "/src/lib/history-contract.ts";
    const { validateHistoryContract, parseHistoryContract } = await import(
      modulePath
    );
    return fixtures.map((fixture) => {
      const owned = parseHistoryContract(fixture.expected);
      if (
        owned === fixture.expected ||
        JSON.stringify(owned) !== JSON.stringify(fixture.expected)
      )
        throw Error("retention parsing must preserve an owned result");
      return {
        name: fixture.name,
        actual: validateHistoryContract(fixture.expected),
      };
    });
  }, retentionCases);
  expect(outcomes).toEqual(
    retentionCases.map((fixture) => ({
      name: fixture.name,
      actual: "accepted",
    })),
  );
});

test("SQLite retention job projection satisfies the browser history contract", async ({
  page,
}) => {
  await page.goto("/");
  const outcomes = await page.evaluate(async (fixtures) => {
    const modulePath = "/src/lib/history-contract.ts";
    const { validateHistoryContract, parseHistoryContract } = await import(
      modulePath
    );
    return fixtures.map((fixture) => {
      const owned = parseHistoryContract(fixture.expected);
      if (
        owned === fixture.expected ||
        JSON.stringify(owned) !== JSON.stringify(fixture.expected)
      )
        throw Error("retention job parsing must preserve an owned result");
      return {
        name: fixture.name,
        actual: validateHistoryContract(fixture.expected),
      };
    });
  }, retentionJobCases);
  expect(outcomes).toEqual(
    retentionJobCases.map((fixture) => ({
      name: fixture.name,
      actual: "accepted",
    })),
  );
});
