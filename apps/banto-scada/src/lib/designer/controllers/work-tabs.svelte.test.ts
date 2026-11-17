import { describe, expect, it } from "vitest";
import {
  createWorkTabsController,
  type WorkTabChange,
} from "./work-tabs.svelte";

/** `allow` が false の間は、ゲートが入力の確定を待つ（action を呼ばない）。 */
function setup() {
  const gate = { allow: true, calls: 0, held: [] as (() => void)[] };
  const changes: WorkTabChange[] = [];
  const tabs = createWorkTabsController({
    transition(run) {
      gate.calls++;
      if (gate.allow) run();
      else gate.held.push(run);
    },
    changing: (change) => changes.push(change),
  });
  return { tabs, gate, changes };
}

describe("作業タブの controller", () => {
  it("3種類の作業タブを各1枚まで開き、開いたタブを選ぶ", () => {
    const { tabs, changes } = setup();
    tabs.open("project-settings");
    tabs.open("equipment");
    tabs.open("alarm-definitions");
    tabs.open("equipment");
    expect(tabs.tabs).toEqual([
      "project-settings",
      "equipment",
      "alarm-definitions",
    ]);
    expect(tabs.selected).toBe("equipment");
    expect(
      changes.map((item) => [item.previous, item.next, item.cause]),
    ).toEqual([
      [null, "project-settings", "open"],
      ["project-settings", "equipment", "open"],
      ["equipment", "alarm-definitions", "open"],
      ["alarm-definitions", "equipment", "open"],
    ]);
  });

  it("選択中のタブを開き直しても選択は変えず、フォーカスのため通知する", () => {
    const { tabs, changes } = setup();
    tabs.open("project-settings");
    tabs.open("project-settings");
    expect(tabs.tabs).toEqual(["project-settings"]);
    expect(changes.at(-1)).toEqual({
      previous: "project-settings",
      next: "project-settings",
      cause: "open",
    });
  });

  it("作業タブと画面タブ（null）を切り替え、開いていないタブは選ばない", () => {
    const { tabs } = setup();
    tabs.open("equipment");
    tabs.select(null);
    expect(tabs.selected).toBeNull();
    expect(tabs.tabs).toEqual(["equipment"]);
    tabs.select("alarm-definitions");
    expect(tabs.selected).toBeNull();
    tabs.select("equipment");
    expect(tabs.selected).toBe("equipment");
  });

  it("選択中のタブを閉じると直前に選んでいたタブへ戻る", () => {
    const { tabs } = setup();
    tabs.open("equipment");
    tabs.open("project-settings");
    tabs.close("project-settings");
    expect(tabs.selected).toBe("equipment");
    tabs.close("equipment");
    expect(tabs.selected).toBeNull();
    expect(tabs.tabs).toEqual([]);
  });

  it("画面タブから開いたタブを閉じると画面タブへ戻る", () => {
    const { tabs } = setup();
    tabs.open("equipment");
    tabs.select(null);
    tabs.open("project-settings");
    tabs.close("project-settings");
    expect(tabs.selected).toBeNull();
    expect(tabs.tabs).toEqual(["equipment"]);
  });

  it("戻る先のタブが閉じられていたら画面タブへ戻る", () => {
    const { tabs, changes } = setup();
    tabs.open("equipment");
    tabs.open("project-settings");
    tabs.close("equipment");
    expect(tabs.selected).toBe("project-settings");
    expect(changes.at(-1)).toEqual({
      previous: "project-settings",
      next: "project-settings",
      cause: "close",
    });
    tabs.close("project-settings");
    expect(tabs.selected).toBeNull();
  });

  it("open・select・close はゲートを1回ずつ通し、通過するまで変えない", () => {
    const { tabs, gate } = setup();
    gate.allow = false;
    tabs.open("equipment");
    expect(gate.calls).toBe(1);
    expect(tabs.tabs).toEqual([]);
    expect(tabs.selected).toBeNull();
    gate.held.shift()!();
    expect(tabs.selected).toBe("equipment");
    tabs.select(null);
    tabs.close("equipment");
    expect(gate.calls).toBe(3);
    expect(tabs.selected).toBe("equipment");
    gate.held.shift()!();
    gate.held.shift()!();
    expect(tabs.selected).toBeNull();
    expect(tabs.tabs).toEqual([]);
  });

  it("selectNow はゲートを通さず同期で切り替える", () => {
    const { tabs, gate, changes } = setup();
    gate.allow = false;
    tabs.selectNow("project-settings");
    expect(gate.calls).toBe(0);
    expect(tabs.tabs).toEqual(["project-settings"]);
    expect(tabs.selected).toBe("project-settings");
    tabs.selectNow(null);
    expect(tabs.selected).toBeNull();
    tabs.selectNow(null);
    expect(changes.map((item) => item.cause)).toEqual(["now", "now"]);
  });

  it("reset はすべて閉じ、閉じていれば通知しない", () => {
    const { tabs, changes } = setup();
    tabs.reset();
    expect(changes).toEqual([]);
    tabs.open("equipment");
    tabs.open("alarm-definitions");
    tabs.reset();
    expect(tabs.tabs).toEqual([]);
    expect(tabs.selected).toBeNull();
    expect(changes.at(-1)?.cause).toBe("reset");
    tabs.open("project-settings");
    tabs.close("project-settings");
    expect(tabs.selected).toBeNull();
  });
});
