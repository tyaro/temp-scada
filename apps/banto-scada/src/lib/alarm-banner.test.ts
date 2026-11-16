import { describe, expect, it } from "vitest";
import sample from "../../../../examples/process.project.json";
import cases from "../../../../examples/alarm-banner-cases.json";
import type {
  AlarmConditionDisplay,
  AlarmConditionState,
  AlarmSnapshot,
} from "./alarm-mirror";
import {
  alarmBannerView,
  formatAlarmBannerTime,
  newAlarmBannerShape,
} from "./alarm-banner";
import { parseProject, serializeProject, type Project } from "./project";
import { applyCommand } from "./editor";
import { objectFormCommand } from "./designer/forms/object-form";
import { objectFormValues } from "./designer/numeric-properties";
import { canFlip } from "./flip";
import { copyObjects, parseClipboard } from "./clipboard";
import { shapeSlotNames, shapeTagBindings } from "./shape-bindings";

// 最新の警報の帯。仕様: docs/design/graphics/alarm-banner.md
const PROJECT = "0199f200-0000-7000-8000-000000000001";
const at = (hours: number, minutes = 0, seconds = 0) =>
  new Date(2026, 10, 17, hours, minutes, seconds).getTime();

const condition = (
  patch: Partial<AlarmConditionState> = {},
): AlarmConditionState => ({
  active: false,
  occurrence: null,
  recurrence: 0,
  acked: true,
  timer: null,
  unavailable: null,
  reportedUnavailable: null,
  orderKey: null,
  occurredAtMs: null,
  observation: null,
  ...patch,
});
/** 発生中・未確認の condition。`seq` を orderKey と時刻に使う。 */
const raised = (seq: number, patch: Partial<AlarmConditionState> = {}) =>
  condition({
    active: true,
    acked: false,
    occurrence: `o-${seq}`,
    orderKey: { generation: 1, seq },
    occurredAtMs: at(9, 0, seq),
    ...patch,
  });
const display = (
  name: string,
  severity = "high",
  message = `${name} 異常`,
): AlarmConditionDisplay => ({ name, message, severity, limitLabel: null });

function snapshot(
  conditions: Record<string, AlarmConditionState>,
  displays: Record<string, AlarmConditionDisplay> = {},
  patch: Partial<AlarmSnapshot> = {},
  engineUnavailable: string | null = null,
): AlarmSnapshot {
  return {
    monitored: { projectId: PROJECT },
    applied: {
      projectId: PROJECT,
      projectRevision: 1,
      appliedAtMs: 1,
      displays,
    },
    engine: {
      session: { id: "s", generation: 1 },
      seq: 1,
      unavailable: engineUnavailable,
      conditions,
    },
    status: "running",
    pendingConditionChanges: false,
    pendingDisplayChanges: false,
    historyWriteFailure: null,
    rereadFailure: null,
    ...patch,
  };
}
const chosen = (value: AlarmSnapshot) =>
  alarmBannerView(value, PROJECT).selected?.conditionId;

