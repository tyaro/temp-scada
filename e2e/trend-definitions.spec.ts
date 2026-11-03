import { test, expect } from "@playwright/test";
import cases from "../examples/trend-definition-cases.json" with { type: "json" };
import sample from "../examples/minimal.project.json" with { type: "json" };

test("shared native/TS Trend definition cases agree in the browser without remote schema lookup", async ({
  page,
}) => {
  const remoteSchemas: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).hostname === "temp-scada.invalid")
      remoteSchemas.push(request.url());
  });
  await page.goto("/");
  const outcomes = await page.evaluate(async () => {
    const modulePath = "/src/lib/trend-definitions.ts";
    const fixturePath = "/src/lib/__fixtures__/trend-definition-cases.ts";
    const { validateTrendDefinitions, parseTrendDefinitions } = await import(
      modulePath
    );
    const { cases, trendCaseInput } = await import(fixturePath);
    return cases.map((fixture: any) => {
      let input: any;
      try {
        input = trendCaseInput(fixture);
      } catch (error) {
        if (fixture.json === undefined) throw error;
        return {
          name: fixture.name,
          expected: fixture.accepted,
          actual: false,
        };
      }
      if (
        fixture.build === "byteBudget" &&
        new TextEncoder().encode(JSON.stringify(input)).byteLength !==
          fixture.bytes
      )
        throw Error("byte-boundary recipe");
      const actual = validateTrendDefinitions(input);
      if (actual) {
        const owned = parseTrendDefinitions(input);
        if (
          owned === input ||
          JSON.stringify(owned) !== JSON.stringify(input) ||
          !Object.isFrozen(owned.definitions)
        )
          throw Error("owned frozen snapshot must preserve the document");
      }
      return { name: fixture.name, expected: fixture.accepted, actual };
    });
  });
  expect(outcomes).toEqual(
    cases.map((row) => ({
      name: row.name,
      expected: row.accepted,
      actual: row.accepted,
    })),
  );
  expect(remoteSchemas).toEqual([]);
});

test("Trend validation preserves names and colors and Project rejects invalid definitions", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async (project) => {
    const path = "/src/lib/trend-definitions.ts";
    const fixturePath = "/src/lib/__fixtures__/trend-definition-cases.ts";
    const projectPath = "/src/lib/project.ts";
    const { parseTrendDefinitions, validateTrendDefinitions } = await import(
      path
    );
    const { cases, trendCaseInput } = await import(fixturePath);
    const { parseProject } = await import(projectPath);
    const input = trendCaseInput(cases[0]);
    const owned = parseTrendDefinitions(input);
    input.definitions[0].name = "changed";
    input.definitions[0].pens[0].color = "#000000";
    // Normal local Project fixture, with no history service injection.
    const current = parseProject(JSON.stringify(project));
    let rejected = false;
    try {
      parseProject(
        JSON.stringify({
          ...project,
          trends: [{ ...owned.definitions[0], pens: [] }],
        }),
      );
    } catch {
      rejected = true;
    }
    return {
      name: owned.definitions[0].name,
      color: owned.definitions[0].pens[0].color,
      label: owned.definitions[0].pens[0].label,
      frozen: Object.isFrozen(owned.definitions[0].pens[0]),
      version: current.manifest.schemaVersion,
      rejected,
      validAgain: validateTrendDefinitions(owned),
    };
  }, sample);
  expect(result).toEqual({
    name: "工程温度",
    color: "#aB12Ef",
    label: " 温度 ",
    frozen: true,
    version: "0.37.0",
    rejected: true,
    validAgain: true,
  });
  await expect(page.locator(".history-trend")).toHaveCount(0);
});
