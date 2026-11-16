import { describe, expect, it } from "vitest";
import sample from "../../../../examples/process.project.json";
import cases from "../../../../examples/alarm-badge-cases.json";
import {
  parseProject,
  serializeProject,
  type AlarmBadgeShape,
  type Project,
} from "./project";
import { applyCommand } from "./editor";
import {
  alarmBadgeConditionId,
  alarmBadgeTargets,
  newAlarmBadgeShape,
} from "./alarm-badge";
import { objectFormCommand } from "./designer/forms/object-form";
import { objectFormValues } from "./designer/numeric-properties";
import { canFlip } from "./flip";
import { shapeSlotNames, shapeTagBindings } from "./shape-bindings";
import { createMockAlarmFeed } from "./mock-alarm-feed";
import type { AlarmDefinition } from "./alarms";

const TEMP = "0199f6a1-0000-7000-8000-000000000101";
const PUMP = "0199f6a1-0000-7000-8000-000000000102";

it.each(cases)("alarm badge contract: $name", (item) => {
  const value = structuredClone(sample) as any;
  if ("alarms" in item) value.alarms = item.alarms;
  item.target
    .split("/")
    .slice(1)
    .reduce((node: any, key: string) => node[key], value)
    .push(item.object);
  const parse = () => parseProject(JSON.stringify(value));
  if (!item.valid) {
    expect(parse).toThrow((item as { error?: string }).error ?? "");
    return;
  }
  expect(parseProject(serializeProject(parse()))).toEqual(value);
});

describe("alarm badge targets", () => {
  const definitions = sample.alarms.definitions as AlarmDefinition[];
  it("lists each threshold limit from HH down and bit alarms by name", () => {
    expect(alarmBadgeTargets(definitions)).toEqual([
      {
        alarmId: TEMP,
        limit: "hh",
        value: `${TEMP}:hh`,
        label: "T-01 温度 HH",
      },
      { alarmId: TEMP, limit: "h", value: `${TEMP}:h`, label: "T-01 温度 H" },
      { alarmId: TEMP, limit: "l", value: `${TEMP}:l`, label: "T-01 温度 L" },
      { alarmId: PUMP, value: PUMP, label: "P-01 停止" },
    ]);
  });
  it("uses the condition id of the host", () => {
    expect(alarmBadgeConditionId({ alarmId: TEMP, limit: "hh" })).toBe(
      `${TEMP}:hh`,
    );
    expect(alarmBadgeConditionId({ alarmId: PUMP })).toBe(PUMP);
  });
  it("defaults to the first target, ALM for a bit alarm", () => {
    expect(newAlarmBadgeShape({ alarms: { definitions } })).toEqual({
      type: "alarmBadge",
      alarmId: TEMP,
      limit: "hh",
      text: "HH",
      style: { fontSize: 12, fontWeight: "bold" },
    });
    expect(
      newAlarmBadgeShape({ alarms: { definitions: [definitions[1]] } }),
    ).toMatchObject({ alarmId: PUMP, text: "ALM" });
    expect(
      "limit" in
        newAlarmBadgeShape({ alarms: { definitions: [definitions[1]] } }),
    ).toBe(false);
    expect(() => newAlarmBadgeShape({})).toThrow("警報の定義がありません");
  });
});

