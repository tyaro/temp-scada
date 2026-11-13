import { describe, expect, it } from "vitest";
import sample from "../../../../examples/read-presentation.project.json";
import cases from "../../../../examples/operator-frame-cases.json";
import {
  parseProject,
  serializeProject,
  type NavButtonShape,
  type Project,
} from "./project";
import { applyCommand } from "./editor";
import {
  frameScreenIds,
  normalizeOperatorFrame,
  operatorFrameRole,
  validateOperatorFrame,
} from "./operator-frame";
import { validateNavButtonShape } from "./nav-button";
import { operatorFrameFormCommand } from "./designer/forms/operator-frame-form";

const SCREEN_A = "0199f200-0000-7000-8000-000000000002";
const SCREEN_B = "0199f600-0000-7000-8000-000000000500";

function buildCase(item: (typeof cases)[number]) {
  const value = structuredClone(sample) as any;
  for (const id of (item as any).extraScreens ?? [])
    value.screens.push({
      id,
      name: "追加画面",
      width: 1920,
      height: 1080,
      background: "#ffffff",
      objects: [],
      folders: [],
      groups: [],
    });
  const button = (item as any).navButton;
  if (button)
    value.screens[0].objects.push({
      id: "0199f6ab-0000-7000-8000-000000000f01",
      order: 900,
      x: 10,
      y: 10,
      width: 120,
      height: 36,
      rotation: 0,
      shape: {
        type: "navButton",
        target: { kind: "screen", screenId: button.screenId },
        label: "枠",
        fontSize: 16,
        fill: "#1e293b",
        textColor: "#e2e8f0",
      },
    });
  if ((item as any).operatorFrame !== null)
    value.operatorFrame = (item as any).operatorFrame;
  return value;
}

it.each(cases)("operator frame contract: $name", (item) => {
  const value = buildCase(item);
  if (item.valid)
    expect(
      parseProject(serializeProject(parseProject(JSON.stringify(value)))),
    ).toEqual(value);
  else expect(() => parseProject(JSON.stringify(value))).toThrow();
});

const fresh = () => parseProject(JSON.stringify(sample));
const set = (project: Project, frame: Record<string, string>) =>
  applyCommand(project, { type: "set-operator-frame", frame }, "edit");

describe("operator frame helpers", () => {
  it("drops empty fields and the whole frame when nothing is left", () => {
    expect(
      normalizeOperatorFrame({ startScreenId: "", headerScreenId: "h" }),
    ).toEqual({ headerScreenId: "h" });
    expect(normalizeOperatorFrame({ startScreenId: "" })).toBeUndefined();
    expect(normalizeOperatorFrame({})).toBeUndefined();
  });
  it("collects header and footer screens only", () => {
    expect([
      ...frameScreenIds({ startScreenId: "s", headerScreenId: "h" }),
    ]).toEqual(["h"]);
    expect(frameScreenIds(undefined).size).toBe(0);
  });
  it("names how a screen is used", () => {
    const frame = { startScreenId: "s", headerScreenId: "h" };
    expect(operatorFrameRole(frame, "s")).toBe("開始画面");
    expect(operatorFrameRole(frame, "h")).toBe("ヘッダー画面");
    expect(operatorFrameRole(frame, "x")).toBeUndefined();
  });
  it("validates like the Project check", () => {
    const project = fresh();
    expect(() => validateOperatorFrame(undefined, project)).not.toThrow();
    expect(() =>
      validateOperatorFrame({ headerScreenId: "nope" }, project),
    ).toThrow(/見つかりません/);
    expect(() =>
      validateOperatorFrame(
        { startScreenId: SCREEN_A, footerScreenId: SCREEN_A },
        project,
      ),
    ).toThrow(/別の画面/);
  });
  it("turns the form into a command, treating empty as none", () => {
    const values: Record<string, string> = {
      startScreenId: "",
      headerScreenId: SCREEN_B,
    };
    const data = { get: (name: string) => values[name] ?? null };
    expect(operatorFrameFormCommand(data)).toEqual({
      type: "set-operator-frame",
      frame: { headerScreenId: SCREEN_B },
    });
  });
});

