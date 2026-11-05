import { test, expect } from "@playwright/test";
import { downloadBytes, downloadProject } from "./helpers/project-files";

test("local-v2 delivers only stored terminal tokens without changing the Project", async ({
  page,
}) => {
  await page.goto("/");
  const before = await downloadBytes(await downloadProject(page));
  const result = await page.evaluate(async () => {
    const path = "/src/lib/__fixtures__/recording-wire-local-v2-cases.ts";
    const cases = await import(path);
    const usage = [];
    for (const scenario of cases.localV2Cases.scenarios)
      usage.push(await cases.runLocalV2Scenario(scenario));
    return { count: cases.localV2Cases.scenarios.length, usage };
  });
  expect(result.count).toBe(3);
  expect(result.usage.every((v) => v.pending === 0 && v.delivered > 0)).toBe(
    true,
  );
  expect(await downloadBytes(await downloadProject(page))).toEqual(before);
});
