import { test, expect } from "@playwright/test";
import fixtures from "../examples/recording-management-cases.json" with { type: "json" };
import planCases from "../examples/recording-plan-cases.json" with { type: "json" };
import { downloadBytes, downloadProject } from "./helpers/project-files";

test("recording management fixtures agree with Rust, including nested H5a, without remote schemas", async ({
  page,
}) => {
  const remote: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).hostname === "temp-scada.invalid")
      remote.push(request.url());
  });
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const contractPath = "/src/lib/recording-management-contract.ts",
      fixturePath = "/src/lib/__fixtures__/recording-management-cases.ts",
      planPath = "/src/lib/__fixtures__/recording-plan-cases.ts";
    const contract = await import(contractPath),
      helper = await import(fixturePath),
      plans = await import(planPath);
    const results = helper.fixtures.cases.map((row: any) => {
      let input: unknown;
      try {
        input = helper.managementCaseInput(row);
      } catch (error) {
        if (row.json === undefined) throw error;
        return { name: row.name, accepted: false };
      }
      const accepted = contract.validateRecordingManagement(input);
      if (accepted) {
        const owned = contract.parseRecordingManagementDocument(input);
        const frozen = (v: any): boolean =>
          v === null ||
          typeof v !== "object" ||
          (Object.isFrozen(v) && Object.values(v).every(frozen));
        if (
          owned === input ||
          !frozen(owned) ||
          JSON.stringify(owned) !== JSON.stringify(input)
        )
          throw Error("ownership/preservation");
      }
      return { name: row.name, accepted };
    });
    const nested = plans.cases.map((row: any) => {
      let input: unknown;
      try {
        input = plans.recordingPlanCaseInput(row);
      } catch (error) {
        if (row.json === undefined) throw error;
        return { name: row.name, accepted: false };
      }
      return {
        name: row.name,
        accepted: contract.validateRecordingManagement(
          helper.nestedPlanResponse(input),
        ),
      };
    });
    return { results, nested };
  });
  expect(result.results).toEqual(
    fixtures.cases.map(({ name, accepted }) => ({ name, accepted })),
  );
  expect(result.nested).toEqual(
    planCases.map(({ name, accepted }) => ({ name, accepted })),
  );
  expect(remote).toEqual([]);
});

test("comparison and full request equality preserve source and ordinary App Project", async ({
  page,
}) => {
  await page.goto("/");
  const before = await downloadBytes(await downloadProject(page));
  const result = await page.evaluate(async () => {
    const contractPath = "/src/lib/recording-management-contract.ts",
      fixturePath = "/src/lib/__fixtures__/recording-management-cases.ts";
    const contract = await import(contractPath),
      helper = await import(fixturePath);
    const comparisons = helper.fixtures.comparisons.map((row: any) => {
      const local = structuredClone(row.local),
        response = helper.managementCaseInput(row),
        before = JSON.stringify({ local, response });
      const result = contract.compareDesiredApplied(local, response);
      if (
        !Object.isFrozen(result) ||
        before !== JSON.stringify({ local, response })
      )
        throw Error("mutation");
      return { name: row.name, result };
    });
    const requests = helper.fixtures.requests.map((row: any) => ({
      name: row.name,
      result: contract.sameRecordingInspectionRequest(
        helper.fixtures.bases.request,
        helper.managementCaseInput(row),
      ),
    }));
    return { comparisons, requests };
  });
  expect(result.comparisons).toEqual(
    fixtures.comparisons.map((row) => ({
      name: row.name,
      result: row.expected,
    })),
  );
  expect(result.requests).toEqual(
    fixtures.requests.map((row) => ({ name: row.name, result: row.expected })),
  );
  expect(await downloadBytes(await downloadProject(page))).toEqual(before);
  await expect(page.locator(".history-workspace")).toHaveCount(0);
  await expect(page.getByTestId("save-state")).toContainText(
    "書き出し要求後の変更なし",
  );
});
