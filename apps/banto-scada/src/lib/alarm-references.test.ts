import { describe, expect, it } from "vitest";
import sample from "../../../../examples/process.project.json";
import cases from "../../../../examples/alarm-value-color-cases.json";
import embeddedSample from "../../../../examples/embedded-screen.project.json";
import {
  parseProject,
  serializeProject,
  type Project,
  type ScreenObject,
} from "./project";
import { applyCommand } from "./editor";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import { copyObjects, parseClipboard } from "./clipboard";
import type { AlarmDefinition } from "./alarms";

/** 仕様: docs/design/graphics/alarm-value-color.md（V1 の保存・編集・参照の保護・clipboard） */

const TEMP = "0199f6a1-0000-7000-8000-000000000101";
const PUMP = "0199f6a1-0000-7000-8000-000000000102";
const TAG = { externalName: "Demo.Water.Tank01.Temperature" };

function insert(value: any, target: string, object: unknown) {
  target
    .split("/")
    .slice(1)
    .reduce((node: any, key: string) => node[key], value)
    .push(object);
}

describe("alarm value color contract", () => {
  it.each(cases)("$name", (item) => {
    const value = structuredClone(sample) as any;
    if ("alarms" in item) value.alarms = item.alarms;
    insert(value, item.target, item.object);
    const parse = () => parseProject(JSON.stringify(value));
    if (!item.valid) {
      expect(parse).toThrow((item as { error?: string }).error ?? "");
      // 拒否の理由が alarmColor にあること（外せば通る）。Symbol 定義の中は binding の検査。
      if (!("error" in item) && item.name !== "slot-bound text") {
        const control = structuredClone(sample) as any;
        if ("alarms" in item) control.alarms = item.alarms;
        const object = structuredClone(item.object) as any;
        delete object.shape.alarmColor;
        insert(control, item.target, object);
        expect(() => parseProject(JSON.stringify(control))).not.toThrow();
      }
      return;
    }
    expect(parseProject(serializeProject(parse()))).toEqual(value);
  });
});

const TEXT_ID = "0199f6aa-0000-7000-8000-00000000d001";
const BADGE_ID = "0199f6aa-0000-7000-8000-00000000d002";

function textObject(
  shape: Record<string, unknown> = {},
  id = TEXT_ID,
  name?: string,
): ScreenObject {
  return {
    id,
    order: 1000,
    x: 10,
    y: 10,
    width: 120,
    height: 24,
    rotation: 0,
    fill: "#1f2937",
    ...(name ? { name } : {}),
    shape: {
      type: "text",
      text: "0.0",
      style: { fontSize: 16, fontWeight: "normal", align: "right" },
      binding: TAG,
      ...shape,
    },
  } as ScreenObject;
}
function badgeObject(limit?: "hh"): ScreenObject {
  return {
    id: BADGE_ID,
    order: 1001,
    x: 10,
    y: 40,
    width: 48,
    height: 24,
    rotation: 0,
    shape: {
      type: "alarmBadge",
      alarmId: TEMP,
      ...(limit ? { limit } : {}),
      text: "HH",
      style: { fontSize: 12, fontWeight: "bold" },
    },
  } as ScreenObject;
}
function projectWith(...objects: ScreenObject[]): Project {
  const value = structuredClone(sample) as any;
  value.screens[0].objects.push(...objects);
  return parseProject(JSON.stringify(value));
}
const screenId = sample.screens[0].id;
const shapeOf = (project: Project, id = TEXT_ID) =>
  project.screens[0].objects.find((o) => o.id === id)!.shape as any;
const update = (
  project: Project,
  patch: Record<string, unknown>,
  objectId = TEXT_ID,
) =>
  applyCommand(project, { type: "update", screenId, objectId, patch }, "edit");