describe("alarm banner view: not monitoring", () => {
  it("is stopped without a snapshot or a running Engine, naming the status", () => {
    expect(alarmBannerView(null, PROJECT)).toEqual({
      kind: "stopped",
      main: "警報 停止中（警報の状態を受け取っていません）",
      label: "最新の警報: 警報 停止中（警報の状態を受け取っていません）",
    });
    const stopped = (status: string) =>
      alarmBannerView(snapshot({}, {}, { status, engine: null }), PROJECT).main;
    expect(stopped("notApplied")).toBe("警報 停止中（未適用）");
    expect(stopped("noHub")).toBe("警報 停止中（Hub未設定）");
    expect(stopped("engineStopped")).toBe(
      "警報 停止中（Engineが止まりました）",
    );
    expect(stopped("confirmationRequired")).toBe(
      "警報 停止中（切替の確認待ち）",
    );
    expect(stopped("somethingNew")).toBe("警報 停止中（somethingNew）");
    // status が running でも Engine が無ければ停止中。
    expect(stopped("running")).toBe("警報 停止中（running）");
    // 未知の文字列が Object の既定のプロパティ名でも、そのまま出す。
    expect(stopped("toString")).toBe("警報 停止中（toString）");
  });

  it("hides the chosen alarm while the Engine cannot monitor", () => {
    const view = alarmBannerView(
      snapshot(
        { a: raised(1, { unavailable: "stale" }) },
        { a: display("A") },
        {},
        "receiveLost",
      ),
      PROJECT,
    );
    expect(view).toEqual({
      kind: "unmonitored",
      main: "警報 監視できていません（受信の途絶）",
      label: "最新の警報: 警報 監視できていません（受信の途絶）",
    });
    expect(
      alarmBannerView(snapshot({}, {}, {}, "disconnected"), PROJECT).main,
    ).toBe("警報 監視できていません（未接続）");
  });

  it("says another Project is monitored, like the badge", () => {
    const other = "0199f200-0000-7000-8000-0000000000ff";
    expect(
      alarmBannerView(
        snapshot({ a: raised(1) }, {}, { monitored: { projectId: other } }),
        PROJECT,
      ).kind,
    ).toBe("otherProject");
    const applied = snapshot({ a: raised(1) }).applied!;
    expect(
      alarmBannerView(
        snapshot(
          { a: raised(1) },
          {},
          { applied: { ...applied, projectId: other } },
        ),
        PROJECT,
      ).main,
    ).toBe("警報 別の Project を監視中です");
  });
});

describe("alarm banner view: choosing one alarm", () => {
  it("shows nothing for normal and pending conditions", () => {
    expect(
      alarmBannerView(
        snapshot({
          a: condition(),
          b: condition({ timer: { kind: "onDelay", dueMs: 1 } }),
        }),
        PROJECT,
      ),
    ).toEqual({
      kind: "none",
      main: "警報なし",
      label: "最新の警報: 警報なし",
    });
  });

  it("shows time, name and message with the counts", () => {
    const view = alarmBannerView(
      snapshot(
        { a: raised(3), b: raised(1, { acked: true }) },
        { a: display("T-01 温度", "high", "温度 異常高") },
      ),
      PROJECT,
    );
    expect(view).toMatchObject({
      kind: "alarm",
      main: "11/17 09:00:03 T-01 温度 温度 異常高",
      count: "警報 2 件（未確認 1 件）",
      selected: { conditionId: "a", state: "activeUnacked", severity: "high" },
    });
    expect(view.label).toBe(
      "最新の警報: 11/17 09:00:03 T-01 温度 温度 異常高 ／ 警報 2 件（未確認 1 件）",
    );
  });

  it("prefers unacknowledged alarms over acknowledged ones of higher severity", () => {
    expect(
      chosen(
        snapshot(
          { high: raised(5, { acked: true }), low: raised(1) },
          { high: display("H", "high"), low: display("L", "low") },
        ),
      ),
    ).toBe("low");
    // 復帰・未確認も未確認の組に入る。
    expect(
      chosen(
        snapshot(
          {
            acked: raised(5, { acked: true }),
            back: raised(1, { active: false }),
          },
          { acked: display("A"), back: display("B") },
        ),
      ),
    ).toBe("back");
  });

  it("orders by severity, missing or invalid severity counting as low", () => {
    const conditions = { a: raised(9), b: raised(1), c: raised(5) };
    expect(
      chosen(
        snapshot(conditions, {
          a: display("A", "low"),
          b: display("B", "high"),
          c: display("C", "medium"),
        }),
      ),
    ).toBe("b");
    expect(
      chosen(
        snapshot(conditions, {
          a: display("A", "urgent"),
          c: display("C", "medium"),
        }),
      ),
    ).toBe("c");
  });

  it("drops a lower limit while its upper limit of the same alarm remains", () => {
    // H が新しくても、同じ定義の HH を出す。
    expect(
      chosen(
        snapshot(
          { "t:hh": raised(1), "t:h": raised(9) },
          {
            "t:hh": display("T HH"),
            "t:h": display("T H"),
          },
        ),
      ),
    ).toBe("t:hh");
    expect(chosen(snapshot({ "t:ll": raised(1), "t:l": raised(9) }))).toBe(
      "t:ll",
    );
    // 別の定義の H は落とさず、新しい順で比べる。
    expect(chosen(snapshot({ "t:hh": raised(1), "u:h": raised(9) }))).toBe(
      "u:h",
    );
    // 上位の限界が severity で先に落ちていれば、下位を出す。
    expect(
      chosen(
        snapshot(
          { "t:hh": raised(9), "t:h": raised(1) },
          {
            "t:hh": display("T HH", "low"),
            "t:h": display("T H", "high"),
          },
        ),
      ),
    ).toBe("t:h");
    // 確認済みの HH は未確認の H を隠さない。
    expect(
      chosen(
        snapshot({ "t:hh": raised(9, { acked: true }), "t:h": raised(1) }),
      ),
    ).toBe("t:h");
  });

  it("orders the rest newest first by orderKey, then time, then id", () => {
    expect(
      chosen(
        snapshot({
          old: raised(1, { orderKey: { generation: 2, seq: 1 } }),
          new: raised(2, { orderKey: { generation: 1, seq: 99 } }),
        }),
      ),
    ).toBe("old");
    expect(
      chosen(
        snapshot({
          a: raised(1, {
            orderKey: { generation: 1, seq: 5 },
            occurredAtMs: at(8),
          }),
          b: raised(1, {
            orderKey: { generation: 1, seq: 5 },
            occurredAtMs: at(9),
          }),
        }),
      ),
    ).toBe("b");
    expect(
      chosen(
        snapshot({
          z: raised(1, { orderKey: null, occurredAtMs: null }),
          y: raised(1, { orderKey: null, occurredAtMs: null }),
          x: raised(1, {
            orderKey: { generation: 0, seq: 0 },
            occurredAtMs: null,
          }),
        }),
      ),
    ).toBe("x");
    expect(
      chosen(
        snapshot({
          z: raised(1, { orderKey: null, occurredAtMs: null }),
          y: raised(1, { orderKey: null, occurredAtMs: null }),
        }),
      ),
    ).toBe("y");
  });

  it("marks a returned alarm and falls back to the condition id and a dash", () => {
    const view = alarmBannerView(
      snapshot({ "t:hh": raised(1, { active: false, occurredAtMs: null }) }),
      PROJECT,
    );
    expect(view.main).toBe("復帰 — t:hh");
    expect(view.selected).toMatchObject({
      state: "returnedUnacked",
      severity: "low",
    });
    expect(view.count).toBe("警報 1 件（未確認 1 件）");
  });
});

