import { expect, it } from "vitest";
import sample from "../../../../examples/minimal.project.json";
import saved from "../../../../examples/recording.project.json";
import {
  cases as planCases,
  recordingPlanCaseInput,
} from "./__fixtures__/recording-plan-cases";
import {
  cases,
  projectRecordingCase,
} from "./__fixtures__/project-recording-cases";
import { parseProject, serializeProject } from "./project";
import { copyObjects, parseClipboard } from "./clipboard";
import { applyCommand } from "./editor";
import { createProject } from "./new-project";

it.each(planCases)("embedded H5a contract: $name", (fixture) => {
  let plan: unknown;
  try {
    plan = recordingPlanCaseInput(fixture);
  } catch (e) {
    if (fixture.json === undefined) throw e;
    expect(fixture.accepted).toBe(false);
    return;
  }
  const input = JSON.stringify({ ...sample, recordingPlan: plan });
  if (fixture.accepted) {
    const p = parseProject(input);
    expect(p.recordingPlan).toEqual(plan);
    expect(parseProject(serializeProject(p))).toEqual(p);
  } else expect(() => parseProject(input)).toThrow();
});
it.each(cases)("shared Project recording contract: $name", (fixture) => {
  const input = projectRecordingCase(fixture),
    before = structuredClone(input);
  if (fixture.accepted) {
    const p = parseProject(JSON.stringify(input));
    expect(p.manifest.schemaVersion).toBe("0.37.0");
    expect(p.manifest.minRuntimeVersion).toBe("0.37.0");
    expect(parseProject(serializeProject(p))).toEqual(p);
    expect(p.recordingPlan).toEqual(input.recordingPlan);
  } else expect(() => parseProject(JSON.stringify(input))).toThrow();
  expect(input).toEqual(before);
});
it("keeps the desired snapshot across drawing edits and excludes it from partial clipboard", () => {
  const p = parseProject(JSON.stringify(saved)),
    s = p.screens[0];
  const text = copyObjects(p, s.id, [s.objects[0].id], "source");
  expect(parseClipboard(text).project.recordingPlan).toBeUndefined();
  const destination = createProject();
  const pasted = applyCommand(
    destination,
    {
      type: "paste",
      screenId: destination.screens[0].id,
      text,
      origin: "destination",
      center: { x: 20, y: 20 },
    },
    "edit",
  );
  expect(pasted.recordingPlan).toBeUndefined();
  const edited = applyCommand(
    p,
    { type: "update-project", name: "別の名前" },
    "edit",
  );
  expect(edited.recordingPlan).toEqual(p.recordingPlan);
  expect(edited.recordingPlan?.revision).toBe(p.recordingPlan?.revision);
  expect(createProject().recordingPlan).toBeUndefined();
});
