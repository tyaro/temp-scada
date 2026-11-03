import { test, expect } from "@playwright/test";
import fixtures from "../examples/recording-operations-cases.json" with { type: "json" };
import planCases from "../examples/recording-plan-cases.json" with { type: "json" };
import managementFixtures from "../examples/recording-management-cases.json" with { type: "json" };
import { downloadBytes, downloadProject } from "./helpers/project-files";

test("operation fixtures agree with Rust, preserve owned JSON and resolve no remote schemas", async ({
  page,
}) => {
  const remote: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).hostname === "temp-scada.invalid")
      remote.push(r.url());
  });
  await page.goto("/");
  const actual = await page.evaluate(async () => {
    const contractPath = "/src/lib/recording-operations-contract.ts",
      fixturePath = "/src/lib/__fixtures__/recording-operations-cases.ts";
    const contract = await import(contractPath),
      helper = await import(fixturePath);
    const frozen = (v: any): boolean =>
      v === null ||
      typeof v !== "object" ||
      (Object.isFrozen(v) && Object.values(v).every(frozen));
    return helper.operationsFixtures.cases.map((row: any) => {
      let input: unknown;
      try {
        input = helper.operationCaseInput(row);
      } catch (error) {
        if (row.json === undefined) throw error;
        return { name: row.name, accepted: false };
      }
      const accepted = contract.validateRecordingOperations(input);
      if (accepted) {
        const owned = contract.parseRecordingOperationsDocument(input);
        if (
          owned === input ||
          !frozen(owned) ||
          JSON.stringify(owned) !== JSON.stringify(input)
        )
          throw Error("ownership/preservation");
      }
      return { name: row.name, accepted };
    });
  });
  expect(actual).toEqual(
    fixtures.cases.map(({ name, accepted }) => ({ name, accepted })),
  );
  expect(remote).toEqual([]);
});
test("nested H5a and d3 context keep their independent validation in browser", async ({
  page,
}) => {
  await page.goto("/");
  const actual = await page.evaluate(async () => {
    const contractPath = "/src/lib/recording-operations-contract.ts",
      helperPath = "/src/lib/__fixtures__/recording-operations-cases.ts",
      planPath = "/src/lib/__fixtures__/recording-plan-cases.ts",
      managementPath = "/src/lib/__fixtures__/recording-management-cases.ts";
    const contract = await import(contractPath),
      helper = await import(helperPath),
      plans = await import(planPath),
      management = await import(managementPath);
    const planResults = helper.desiredBases.flatMap((base: string) =>
      plans.cases.map((row: any) => {
        let input: unknown;
        try {
          input = plans.recordingPlanCaseInput(row);
        } catch (error) {
          if (row.json === undefined) throw error;
          return { base, name: row.name, accepted: false };
        }
        return {
          base,
          name: row.name,
          accepted: contract.validateRecordingOperations(
            helper.nestedOperationPlan(base, input),
          ),
        };
      }),
    );
    const targets = management.fixtures.cases.map((row: any) => {
      let input: unknown;
      try {
        input = management.managementCaseInput(row);
      } catch (error) {
        if (row.json === undefined) throw error;
        return { name: row.name, accepted: false };
      }
      return {
        name: row.name,
        accepted: contract.validateRecordingOperations(
          helper.nestedOperationTarget(input),
        ),
      };
    });
    return { planResults, targets };
  });
  expect(actual.planResults).toEqual(
    [
      "change",
      "operation",
      "result",
      "reconciliation",
      "reconciliationResult",
    ].flatMap((base) =>
      planCases.map(({ name, accepted }) => ({ base, name, accepted })),
    ),
  );
  expect(actual.targets).toEqual(
    managementFixtures.cases.map((row) => ({
      name: row.name,
      accepted: row.accepted && row.base === "context",
    })),
  );
});
test("full echoed request equality keeps array order and ordinary App Project unchanged", async ({
  page,
}) => {
  await page.goto("/");
  const before = await downloadBytes(await downloadProject(page));
  const actual = await page.evaluate(async () => {
    const contractPath = "/src/lib/recording-operations-contract.ts",
      helperPath = "/src/lib/__fixtures__/recording-operations-cases.ts";
    const contract = await import(contractPath),
      helper = await import(helperPath);
    const same: any = {
      context: contract.sameRecordingOperationsContext,
      change: contract.sameRecordingChangeRequest,
      operation: contract.sameRecordingOperationRequest,
      reconciliation: contract.sameRecordingReconciliationRequest,
    };
    return helper.operationsFixtures.equalities.map((row: any) => {
      const a = structuredClone(helper.operationsFixtures.bases[row.base]),
        b = helper.operationCaseInput(row),
        before = JSON.stringify({ a, b });
      const equal = same[row.base](a, b);
      if (JSON.stringify({ a, b }) !== before) throw Error("mutation");
      return { name: row.name, equal };
    });
  });
  expect(actual).toEqual(
    fixtures.equalities.map((row) => ({ name: row.name, equal: row.expected })),
  );
  expect(await downloadBytes(await downloadProject(page))).toEqual(before);
  await expect(page.locator(".history-workspace")).toHaveCount(0);
  await expect(page.getByTestId("save-state")).toContainText(
    "書き出し要求後の変更なし",
  );
});