describe("alarm value color editing (V1)", () => {
  it("sets, keeps (no-op) and removes the alarm color with one Undo each", () => {
    const base = projectWith(textObject());
    let state = { project: base, history: emptyHistory() };
    const edit = (patch: Record<string, unknown>) => {
      state = recordEdit(
        state.project,
        state.history,
        { type: "update", screenId, objectId: TEXT_ID, patch },
        "edit",
      );
    };
    edit({ alarmColor: { alarmId: TEMP } });
    expect(shapeOf(state.project).alarmColor).toEqual({ alarmId: TEMP });
    expect(state.history.past).toHaveLength(1);
    // 同じ値は no-op（履歴が増えない）。
    const before = state.project;
    edit({ alarmColor: { alarmId: TEMP } });
    expect(state.project).toBe(before);
    expect(state.history.past).toHaveLength(1);
    edit({ alarmColor: { alarmId: PUMP } });
    expect(shapeOf(state.project).alarmColor).toEqual({ alarmId: PUMP });
    edit({ alarmColor: null });
    expect("alarmColor" in shapeOf(state.project)).toBe(false);
    expect(state.history.past).toHaveLength(3);
    state = travelHistory(state.project, state.history, "undo", "edit");
    expect(shapeOf(state.project).alarmColor).toEqual({ alarmId: PUMP });
    state = travelHistory(state.project, state.history, "undo", "edit");
    expect(shapeOf(state.project).alarmColor).toEqual({ alarmId: TEMP });
    state = travelHistory(state.project, state.history, "undo", "edit");
    expect("alarmColor" in shapeOf(state.project)).toBe(false);
  });
  it("refuses a definition that does not exist and a Text without a tag", () => {
    const base = projectWith(textObject());
    expect(() =>
      update(base, {
        alarmColor: { alarmId: "0199f6a1-0000-7000-8000-0000000001ff" },
      }),
    ).toThrow("数値の警報の色が指す警報の定義が見つかりません");
    const unbound = projectWith(textObject({ binding: undefined }));
    expect(() => update(unbound, { alarmColor: { alarmId: TEMP } })).toThrow(
      "警報の色はタグを表示するTextだけに設定できます",
    );
  });
  it("drops the alarm color with the tag binding in the same Undo", () => {
    const base = projectWith(textObject({ alarmColor: { alarmId: TEMP } }));
    const edited = recordEdit(
      base,
      emptyHistory(),
      { type: "update", screenId, objectId: TEXT_ID, patch: { binding: null } },
      "edit",
    );
    expect("alarmColor" in shapeOf(edited.project)).toBe(false);
    expect("binding" in shapeOf(edited.project)).toBe(false);
    expect(edited.history.past).toHaveLength(1);
    const undone = travelHistory(
      edited.project,
      edited.history,
      "undo",
      "edit",
    );
    expect(shapeOf(undone.project)).toMatchObject({
      binding: TAG,
      alarmColor: { alarmId: TEMP },
    });
  });
  it("refuses unbinding and setting the alarm color in one patch", () => {
    const base = projectWith(textObject());
    expect(() =>
      update(base, { binding: null, alarmColor: { alarmId: TEMP } }),
    ).toThrow("タグの割り当ての解除と警報の色の設定は同時に行えません");
  });
  it("refuses the bool display both ways", () => {
    const boolDisplay = {
      true: { text: "運転", color: "#16a34a" },
      false: { text: "停止", color: "#64748b" },
      unknownColor: "#d97706",
    };
    const colored = projectWith(textObject({ alarmColor: { alarmId: TEMP } }));
    expect(() => update(colored, { boolDisplay })).toThrow(
      "警報の色を持つ Text には bool の表示を設定できません",
    );
    const bool = projectWith(textObject({ boolDisplay }));
    expect(() => update(bool, { alarmColor: { alarmId: TEMP } })).toThrow(
      "bool の表示を持つ Text には警報の色を設定できません",
    );
    // 自動では消さない。
    expect(shapeOf(colored).alarmColor).toEqual({ alarmId: TEMP });
    expect(shapeOf(bool).boolDisplay).toEqual(boolDisplay);
  });
  it("refuses the alarm color inside a Symbol definition", () => {
    const value = structuredClone(sample) as any;
    const object = textObject({ binding: undefined });
    value.symbols[0].objects.push(object);
    const base = parseProject(JSON.stringify(value));
    expect(() =>
      applyCommand(
        base,
        {
          type: "update",
          screenId,
          definitionId: base.symbols[0].id,
          objectId: TEXT_ID,
          patch: { alarmColor: { alarmId: TEMP } },
        },
        "edit",
      ),
    ).toThrow("警報の色は画面直下のTextにだけ設定できます");
  });
});

