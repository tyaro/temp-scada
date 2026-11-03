import { test, expect } from "@playwright/test";
import sample from "../examples/recording.project.json" with { type: "json" };
import planCases from "../examples/recording-plan-cases.json" with { type: "json" };
import projectCases from "../examples/project-recording-cases.json" with { type: "json" };
import {
  openProject,
  downloadProject,
  downloadBytes,
} from "./helpers/project-files";

test("embedded desired fixtures agree in browser without remote schema resolution", async ({
  page,
}) => {
  const remote: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).hostname === "temp-scada.invalid")
      remote.push(r.url());
  });
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const modulePath = "/src/lib/project.ts",
      planPath = "/src/lib/__fixtures__/recording-plan-cases.ts",
      projectPath = "/src/lib/__fixtures__/project-recording-cases.ts",
      samplePath = "/src/lib/new-project.ts";
    const { parseProject, serializeProject } = await import(modulePath);
    const { cases, recordingPlanCaseInput } = await import(planPath);
    const { cases: extras, projectRecordingCase } = await import(projectPath);
    const { createProject } = await import(samplePath);
    function accepted(input: unknown) {
      try {
        const p = parseProject(JSON.stringify(input));
        if (
          serializeProject(parseProject(serializeProject(p))) !==
          serializeProject(p)
        )
          throw Error("round trip");
        return true;
      } catch {
        return false;
      }
    }
    return {
      plans: cases.map((fixture: any) => {
        try {
          return accepted({
            ...createProject(),
            recordingPlan: recordingPlanCaseInput(fixture),
          });
        } catch {
          return false;
        }
      }),
      projects: extras.map((fixture: any) =>
        accepted(projectRecordingCase(fixture)),
      ),
      omitted: createProject().recordingPlan === undefined,
    };
  });
  expect(result).toEqual({
    plans: planCases.map((c) => c.accepted),
    projects: projectCases.map((c) => c.accepted),
    omitted: true,
  });
  expect(remote).toEqual([]);
});

for (const enabled of [true, false])
  test(`ordinary App preserves desired settings (${enabled}) and rejects invalid replacement`, async ({
    page,
  }) => {
    await page.goto("/");
    const value = structuredClone(sample);
    value.recordingPlan.enabled = enabled;
    value.recordingPlan.group.members[0].externalName =
      " \r\n温度\u2028\u2029e\u0301 ";
    await openProject(page, {
      name: "recording.project.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(value)),
    });
    const first = JSON.parse(
      (await downloadBytes(await downloadProject(page))).toString(),
    );
    expect(first.recordingPlan).toEqual(value.recordingPlan);
    expect(first.manifest.schemaVersion).toBe("0.37.0");
    await openProject(page, {
      name: "round.project.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(first)),
    });
    expect(
      JSON.parse((await downloadBytes(await downloadProject(page))).toString()),
    ).toEqual(first);
    for (const invalid of [
      { ...first, recordingPlan: null },
      {
        ...first,
        manifest: {
          ...first.manifest,
          schemaVersion: "0.36.0",
          minRuntimeVersion: "0.36.0",
        },
      },
    ]) {
      await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
        name: "invalid.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(invalid)),
      });
      await expect(page.getByTestId("project-status")).not.toHaveText(
        "Project を読み込みました。",
      );
      expect(
        JSON.parse(
          (await downloadBytes(await downloadProject(page))).toString(),
        ),
      ).toEqual(first);
    }
    await expect(page.locator(".history-workspace")).toHaveCount(0);
  });
