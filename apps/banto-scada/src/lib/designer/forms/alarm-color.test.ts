import { describe, expect, it } from "vitest";
import type { AlarmDefinition } from "../../alarms";
import type { ScreenObject } from "../../project";
import {
  alarmColorCommand,
  alarmColorGroups,
  showsAlarmColorForm,
} from "./alarm-color";

const def = (id: string, tag: string, enabled = true): AlarmDefinition => ({
  id,
  name: `名${id}`,
  enabled,
  source: { kind: "bit", tag, activeWhen: true },
});
const text = (extra: object): ScreenObject["shape"] =>
  ({ type: "text", text: "", ...extra }) as unknown as ScreenObject["shape"];
const form = (value: string) => ({ get: () => value });

describe("alarm color form", () => {
  it("shows for bound Text without boolDisplay, or with alarmColor", () => {
    const binding = { externalName: "T" };
    expect(showsAlarmColorForm(text({ binding }), false)).toBe(true);
    expect(showsAlarmColorForm(text({}), false)).toBe(false);
    expect(showsAlarmColorForm(text({ binding }), true)).toBe(false);
    expect(showsAlarmColorForm(text({ binding, boolDisplay: {} }), false)).toBe(
      false,
    );
    expect(
      showsAlarmColorForm(
        text({ binding, boolDisplay: {}, alarmColor: { alarmId: "a" } }),
        false,
      ),
    ).toBe(true);
  });
  it("groups same-tag definitions first and marks disabled", () => {
    const groups = alarmColorGroups(
      [def("a", "X"), def("b", "T", false), def("c", "T")],
      "T",
    );
    expect(groups.map((g) => g.options.map((o) => o.label))).toEqual([
      ["名b（無効）", "名c"],
      ["名a"],
    ]);
    expect(alarmColorGroups([def("a", "X")], "T")).toHaveLength(1);
    expect(alarmColorGroups([], "T")).toEqual([]);
  });
  it("builds set and clear commands, rejecting stale targets", () => {
    const selected = {
      id: "o1",
      shape: text({ binding: { externalName: "T" } }),
    } as unknown as ScreenObject;
    const context = {
      generation: 1,
      screenId: "s",
      definition: false,
      selected,
    };
    const input = (v: string) => ({
      data: form(v),
      objectId: "o1",
      targetKey: "1:s:false",
    });
    expect(alarmColorCommand(input("a"), context)).toMatchObject({
      patch: { alarmColor: { alarmId: "a" } },
    });
    expect(alarmColorCommand(input(""), context)).toMatchObject({
      patch: { alarmColor: null },
    });
    expect(() =>
      alarmColorCommand({ ...input("a"), targetKey: "2:s:false" }, context),
    ).toThrow();
  });
});