describe("alarm banner view: unavailable conditions", () => {
  it("adds the count and the most common reason even without alarms", () => {
    const view = alarmBannerView(
      snapshot({
        a: condition({ unavailable: "initialValue" }),
        b: condition({ unavailable: "bad" }),
        c: condition({ unavailable: "bad" }),
        d: condition(),
      }),
      PROJECT,
    );
    expect(view).toEqual({
      kind: "none",
      main: "警報なし",
      unavailable: "評価不能 3 件（不良）",
      label: "最新の警報: 警報なし ／ 評価不能 3 件（不良）",
    });
  });

  it("breaks ties in the enum order and keeps unknown reasons as is", () => {
    const reason = (...reasons: string[]) =>
      alarmBannerView(
        snapshot(
          Object.fromEntries(
            reasons.map((unavailable, i) => [
              `c${i}`,
              condition({ unavailable }),
            ]),
          ),
        ),
        PROJECT,
      ).unavailable;
    expect(reason("nonFinite", "stale")).toBe("評価不能 2 件（更新停止）");
    expect(reason("typeMismatch", "initialValue")).toBe(
      "評価不能 2 件（初期値待ち）",
    );
    expect(reason("noValue", "unresolved")).toBe("評価不能 2 件（未解決）");
    expect(reason("mystery", "mystery", "stale")).toBe(
      "評価不能 3 件（mystery）",
    );
  });

  it("adds them next to a chosen alarm", () => {
    const view = alarmBannerView(
      snapshot({ a: raised(1, { unavailable: "stale" }) }, { a: display("A") }),
      PROJECT,
    );
    expect(view.unavailable).toBe("評価不能 1 件（更新停止）");
    expect(view.label).toBe(
      "最新の警報: 11/17 09:00:01 A A 異常 ／ 警報 1 件（未確認 1 件） ／ 評価不能 1 件（更新停止）",
    );
  });
});