describe("alarm definitions in use by value colors (V1)", () => {
  const remove = (project: Project, definitionId: string) =>
    applyCommand(
      project,
      { type: "remove-alarm-definition", definitionId },
      "edit",
    );
  const updateDefinition = (project: Project, definition: AlarmDefinition) =>
    applyCommand(
      project,
      { type: "update-alarm-definition", definition },
      "edit",
    );
  const toBit = (project: Project): AlarmDefinition => ({
    ...structuredClone(project.alarms!.definitions[0]),
    source: {
      kind: "bit",
      tag: "Demo.Water.Tank01.HighAlarm",
      activeWhen: true,
    },
    severity: "high",
  });
  it("lists the badge and the Text together when removing their definition", () => {
    const base = projectWith(
      textObject({ alarmColor: { alarmId: TEMP } }, TEXT_ID),
      badgeObject("hh"),
    );
    expect(() => remove(base, TEMP)).toThrow(
      `この警報は使用中です：${sample.screens[0].name}／数値の文字、${sample.screens[0].name}／警報の小札。先に小札・数値の文字から外すか、指す警報を変えてください。`,
    );
    const named = projectWith(
      textObject({ alarmColor: { alarmId: TEMP } }, TEXT_ID, "温度の値"),
    );
    expect(() => remove(named, TEMP)).toThrow(
      `この警報は使用中です：${sample.screens[0].name}／温度の値。`,
    );
    // 指していない定義は消せる。
    expect(remove(named, PUMP).alarms!.definitions.map((d) => d.id)).toEqual([
      TEMP,
    ]);
  });
  it("lists at most five users, then ほか", () => {
    const texts = Array.from({ length: 6 }, (_, i) => ({
      ...textObject(
        { alarmColor: { alarmId: TEMP } },
        `0199f6aa-0000-7000-8000-00000000d1${String(i).padStart(2, "0")}`,
        `値${i + 1}`,
      ),
      order: 1000 + i,
    }));
    const base = projectWith(...texts);
    expect(() => remove(base, TEMP)).toThrow(/値5 ほか。/);
  });
  it("changes the kind or limits only when no badge breaks", () => {
    const textOnly = projectWith(textObject({ alarmColor: { alarmId: TEMP } }));
    const bit = updateDefinition(textOnly, toBit(textOnly));
    expect(bit.alarms!.definitions[0].source.kind).toBe("bit");
    const noHh = structuredClone(textOnly.alarms!.definitions[0]);
    if (noHh.source.kind !== "threshold") throw new Error("threshold");
    delete noHh.source.limits.hh;
    expect(
      updateDefinition(textOnly, noHh).alarms!.definitions[0].source,
    ).not.toHaveProperty("limits.hh");
    const both = projectWith(
      textObject({ alarmColor: { alarmId: TEMP } }),
      badgeObject("hh"),
    );
    // 小札だけが壊れるので、今の小札の文言のまま。
    expect(() => updateDefinition(both, toBit(both))).toThrow(
      "この警報は警報の小札で使用中です：",
    );
    expect(() => updateDefinition(both, noHh)).toThrow(
      "この警報は警報の小札で使用中です：",
    );
  });
});