describe("operator frame editing", () => {
  it("sets and clears the frame, storing nothing when empty", () => {
    let project = set(fresh(), { headerScreenId: SCREEN_B });
    expect(project.operatorFrame).toEqual({ headerScreenId: SCREEN_B });
    expect(JSON.parse(serializeProject(project)).operatorFrame).toEqual({
      headerScreenId: SCREEN_B,
    });
    project = set(project, { startScreenId: "" });
    expect("operatorFrame" in project).toBe(false);
    expect(serializeProject(project)).not.toContain("operatorFrame");
  });
  it("rejects a frame that breaks the rules", () => {
    expect(() =>
      set(fresh(), { startScreenId: SCREEN_A, headerScreenId: SCREEN_A }),
    ).toThrow();
    expect(() => set(fresh(), { headerScreenId: "nope" })).toThrow();
  });
  it("rejects a header screen that a nav button already targets", () => {
    let project = applyCommand(
      fresh(),
      { type: "add", screenId: SCREEN_A, kind: "navButton" },
      "edit",
    );
    (project.screens[0].objects.at(-1)!.shape as NavButtonShape).target = {
      kind: "screen",
      screenId: SCREEN_B,
    };
    expect(() => set(project, { headerScreenId: SCREEN_B })).toThrow();
    project = set(project, { startScreenId: SCREEN_B });
    expect(project.operatorFrame).toEqual({ startScreenId: SCREEN_B });
  });
  it("rejects a nav button target that is a header or footer screen", () => {
    const project = set(fresh(), { footerScreenId: SCREEN_B });
    const shape: NavButtonShape = {
      type: "navButton",
      target: { kind: "screen", screenId: SCREEN_B },
      label: "x",
      fontSize: 16,
      fill: "#000000",
      textColor: "#ffffff",
    };
    expect(() => validateNavButtonShape(shape, project)).toThrow(
      /ヘッダー・フッター/,
    );
    expect(() =>
      validateNavButtonShape(
        { ...shape, target: { kind: "screen", screenId: SCREEN_A } },
        project,
      ),
    ).not.toThrow();
  });
  it("blocks removing a screen used by the frame and says why", () => {
    const base = applyCommand(
      fresh(),
      { type: "create-screen", name: "枠用", width: 800, height: 100 },
      "edit",
    );
    const SCREEN_B = base.screens.at(-1)!.id;
    for (const [key, role] of [
      ["startScreenId", "開始画面"],
      ["headerScreenId", "ヘッダー画面"],
      ["footerScreenId", "フッター画面"],
    ] as const) {
      const project = set(base, { [key]: SCREEN_B });
      expect(() =>
        applyCommand(
          project,
          { type: "remove-screen", screenId: SCREEN_B },
          "edit",
        ),
      ).toThrow(new RegExp(`運転表示の${role}`));
    }
    const cleared = set(set(base, { headerScreenId: SCREEN_B }), {});
    expect(
      applyCommand(
        cleared,
        { type: "remove-screen", screenId: SCREEN_B },
        "edit",
      ).screens,
    ).toHaveLength(base.screens.length - 1);
  });
  it("keeps the frame when another screen is duplicated or removed", () => {
    const project = set(fresh(), { headerScreenId: SCREEN_B });
    const duplicated = applyCommand(
      project,
      { type: "duplicate-screen", screenId: SCREEN_A },
      "edit",
    );
    expect(duplicated.operatorFrame).toEqual({ headerScreenId: SCREEN_B });
    expect(
      applyCommand(
        duplicated,
        { type: "remove-screen", screenId: duplicated.screens.at(-1)!.id },
        "edit",
      ).operatorFrame,
    ).toEqual({ headerScreenId: SCREEN_B });
  });
});