it("formats the local time as M/D HH:mm:ss", () => {
  expect(formatAlarmBannerTime(new Date(2026, 0, 5, 7, 8, 9).getTime())).toBe(
    "1/5 07:08:09",
  );
  expect(formatAlarmBannerTime(null)).toBe("—");
  expect(formatAlarmBannerTime(Number.NaN)).toBe("—");
});

it.each(cases)("alarm banner contract: $name", (item) => {
  const value = structuredClone(sample) as any;
  if ("alarms" in item) {
    if (item.alarms === null) delete value.alarms;
    else value.alarms = item.alarms;
  }
  item.target
    .split("/")
    .slice(1)
    .reduce((node: any, key: string) => node[key], value)
    .push(item.object);
  const parse = () => parseProject(JSON.stringify(value));
  if (!item.valid) {
    expect(parse).toThrow();
    return;
  }
  expect(parseProject(serializeProject(parse()))).toEqual(value);
});

describe("alarm banner editing", () => {
  const project = () => parseProject(JSON.stringify(sample));
  const screenId = sample.screens[0].id;
  it("adds a 480×28 banner without a fill or alarm definitions that cannot flip", () => {
    const base = project();
    delete base.alarms;
    const next = applyCommand(
      base,
      { type: "add", screenId, kind: "alarmBanner" },
      "edit",
    );
    const object = next.screens[0].objects.at(-1)!;
    expect(object).toMatchObject({ width: 480, height: 28 });
    expect("fill" in object).toBe(false);
    expect(object.shape).toEqual(newAlarmBannerShape());
    expect(parseProject(serializeProject(next))).toEqual(next);
    expect(canFlip(object)).toBe(false);
    expect(shapeTagBindings(object.shape)).toEqual([]);
    expect(shapeSlotNames(object.shape)).toEqual([]);
  });
  it("cannot be added inside a Symbol", () => {
    const base = project();
    expect(() =>
      applyCommand(
        base,
        {
          type: "add",
          screenId,
          definitionId: base.symbols[0].id,
          kind: "alarmBanner",
        },
        "edit",
      ),
    ).toThrow("Symbol定義には警報の帯を置けません");
  });
  it("can be copied, but not pasted into a Symbol", () => {
    const next = applyCommand(
      project(),
      { type: "add", screenId, kind: "alarmBanner" },
      "edit",
    );
    const object = next.screens[0].objects.at(-1)!;
    const text = copyObjects(next, screenId, [object.id], "a");
    expect(parseClipboard(text).project.screens[0].objects[0].shape).toEqual(
      object.shape,
    );
    expect(() =>
      applyCommand(
        next,
        {
          type: "paste",
          screenId,
          definitionId: next.symbols[0].id,
          text,
          origin: "b",
          center: { x: 10, y: 10 },
        },
        "edit",
      ),
    ).toThrow("警報の帯");
  });
  it("applies the Inspector form to the text style", () => {
    const next = applyCommand(
      project(),
      { type: "add", screenId, kind: "alarmBanner" },
      "edit",
    );
    const object = next.screens[0].objects.at(-1)!;
    const data = new Map(Object.entries(objectFormValues(object, false)));
    expect(data.get("alarmBannerFontSize")).toBe("14");
    expect(data.has("fill")).toBe(false);
    data.delete("colorAlpha");
    data.set("alarmBannerFontSize", "18");
    data.set("alarmBannerFontWeight", "bold");
    const run = (form: Map<string, string>, base: Project = next) =>
      applyCommand(
        base,
        objectFormCommand(
          { get: (key) => form.get(key) ?? null, has: (key) => form.has(key) },
          { screenId, definition: false, selected: object },
        ),
        "edit",
      );
    expect(
      run(data).screens[0].objects.find((o) => o.id === object.id)!.shape,
    ).toEqual({
      type: "alarmBanner",
      style: { fontSize: 18, fontWeight: "bold" },
    });
    data.set("alarmBannerFontSize", "0");
    expect(() => run(data)).toThrow("警報の帯の文字サイズ");
  });
});
