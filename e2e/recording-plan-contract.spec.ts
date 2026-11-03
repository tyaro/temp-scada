import { test, expect } from "@playwright/test";
import sample from "../examples/minimal.project.json" with { type: "json" };
import cases from "../examples/recording-plan-cases.json" with { type: "json" };
import { downloadBytes, downloadProject } from "./helpers/project-files";

test("desired recording contract agrees with native fixtures without remote schema resolution", async ({
  page,
}) => {
  const remoteSchemas: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).hostname === "temp-scada.invalid")
      remoteSchemas.push(request.url());
  });
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const modulePath = "/src/lib/recording-plan.ts",
      fixturePath = "/src/lib/__fixtures__/recording-plan-cases.ts";
    const { parseRecordingPlan, validateRecordingPlan } = await import(
      modulePath
    );
    const { cases, recordingPlanCaseInput } = await import(fixturePath);
    return cases.map((fixture: any) => {
      let input: unknown;
      try {
        input = recordingPlanCaseInput(fixture);
      } catch (error) {
        if (fixture.json === undefined) throw error;
        return { name: fixture.name, actual: false };
      }
      const actual = validateRecordingPlan(input);
      if (actual) {
        const owned = parseRecordingPlan(input);
        if (
          owned === input ||
          JSON.stringify(owned) !== JSON.stringify(input) ||
          !Object.isFrozen(owned.group.members[0])
        )
          throw Error("ownership/preservation");
      }
      return { name: fixture.name, actual };
    });
  });
  expect(result).toEqual(
    cases.map((row) => ({ name: row.name, actual: row.accepted })),
  );
  expect(remoteSchemas).toEqual([]);
});
test("desired ownership keeps member order and disabled settings without changing Project or starting history", async ({
  page,
}) => {
  await page.goto("/");
  const before = await downloadBytes(await downloadProject(page));
  const result = await page.evaluate(async (project) => {
    const modulePath = "/src/lib/recording-plan.ts",
      fixturePath = "/src/lib/__fixtures__/recording-plan-cases.ts",
      projectPath = "/src/lib/project.ts";
    const { parseRecordingPlan, validateRecordingPlan } = await import(
      modulePath
    );
    const { cases, recordingPlanCaseInput } = await import(fixturePath);
    const { parseProject } = await import(projectPath);
    const input = recordingPlanCaseInput(cases[0]);
    input.enabled = false;
    const owned = parseRecordingPlan(input);
    input.group.members[0].externalName = "changed";
    input.group.members.reverse();
    const embedded = parseProject(
      JSON.stringify({ ...project, recordingPlan: owned }),
    );
    return {
      name: owned.group.members[0].externalName,
      ids: owned.group.members.map((m: any) => m.memberId),
      enabled: owned.enabled,
      frozen: Object.isFrozen(owned.group),
      validAgain: validateRecordingPlan(owned),
      version: parseProject(JSON.stringify(project)).manifest.schemaVersion,
      embedded: embedded.recordingPlan,
    };
  }, sample);
  expect(result).toEqual({
    name: " 温度 ",
    ids: ["member:b", "member:a"],
    enabled: false,
    frozen: true,
    validAgain: true,
    version: "0.37.0",
    embedded: cases[0].input
      ? { ...cases[0].input, enabled: false }
      : undefined,
  });
  expect(await downloadBytes(await downloadProject(page))).toEqual(before);
  await expect(page.locator(".history-workspace")).toHaveCount(0);
  await expect(page.getByTestId("save-state")).toContainText(
    "書き出し要求後の変更なし",
  );
});
