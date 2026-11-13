import { describe, expect, it } from "vitest";
import sample from "../../../../examples/read-presentation.project.json";
import cases from "../../../../examples/nav-button-cases.json";
import {
  parseProject,
  serializeProject,
  type NavButtonShape,
  type Project,
  type ScreenObject,
} from "./project";
import { applyCommand } from "./editor";
import {
  navButtonColors,
  navButtonAction,
  navButtonDisabled,
  navButtonIsCurrent,
  navTargetLabel,
  validateNavButtonShape,
} from "./nav-button";
import { copyObjects, parseClipboard } from "./clipboard";
import { objectFormCommand } from "./designer/forms/object-form";
import { objectFormValues } from "./designer/numeric-properties";
import { placementLabel } from "./placement-label";
import { canFlip } from "./flip";

it.each(cases)("nav button contract: $name", ({ target, valid, object }) => {
  const value = structuredClone(sample),
    node = target
      .split("/")
      .slice(1)
      .reduce((node, key) => node[key], value as any);
  node.push(object);
  if (valid)
    expect(
      parseProject(serializeProject(parseProject(JSON.stringify(value)))),
    ).toEqual(value);
  else expect(() => parseProject(JSON.stringify(value))).toThrow();
});

const fresh = () => parseProject(JSON.stringify(sample));
const shape = (patch: Partial<NavButtonShape> = {}): NavButtonShape => ({
  type: "navButton",
  target: { kind: "screen", screenId: "a" },
  label: "A",
  fontSize: 16,
  fill: "#334155",
  textColor: "#f8fafc",
  ...patch,
});

describe("nav button display", () => {
  it("highlights only a screen target equal to the shown screen", () => {
    expect(navButtonIsCurrent(shape(), "a")).toBe(true);
    expect(navButtonIsCurrent(shape(), "b")).toBe(false);
    expect(navButtonIsCurrent(shape({ target: { kind: "back" } }), "a")).toBe(
      false,
    );
    expect(navButtonIsCurrent(shape({ target: undefined }), "a")).toBe(false);
    expect(navButtonIsCurrent(shape(), undefined)).toBe(false);
  });
  it("uses the current colors when given, else the normal ones", () => {
    const plain = shape();
    expect(navButtonColors(plain, true)).toEqual({
      fill: "#334155",
      textColor: "#f8fafc",
    });
    const accent = shape({
      currentFill: "#0ea5e9",
      currentTextColor: "#000000",
    });
    expect(navButtonColors(accent, true)).toEqual({
      fill: "#0ea5e9",
      textColor: "#000000",
    });
    expect(navButtonColors(accent, false)).toEqual({
      fill: "#334155",
      textColor: "#f8fafc",
    });
  });
  it("moves only in the preview, and only to a screen", () => {
    expect(navButtonAction(shape(), true)).toEqual({
      kind: "screen",
      screenId: "a",
    });
    expect(navButtonAction(shape(), false)).toBeUndefined();
    expect(
      navButtonAction(shape({ target: { kind: "forward" } }), true),
    ).toBeUndefined();
    expect(navButtonDisabled(shape({ target: { kind: "back" } }), true)).toBe(
      true,
    );
    expect(navButtonDisabled(shape({ target: undefined }), true)).toBe(true);
    expect(navButtonDisabled(shape({ target: { kind: "back" } }), false)).toBe(
      false,
    );
    expect(navButtonDisabled(shape(), true)).toBe(false);
  });
  it("moves back and forward only with the operator view history", () => {
    const back = shape({ target: { kind: "back" } }),
      forward = shape({ target: { kind: "forward" } }),
      history = { canBack: true, canForward: false };
    expect(navButtonAction(back, true, history)).toEqual({ kind: "back" });
    expect(navButtonAction(forward, true, history)).toBeUndefined();
    expect(navButtonDisabled(back, true, history)).toBe(false);
    expect(navButtonDisabled(forward, true, history)).toBe(true);
    expect(navButtonAction(back, false, history)).toBeUndefined();
    expect(navButtonDisabled(shape(), true, history)).toBe(false);
  });
  it("names the target", () => {
    const screens = [{ id: "a", name: "概要" }];
    expect(navTargetLabel(shape().target, screens)).toBe("概要");
    expect(navTargetLabel(undefined, screens)).toBe("行き先未設定");
    expect(navTargetLabel({ kind: "back" }, screens)).toBe("戻る");
  });
  it("validates the Inspector content", () => {
    const project = { screens: [{ id: "a" }] } as Project;
    expect(() => validateNavButtonShape(shape(), project)).not.toThrow();
    expect(() =>
      validateNavButtonShape(
        shape({ target: { kind: "screen", screenId: "x" } }),
        project,
      ),
    ).toThrow(/見つかりません/);
    expect(() => validateNavButtonShape(shape({ label: "一\n二" }))).toThrow(
      /1行/,
    );
    expect(() =>
      validateNavButtonShape(
        shape({ label: `一${String.fromCharCode(0x2028)}二` }),
      ),
    ).toThrow(/1行/);
    expect(() => validateNavButtonShape(shape({ fontSize: 0 }))).toThrow();
    expect(() => validateNavButtonShape(shape({ fill: "red" }))).toThrow();
  });
  it("cannot be mirrored and has a layer name", () => {
    const object = { order: 3, shape: shape() } as ScreenObject;
    expect(canFlip(object)).toBe(false);
    expect(placementLabel(object)).toBe("画面切替 · 3");
  });
});

