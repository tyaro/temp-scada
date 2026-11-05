import { test, expect } from "@playwright/test";
import { downloadBytes, downloadProject } from "./helpers/project-files";

test("coordinator-v2 preserves reply and task facts without changing the Project", async ({
  page,
}) => {
  await page.goto("/");
  const before = await downloadBytes(await downloadProject(page));
  const result = await page.evaluate(async () => {
    const path = "/src/lib/__fixtures__/recording-wire-coordinator-v2-cases.ts";
    const cases = await import(path);
    const usage = [];
    for (const scenario of cases.coordinatorV2Cases.scenarios)
      usage.push(await cases.runCoordinatorV2Scenario(scenario));
    return { count: cases.coordinatorV2Cases.scenarios.length, usage };
  });
  expect(result.count).toBe(3);
  expect(result.usage.every((v) => v.tracks === 1 && v.attempts === 1)).toBe(
    true,
  );
  expect(await downloadBytes(await downloadProject(page))).toEqual(before);
});
