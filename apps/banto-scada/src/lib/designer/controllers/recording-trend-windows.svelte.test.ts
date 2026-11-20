import { describe, expect, it } from "vitest";
import type { EditCommand } from "../../editor";
import type { Project } from "../../project";
import {
  createRecordingTrendWindowsController,
  type RecordingTrendWindowsHost,
} from "./recording-trend-windows.svelte";

function setup(
  options: {
    mode?: "edit" | "preview";
    activeDefinition?: unknown;
    menuBlocked?: boolean;
  } = {},
) {
  const project = { screens: [], trends: [] } as unknown as Project;
  const state = {
    project,
    workspaceGeneration: 0,
    screenId: "screen-1",
    mode: options.mode ?? ("edit" as "edit" | "preview"),
    activeDefinition: options.activeDefinition,
    menuBlocked: options.menuBlocked ?? false,
  };
  const calls: string[] = [];
  const edits: EditCommand[] = [];
  const host: RecordingTrendWindowsHost = {
    get project() {
      return state.project;
    },
    get workspaceGeneration() {
      return state.workspaceGeneration;
    },
    get screenId() {
      return state.screenId;
    },
    get mode() {
      return state.mode;
    },
    get activeDefinition() {
      return state.activeDefinition;
    },
    get menuBlocked() {
      return state.menuBlocked;
    },
    busy: false,
    replacement: null,
    withScreen: (_id, action) => action(),
    stopPlacement: () => void calls.push("stopPlacement"),
    edit: (command) => {
      edits.push(command);
      return true;
    },
    trendFrame: () => ({ x: 0, y: 0, width: 320, height: 120 }),
  };
  const windows = createRecordingTrendWindowsController(host);
  return { windows, state, calls, edits };
}

describe("recording / trend windows controller", () => {
  it("定義の編集中・menuBlocked のときは記録計画を開かない", () => {
    const editing = setup({ activeDefinition: { id: "symbol-1" } });
    editing.windows.openRecordingPlan();
    expect(editing.windows.recordingRequest).toBeNull();
    expect(editing.calls).toEqual([]);

    const blocked = setup({ menuBlocked: true });
    blocked.windows.openRecordingPlan();
    expect(blocked.windows.recordingRequest).toBeNull();
    expect(blocked.windows.recordingView).toBeNull();
  });

  it("preview では記録計画を読取専用で開き、edit では編集で開く", () => {
    const preview = setup({ mode: "preview" });
    preview.windows.openRecordingPlan();
    expect(preview.windows.recordingRequest?.readonly).toBe(true);
    expect(preview.windows.recordingView).toBe(
      preview.windows.recordingRequest,
    );
    expect(preview.windows.currentRecordingRequest).toBe(
      preview.windows.recordingRequest,
    );
    expect(preview.calls).toEqual(["stopPlacement"]);

    const edit = setup({ mode: "edit" });
    edit.windows.openRecordingPlan();
    expect(edit.windows.recordingRequest?.readonly).toBe(false);
  });

  it("世代が変わった古い要求は current から外れ、保存しない", () => {
    const { windows, state, edits } = setup();
    windows.openRecordingPlan();
    windows.openTrendDefinitions("trend-1");
    const recording = windows.recordingRequest!;
    expect(windows.currentRecordingRequest).toBe(recording);
    expect(windows.currentTrendRequest?.definitionId).toBe("trend-1");

    state.workspaceGeneration++;
    expect(windows.currentRecordingRequest).toBeNull();
    expect(windows.currentTrendRequest).toBeNull();
    windows.saveRecordingPlan(recording, {} as never);
    windows.removeTrend("trend-1");
    expect(edits).toEqual([]);

    windows.dropStaleRecordingRequest();
    windows.dropStaleTrendRequest();
    expect(windows.recordingRequest).toBeNull();
    expect(windows.trendRequest).toBeNull();
    // 閉じる遷移のため、閉じた窓の要求は残す。
    expect(windows.recordingView).toBe(recording);
  });

  it("トレンド定義の編集中は履歴を開かず、履歴の表示中は定義を開かない", () => {
    const { windows } = setup();
    windows.openTrendDefinitions();
    windows.openTrendHistory("screen-1", "object-1");
    expect(windows.historyOpen).toBe(false);

    windows.closeTrendDefinitions();
    windows.openHistory();
    windows.openTrendDefinitions();
    expect(windows.trendRequest).toBeNull();
  });
});
