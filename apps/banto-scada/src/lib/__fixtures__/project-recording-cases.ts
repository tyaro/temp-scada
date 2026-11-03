import sample from "../../../../../examples/recording.project.json";
import legacy from "../../../../../examples/legacy.project.json";
import cases from "../../../../../examples/project-recording-cases.json";
export { cases };
export function projectRecordingCase(fixture: {
  ops?: { path: string; value: unknown }[];
  omit?: boolean;
  legacy?: boolean;
  largeCanvas?: boolean;
}): any {
  const project: any = structuredClone(fixture.legacy ? legacy : sample);
  for (const op of fixture.ops ?? []) {
    const keys = op.path.slice(1).split("/");
    const key = keys.pop()!;
    keys.reduce((owner, part) => owner[part], project)[key] = structuredClone(
      op.value,
    );
  }
  if (fixture.omit) delete project.recordingPlan;
  if (fixture.largeCanvas) {
    const template = project.screens[0].objects[2];
    for (let i = 0; i < 100; i++)
      project.screens[0].objects.push({
        ...structuredClone(template),
        id: `0199f000-0000-7000-8000-${String(1000 + i).padStart(12, "0")}`,
        order: 1000 + i,
        shape: { ...template.shape, text: "x".repeat(1000) },
      });
  }
  return project;
}