describe("alarm value color clipboard (V1)", () => {
  const paste = (destination: Project, text: string, origin = "b") =>
    applyCommand(
      destination,
      {
        type: "paste",
        screenId: destination.screens[0].id,
        text,
        origin,
        center: { x: 10, y: 10 },
      },
      "edit",
    );
  it("copies, cuts and pastes a Text onto the same definition id", () => {
    const base = projectWith(textObject({ alarmColor: { alarmId: PUMP } }));
    const text = copyObjects(base, screenId, [TEXT_ID], "a");
    expect(parseClipboard(text).project.alarms).toEqual({
      definitions: [base.alarms!.definitions.find((d) => d.id === PUMP)],
    });
    const pasted = paste(base, text);
    const object = pasted.screens[0].objects.at(-1)!;
    expect(object.id).not.toBe(TEXT_ID);
    expect((object.shape as any).alarmColor).toEqual({ alarmId: PUMP });
    // 定義は取り込まない。
    expect(pasted.alarms).toEqual(base.alarms);
    // 切り取り（削除してから貼り付け）でも同じ定義へつながる。
    const cut = applyCommand(
      base,
      { type: "remove", screenId, objectId: TEXT_ID },
      "edit",
    );
    const restored = paste(cut, text);
    expect(
      (restored.screens[0].objects.at(-1)!.shape as any).alarmColor,
    ).toEqual({ alarmId: PUMP });
  });
  it("attaches one definition when a badge and a Text point at it", () => {
    const base = projectWith(
      textObject({ alarmColor: { alarmId: TEMP } }),
      badgeObject("hh"),
    );
    const text = copyObjects(base, screenId, [TEXT_ID, BADGE_ID], "a");
    expect(
      parseClipboard(text).project.alarms!.definitions.map((d) => d.id),
    ).toEqual([TEMP]);
  });
  it("rejects clipboard definitions nothing points at", () => {
    const base = projectWith(textObject({ alarmColor: { alarmId: TEMP } }));
    const value = JSON.parse(copyObjects(base, screenId, [TEXT_ID], "a"));
    value.project.alarms.definitions.push(
      base.alarms!.definitions.find((d) => d.id === PUMP),
    );
    expect(() => parseClipboard(JSON.stringify(value))).toThrow(
      "clipboardの警報の定義の形式が不正です",
    );
  });
  it("refuses the whole paste when the destination lacks the definition", () => {
    const base = projectWith(textObject({ alarmColor: { alarmId: TEMP } }));
    const text = copyObjects(base, screenId, [TEXT_ID], "a");
    const without = parseProject(JSON.stringify(sample));
    delete without.alarms;
    const count = without.screens[0].objects.length;
    expect(() => paste(without, text)).toThrow(
      "貼り付け先の Project に、数値の文字が指す警報「T-01 温度」の定義がありません。",
    );
    expect(without.screens[0].objects).toHaveLength(count);
  });
  it("checks Texts on an embedded screen imported with the paste", () => {
    const value = structuredClone(embeddedSample) as any;
    value.alarms = structuredClone(sample.alarms);
    const source = value.screens[1];
    source.objects.push({
      ...textObject({ alarmColor: { alarmId: TEMP } }),
      order: Math.max(...source.objects.map((o: any) => o.order)) + 1,
    });
    const p = parseProject(JSON.stringify(value));
    const view = p.screens[0].objects.find(
      (o) => o.shape.type === "screenView",
    )!;
    const text = copyObjects(p, p.screens[0].id, [view.id], "a");
    expect(
      parseClipboard(text).project.alarms!.definitions.map((d) => d.id),
    ).toEqual([TEMP]);
    const pasted = paste(p, text);
    expect(pasted.screens).toHaveLength(3);
    expect(
      (
        pasted.screens[2].objects.find(
          (o) => o.shape.type === "text" && o.shape.alarmColor,
        )!.shape as any
      ).alarmColor,
    ).toEqual({ alarmId: TEMP });
    const without = structuredClone(p);
    without.screens[1].objects = without.screens[1].objects.filter(
      (o) => o.id !== TEXT_ID,
    );
    delete without.alarms;
    expect(() => paste(without, text)).toThrow(
      "数値の文字が指す警報「T-01 温度」の定義がありません",
    );
  });
});