describe("nav button editing", () => {
  const add = (project: Project) =>
    applyCommand(
      project,
      { type: "add", screenId: project.screens[0].id, kind: "navButton" },
      "edit",
    );
  const added = (project: Project) => project.screens[0].objects.at(-1)!;
  it("adds an untargeted button without a root color", () => {
    const project = add(fresh());
    expect(added(project)).toMatchObject({
      width: 140,
      height: 40,
      shape: { type: "navButton", label: "画面切替" },
    });
    expect("fill" in added(project)).toBe(false);
    expect((added(project).shape as NavButtonShape).target).toBeUndefined();
    expect(() => parseProject(serializeProject(project))).not.toThrow();
  });
  it("cannot be added to a Symbol definition", () => {
    const project = fresh();
    expect(() =>
      applyCommand(
        project,
        {
          type: "add",
          screenId: project.screens[0].id,
          definitionId: project.symbols[0].id,
          kind: "navButton",
        },
        "edit",
      ),
    ).toThrow(/Symbol定義/);
  });
  it("applies the Inspector form and clears the current colors", () => {
    let project = add(fresh());
    const selected = added(project);
    // The Inspector shows no root color or color alpha for a nav button.
    const { colorAlpha: _alpha, ...values } = objectFormValues(selected, false);
    expect(values.navTarget).toBe("");
    expect(values.fill).toBeUndefined();
    const other = project.screens[1].id;
    const data = new Map(
      Object.entries({
        ...values,
        navTarget: `screen:${other}`,
        navLabel: "共通",
        navFontSize: "18",
        navFill: "#111111",
        navTextColor: "#eeeeee",
        navCurrentMode: "none",
      }),
    );
    project = applyCommand(
      project,
      objectFormCommand(data as unknown as FormData, {
        screenId: project.screens[0].id,
        definition: false,
        selected,
      }),
      "edit",
    );
    expect(added(project).shape).toEqual({
      type: "navButton",
      target: { kind: "screen", screenId: other },
      label: "共通",
      fontSize: 18,
      fill: "#111111",
      textColor: "#eeeeee",
    });
    const { colorAlpha: _backAlpha, ...current } = objectFormValues(
      added(project),
      false,
    );
    const back = new Map(Object.entries({ ...current, navTarget: "back" }));
    project = applyCommand(
      project,
      objectFormCommand(back as unknown as FormData, {
        screenId: project.screens[0].id,
        definition: false,
        selected: added(project),
      }),
      "edit",
    );
    expect((added(project).shape as NavButtonShape).target).toEqual({
      kind: "back",
    });
  });
  it("rejects a missing target screen in an update", () => {
    const project = add(fresh());
    expect(() =>
      applyCommand(
        project,
        {
          type: "update",
          screenId: project.screens[0].id,
          objectId: added(project).id,
          patch: {
            navButton: {
              ...(added(project).shape as NavButtonShape),
              target: { kind: "screen", screenId: "missing" },
            },
          },
        },
        "edit",
      ),
    ).toThrow(/見つかりません/);
  });
  it("blocks deleting a screen that a button goes to", () => {
    const base = fresh();
    // Leave out the sample's embedded view so only the button refers to the screen.
    base.screens[0].objects = base.screens[0].objects.filter(
      (o) => o.shape.type !== "screenView",
    );
    let project = add(base);
    const target = project.screens[1].id;
    (added(project).shape as NavButtonShape).target = {
      kind: "screen",
      screenId: target,
    };
    expect(() =>
      applyCommand(
        project,
        { type: "remove-screen", screenId: target },
        "edit",
      ),
    ).toThrow(/画面切替ボタンの行き先/);
    // A button on the removed screen itself does not block it.
    project.screens[0].objects.pop();
    project = applyCommand(
      project,
      { type: "remove-screen", screenId: target },
      "edit",
    );
    expect(project.screens).toHaveLength(1);
  });
});

