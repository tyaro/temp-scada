import { expect, it } from "vitest";
import sample from "../../../../examples/minimal.project.json";
import { parseProject, serializeProject } from "./project";
import { applyCommand } from "./editor";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import { copyObjects, parseClipboard } from "./clipboard";
import { objectFormCommand } from "./designer/forms/object-form";
import { objectFormValues } from "./designer/numeric-properties";
function fixture() {
  const p = parseProject(JSON.stringify(sample)),
    s = p.screens[0],
    text = s.objects.find((o) => o.shape.type === "text")!;
  if (text.shape.type !== "text") throw new Error();
  text.shape.text = " alpha beta\n\n👨‍👩‍👧‍👦 ";
  return { p, s, text };
}
it("preserves original text, wrap and whitespace through file, clipboard and one Undo/Redo", () => {
  const { p, s, text } = fixture();
  if (text.shape.type !== "text") throw new Error();
  const before = serializeProject(p);
  const command = {
    type: "update" as const,
    screenId: s.id,
    objectId: text.id,
    patch: { textStyle: { ...text.shape.style, wrap: "word" as const } },
  };
  const result = recordEdit(p, emptyHistory(), command, "edit"),
    next = result.project.screens[0].objects.find((o) => o.id === text.id)!;
  expect((next.shape as any).text).toBe(text.shape.text);
  expect((next.shape as any).style.wrap).toBe("word");
  expect(parseProject(serializeProject(result.project))).toEqual(
    result.project,
  );
  const fragment = parseClipboard(
    copyObjects(result.project, s.id, [text.id], "wrap-test"),
  );
  expect(fragment.project.screens[0].objects[0].shape).toEqual(next.shape);
  const undo = travelHistory(result.project, result.history, "undo", "edit");
  expect(undo.project.screens).toEqual(p.screens);
  expect(
    travelHistory(undo.project, undo.history, "redo", "edit").project.screens,
  ).toEqual(result.project.screens);
  expect(applyCommand(result.project, command, "edit")).toBe(result.project);
  expect(serializeProject(p)).toBe(before);
});
it("keeps wrap through bulk styling and numeric edits, and explicit none clears it through the existing form", () => {
  const { p, s, text } = fixture();
  if (text.shape.type !== "text") throw new Error();
  text.shape.style.wrap = "word";
  const next = applyCommand(
    p,
    {
      type: "set-text-style",
      screenId: s.id,
      objectIds: [text.id],
      patch: { fontWeight: "bold" },
    },
    "edit",
  );
  const current = next.screens[0].objects.find((o) => o.id === text.id)!;
  expect((current.shape as any).style.wrap).toBe("word");
  const values = objectFormValues(current, false);
  values.textWrap = "none";
  const command = objectFormCommand(
    { get: (n) => values[n] ?? null, has: (n) => n in values },
    { screenId: s.id, definition: false, selected: current },
  );
  const cleared = applyCommand(next, command, "edit");
  expect(
    (cleared.screens[0].objects.find((o) => o.id === text.id)!.shape as any)
      .style.wrap,
  ).toBeUndefined();
  expect(
    (cleared.screens[0].objects.find((o) => o.id === text.id)!.shape as any)
      .text,
  ).toBe(text.shape.text);
});
it("rejects invalid wrap and previous schema without mutating the original or legitimizing invalid no-ops", () => {
  const { p, s, text } = fixture();
  if (text.shape.type !== "text") throw new Error();
  const before = serializeProject(p);
  const style = text.shape.style;
  for (const wrap of [null, true, "unknown", { mode: "word" }])
    expect(() =>
      applyCommand(
        p,
        {
          type: "update",
          screenId: s.id,
          objectId: text.id,
          patch: { textStyle: { ...style, wrap } as any },
        },
        "edit",
      ),
    ).toThrow();
  expect(serializeProject(p)).toBe(before);
  const previous = JSON.parse(before);
  previous.manifest.schemaVersion = "0.32.0";
  previous.manifest.minRuntimeVersion = "0.32.0";
  expect(() => parseProject(JSON.stringify(previous))).toThrow();
});
