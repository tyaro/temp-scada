import { describe, expect, it } from "vitest";
import {
  createRuntimeWindowsController,
  type RuntimeWindowsHost,
} from "./runtime-windows.svelte";

function setup(
  options: {
    screens?: { id: string }[];
    mode?: "edit" | "preview";
    alarmSettings?: unknown;
  } = {},
) {
  const reports: string[] = [];
  const state = { mode: options.mode ?? ("preview" as "edit" | "preview") };
  const host: RuntimeWindowsHost = {
    get mode() {
      return state.mode;
    },
    workspaceGeneration: 0,
    operatorFrame: undefined,
    screens: options.screens ?? [{ id: "screen-1" }],
    screenId: "screen-1",
    alarmFeed: { alarmSettings: options.alarmSettings },
    report: (_kind, text) => void reports.push(text),
  };
  const windows = createRuntimeWindowsController(host);
  return { windows, reports, state };
}

describe("runtime windows controller", () => {
  it("開始画面がないと運転表示を開かずに報告する", () => {
    const { windows, reports } = setup({ screens: [] });
    windows.openOperatorView();
    expect(windows.operatorStart).toBeNull();
    expect(reports).toEqual([
      "運転表示を開けません。ヘッダー・フッター以外の画面を追加してください。",
    ]);
  });

  it("開始画面があれば運転表示を開き、preview を離れたら閉じる", () => {
    const { windows, reports, state } = setup();
    windows.openOperatorView();
    expect(windows.operatorStart).toBe("screen-1");
    expect(reports).toEqual([]);
    state.mode = "edit";
    windows.closeStaleOperatorView();
    expect(windows.operatorStart).toBeNull();
  });

  it("preview 以外では警報一覧を開かない", () => {
    const { windows } = setup({ mode: "edit" });
    windows.openAlarmList();
    expect(windows.alarmListOpen).toBe(false);
  });

  it("端末設定は使えない理由があるとき開かない", () => {
    const { windows } = setup({ alarmSettings: undefined });
    expect(windows.alarmSettingsReason).not.toBeNull();
    windows.openAlarmSettings();
    expect(windows.alarmSettingsOpen).toBe(false);
  });
});