describe("nav button clipboard", () => {
  function withButton(target: NavButtonShape["target"]) {
    const project = applyCommand(
      fresh(),
      { type: "add", screenId: fresh().screens[0].id, kind: "navButton" },
      "edit",
    );
    const button = project.screens[0].objects.at(-1)!;
    if (target) (button.shape as NavButtonShape).target = target;
    return { project, button };
  }
  const paste = (project: Project, text: string, origin = "origin") =>
    applyCommand(
      project,
      {
        type: "paste",
        screenId: project.screens[0].id,
        text,
        origin,
        center: { x: 100, y: 100 },
      },
      "edit",
    );
  it("keeps the target outside the copy aside and restores it in the same Project", () => {
    const { project, button } = withButton({
      kind: "screen",
      screenId: "0199f600-0000-7000-8000-000000000500",
    });
    const text = copyObjects(
      project,
      project.screens[0].id,
      [button.id],
      "origin",
    );
    const clip = parseClipboard(text);
    expect(
      (clip.project.screens[0].objects[0].shape as NavButtonShape).target,
    ).toBeUndefined();
    expect(clip.navTargets).toEqual({
      [button.id]: "0199f600-0000-7000-8000-000000000500",
    });
    const pasted = paste(project, text).screens[0].objects.at(-1)!;
    expect((pasted.shape as NavButtonShape).target).toEqual({
      kind: "screen",
      screenId: "0199f600-0000-7000-8000-000000000500",
    });
  });
  it("drops the target when the destination Project lacks the screen", () => {
    const { project, button } = withButton({
      kind: "screen",
      screenId: "0199f600-0000-7000-8000-000000000500",
    });
    const text = copyObjects(
      project,
      project.screens[0].id,
      [button.id],
      "origin",
    );
    const other = structuredClone(project);
    other.screens = other.screens.slice(0, 1);
    other.screens[0].objects = other.screens[0].objects.filter(
      (o) => o.shape.type !== "navButton" && o.shape.type !== "screenView",
    );
    const pasted = paste(other, text, "elsewhere").screens[0].objects.at(-1)!;
    expect(pasted.shape.type).toBe("navButton");
    expect((pasted.shape as NavButtonShape).target).toBeUndefined();
  });
  it("keeps a self target and back/forward without the side table", () => {
    const self = withButton({
      kind: "screen",
      screenId: fresh().screens[0].id,
    });
    const text = copyObjects(
      self.project,
      self.project.screens[0].id,
      [self.button.id],
      "origin",
    );
    expect(parseClipboard(text).navTargets).toBeUndefined();
    const back = withButton({ kind: "back" });
    const pasted = paste(
      back.project,
      copyObjects(
        back.project,
        back.project.screens[0].id,
        [back.button.id],
        "origin",
      ),
    ).screens[0].objects.at(-1)!;
    expect((pasted.shape as NavButtonShape).target).toEqual({ kind: "back" });
  });
  it("rejects a side table that points at anything but an untargeted button", () => {
    const { project, button } = withButton(undefined);
    const text = copyObjects(
      project,
      project.screens[0].id,
      [button.id],
      "origin",
    );
    const value = JSON.parse(text);
    value.navTargets = { other: "x" };
    expect(() => parseClipboard(JSON.stringify(value))).toThrow(/行き先/);
    value.navTargets = { [button.id]: "x" };
    expect(parseClipboard(JSON.stringify(value)).navTargets).toEqual({
      [button.id]: "x",
    });
  });
  it("cannot be pasted into a Symbol definition", () => {
    const { project, button } = withButton(undefined);
    const text = copyObjects(
      project,
      project.screens[0].id,
      [button.id],
      "origin",
    );
    expect(() =>
      applyCommand(
        project,
        {
          type: "paste",
          screenId: project.screens[0].id,
          definitionId: project.symbols[0].id,
          text,
          origin: "origin",
          center: { x: 10, y: 10 },
        },
        "edit",
      ),
    ).toThrow(/画面切替ボタン/);
  });
});