describe("alarm badge editing", () => {
  const project = () => parseProject(JSON.stringify(sample));
  const screenId = sample.screens[0].id;
  function added(base = project()) {
    const next = applyCommand(
      base,
      { type: "add", screenId, kind: "alarmBadge" },
      "edit",
    );
    return { next, object: next.screens[0].objects.at(-1)! };
  }
  it("adds a 48×24 badge without a fill that cannot flip and reads no tag", () => {
    const { next, object } = added();
    expect(object).toMatchObject({ width: 48, height: 24 });
    expect("fill" in object).toBe(false);
    expect(object.shape).toEqual(
      newAlarmBadgeShape(next) satisfies AlarmBadgeShape,
    );
    expect(parseProject(serializeProject(next))).toEqual(next);
    expect(canFlip(object)).toBe(false);
    expect(shapeTagBindings(object.shape)).toEqual([]);
    expect(shapeSlotNames(object.shape)).toEqual([]);
  });
  it("cannot be added without alarm definitions or inside a Symbol", () => {
    const empty = project();
    delete empty.alarms;
    expect(() =>
      applyCommand(
        empty,
        { type: "add", screenId, kind: "alarmBadge" },
        "edit",
      ),
    ).toThrow("警報の定義がありません");
    const base = project();
    expect(() =>
      applyCommand(
        base,
        {
          type: "add",
          screenId: base.symbols[0].id,
          kind: "alarmBadge",
        },
        "edit",
      ),
    ).toThrow();
  });
  it("applies the Inspector form to another target and text", () => {
    const { next, object } = added();
    const data = new Map(Object.entries(objectFormValues(object, false)));
    expect(data.get("alarmBadgeTarget")).toBe(`${TEMP}:hh`);
    expect(data.has("fill")).toBe(false);
    // 色の欄は Inspector に出さない（色は状態ごとに固定）。
    data.delete("colorAlpha");
    data.set("alarmBadgeTarget", PUMP);
    data.set("alarmBadgeText", "停止\n中");
    data.set("alarmBadgeFontSize", "16");
    data.set("alarmBadgeFontWeight", "normal");
    const run = (form: Map<string, string>, base: Project = next) =>
      applyCommand(
        base,
        objectFormCommand(
          { get: (key) => form.get(key) ?? null, has: (key) => form.has(key) },
          { screenId, definition: false, selected: object },
        ),
        "edit",
      );
    const after = run(data);
    expect(
      after.screens[0].objects.find((o) => o.id === object.id)!.shape,
    ).toEqual({
      type: "alarmBadge",
      alarmId: PUMP,
      text: "停止 中",
      style: { fontSize: 16, fontWeight: "normal" },
    });
    data.set("alarmBadgeTarget", `${TEMP}:ll`);
    expect(() => run(data)).toThrow(
      "警報の小札が指す限界が警報の定義にありません",
    );
    data.set("alarmBadgeTarget", `${TEMP}:xx`);
    expect(() => run(data)).toThrow("警報の小札が指す警報を選択してください");
  });
  it("refuses removing an alarm or a limit a badge points at, naming the badge", () => {
    const { next } = added();
    expect(() =>
      applyCommand(
        next,
        { type: "remove-alarm-definition", definitionId: TEMP },
        "edit",
      ),
    ).toThrow("この警報は警報の小札で使用中です：");
    const definition = structuredClone(
      next.alarms!.definitions[0],
    ) as AlarmDefinition;
    if (definition.source.kind !== "threshold") throw new Error("threshold");
    delete definition.source.limits.hh;
    expect(() =>
      applyCommand(
        next,
        { type: "update-alarm-definition", definition },
        "edit",
      ),
    ).toThrow("警報の小札で使用中です");
    // 指していない限界は外せる。
    const other = structuredClone(next.alarms!.definitions[0]);
    if (other.source.kind !== "threshold") throw new Error("threshold");
    delete other.source.limits.l;
    expect(
      applyCommand(
        next,
        { type: "update-alarm-definition", definition: other },
        "edit",
      ).alarms!.definitions[0],
    ).toEqual(other);
  });
});

describe("mock alarm feed", () => {
  it("serves the set snapshot after a lagged refresh and forwards events", async () => {
    const { feed, control } = createMockAlarmFeed();
    expect((await feed.snapshot()).status).not.toBe("running");
    const lagged: number[] = [];
    const changes: number[] = [];
    const off = await feed.subscribe(
      (change) => changes.push(change.seq),
      () => lagged.push(1),
    );
    control.setSnapshot({
      ...(await feed.snapshot()),
      status: "running",
    });
    expect(lagged).toHaveLength(1);
    expect((await feed.snapshot()).status).toBe("running");
    control.emit({
      session: { id: "s", generation: 1 },
      seq: 2,
      conditions: {},
      engineUnavailable: null,
    });
    expect(changes).toEqual([2]);
    off();
    control.emit({
      session: { id: "s", generation: 1 },
      seq: 3,
      conditions: {},
      engineUnavailable: null,
    });
    expect(changes).toEqual([2]);
  });
});
