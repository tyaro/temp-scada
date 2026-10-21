import { expect, it } from "vitest";
import sample from "../../../../examples/connection.project.json";
import { parseProject } from "./project";
import { lineConnectionCommand } from "./designer/forms/line-connection";
import { emptyHistory, recordEdit, travelHistory } from "./history";
const project = () => parseProject(JSON.stringify(sample));
function fixture() {
  const p = project(),
    screen = p.screens[0],
    selected = screen.objects[2];
  const context = {
    generation: 7,
    screenId: screen.id,
    definition: false,
    selected,
    objects: screen.objects,
  };
  const input = {
    connected: true,
    objectId: selected.id,
    targetKey: `7:${screen.id}:false`,
    endpoint: "start",
    data: {
      get: (key: string) =>
        key === "connectionTarget" ? screen.objects[1].id : "top",
    },
  };
  return { p, input, context };
}
it("applies a typed target and anchor as one undoable connection edit", () => {
  const { p, input, context } = fixture();
  const command = lineConnectionCommand(input, context);
  const result = recordEdit(p, emptyHistory(), command, "edit");
  const shape = result.project.screens[0].objects[2].shape;
  expect(shape).toMatchObject({
    connections: {
      start: { targetObjectId: p.screens[0].objects[1].id, anchor: "top" },
    },
  });
  expect(result.history.past).toHaveLength(1);
  expect(
    travelHistory(result.project, result.history, "undo", "edit").project
      .screens,
  ).toEqual(p.screens);
});
it("disconnects explicitly, ignoring the now-unused anchor field", () => {
  const { p, input, context } = fixture();
  const command = lineConnectionCommand(
    {
      ...input,
      data: { get: (key) => (key === "connectionTarget" ? "" : null) },
    },
    context,
  );
  const result = recordEdit(p, emptyHistory(), command, "edit");
  expect(result.project.screens[0].objects[2].shape).toMatchObject({
    connections: {
      end: (p.screens[0].objects[2].shape as any).connections.end,
    },
  });
  expect(
    (result.project.screens[0].objects[2].shape as any).connections,
  ).not.toHaveProperty("start");
  expect((result.project.screens[0].objects[2].shape as any).points).toEqual(
    (p.screens[0].objects[2].shape as any).points,
  );
});
it("rejects stale/disconnected forms, other owners, non-line selection and definition mode", () => {
  const { input, context } = fixture();
  for (const patch of [
    { connected: false },
    { objectId: "missing" },
    { targetKey: `6:${context.screenId}:false` },
    { targetKey: "7:other:false" },
    { endpoint: "middle" },
  ])
    expect(() =>
      lineConnectionCommand({ ...input, ...patch }, context),
    ).toThrow();
  expect(() =>
    lineConnectionCommand(input, { ...context, definition: true }),
  ).toThrow();
  expect(() =>
    lineConnectionCommand(input, { ...context, selected: context.objects[0] }),
  ).toThrow();
});
it("rejects missing/non-Symbol targets, invalid anchors and incomplete form data", () => {
  const { input, context } = fixture();
  for (const values of [
    { connectionTarget: "missing", connectionAnchor: "top" },
    { connectionTarget: context.selected.id, connectionAnchor: "top" },
    { connectionTarget: context.objects[0].id, connectionAnchor: "inlet" },
    { connectionTarget: null, connectionAnchor: "top" },
  ])
    expect(() =>
      lineConnectionCommand(
        {
          ...input,
          data: { get: (key) => values[key as keyof typeof values] },
        },
        context,
      ),
    ).toThrow();
});
it("does not create Undo for an unchanged connection selection", () => {
  const { p, input, context } = fixture();
  const command = lineConnectionCommand(
    {
      ...input,
      data: {
        get: (key) =>
          key === "connectionTarget" ? context.objects[0].id : "right",
      },
    },
    context,
  );
  const result = recordEdit(p, emptyHistory(), command, "edit");
  expect(result.project).toBe(p);
  expect(result.history.past).toHaveLength(0);
});

it("rejects an IME draft during prevalidation before any form can commit", () => {
  const { input, context } = fixture();
  expect(() =>
    lineConnectionCommand({ ...input, composing: true }, context),
  ).toThrow("文字変換");
});
