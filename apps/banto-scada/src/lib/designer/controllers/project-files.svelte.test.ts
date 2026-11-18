import { describe, expect, it, vi } from "vitest";
import { createProjectFilesController } from "./project-files.svelte";
import { createProject } from "../../new-project";
import { serializeProject, type Project } from "../../project";
import { AssetStore } from "../../image-assets";
import {
  ProjectFileError,
  type AlarmApplyResult,
  type ProjectFileService,
  type SaveProjectFileRequest,
} from "../../project-file-service";

/** A host whose adopt behaves as App's: it calls `adopted` on the controller. */
function setup(service?: ProjectFileService) {
  const reports: { kind: string; text: string }[] = [];
  const refresh = vi.fn();
  let chosen = 0;
  const state = { project: createProject(), generation: 0 };
  const controller: ReturnType<typeof createProjectFilesController> =
    createProjectFilesController({
      get project() {
        return state.project;
      },
      get generation() {
        return state.generation;
      },
      store: new AssetStore(),
      draftPending: false,
      fileService: service,
      alarmRefresh: refresh,
      chooseFile: () => chosen++,
      allow: () => true,
      adopt(next: Project, source) {
        state.project = next;
        controller.adopted(next, source);
        state.generation++;
      },
      report: (kind, text) => reports.push({ kind, text }),
    });
  return { controller, state, reports, refresh, chosen: () => chosen };
}

function fakeService(fileName = "plant.json") {
  const saves: SaveProjectFileRequest[] = [];
  let nextId = 10;
  const opened = createProject();
  const service: ProjectFileService = {
    async open() {
      return {
        fileId: 5,
        file: new File([serializeProject(opened)], fileName),
      };
    },
    async save(request) {
      saves.push(request);
      return { fileId: request.fileId ?? ++nextId, fileName };
    },
  };
  return { service, saves, opened };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("project files on the desktop", () => {
  it("saves a new Project through the dialog, then overwrites its file", async () => {
    const { service, saves } = fakeService();
    const { controller, reports } = setup(service);
    expect(controller.native).toBe(true);
    expect(controller.saveLabel).toBe("サンプルからの変更なし");
    controller.save();
    await settle();
    expect(saves[0]).toMatchObject({
      fileId: null,
      format: "json",
      saveAs: false,
    });
    expect(controller.saveLabel).toBe("保存後の変更なし");
    expect(reports.at(-1)?.text).toContain("plant.json");
    controller.save();
    await settle();
    expect(saves[1].fileId).toBe(11);
    controller.saveAs();
    await settle();
    expect(saves[2]).toMatchObject({ fileId: 11, saveAs: true });
  });

  it("reports when the first save starts monitoring this Project", async () => {
    const { controller, reports } = setup({
      open: async () => null,
      save: async () => ({
        fileId: 12,
        fileName: "plant.json",
        apply: {
          status: "applied",
          snapshot: { status: "running" },
          initialMonitoring: true,
        },
      }),
    });
    controller.save();
    await settle();
    expect(reports.at(-1)).toEqual({
      kind: "success",
      text: "このProjectの警報監視を開始しました。",
    });
  });

  it("reports an unavailable alarm Engine once while saves still succeed", async () => {
    const { controller, reports } = setup({
      open: async () => null,
      save: async () => ({
        fileId: 12,
        fileName: "plant.json",
        apply: { status: "skippedUnavailable", reason: "noDataDir" },
      }),
    });
    controller.save();
    await settle();
    controller.save();
    await settle();
    expect(reports.filter((report) => report.kind === "info")).toEqual([
      {
        kind: "info",
        text: "Projectを保存しました。警報Engineの保存先がないため、警報定義を適用していません。",
      },
    ]);
  });

  it("reports that alarm apply was skipped while Hub connection is busy", async () => {
    const { controller, reports } = setup({
      open: async () => null,
      save: async () => ({
        fileId: 12,
        fileName: "plant.json",
        apply: { status: "skippedBusy" },
      }),
    });
    controller.save();
    await settle();
    expect(reports.at(-1)).toEqual({
      kind: "info",
      text: "Projectを保存しました。Hubへの接続処理中のため警報定義は適用していません。接続後に明示的に適用してください。",
    });
  });

  it("keeps the opened file's id and forgets it for a new Project", async () => {
    const { service, saves } = fakeService();
    const { controller, chosen } = setup(service);
    controller.openProjectFile();
    await settle();
    await settle();
    expect(chosen()).toBe(0);
    expect(controller.saveLabel).toBe("読込後の変更なし");
    controller.save();
    await settle();
    expect(saves[0].fileId).toBe(5);
    controller.newProject();
    controller.save();
    await settle();
    expect(saves[1].fileId).toBeNull();
  });

  it("refreshes alarm state after adopting a Project file", async () => {
    const { service } = fakeService();
    const { controller, refresh } = setup(service);
    controller.openProjectFile();
    await settle();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("reports a cancelled save and keeps the Project unsaved", async () => {
    const { controller, reports } = setup({
      open: async () => null,
      save: async () => null,
    });
    controller.save();
    await settle();
    expect(reports.at(-1)).toEqual({
      kind: "info",
      text: "保存を取り消しました。",
    });
    expect(controller.lastExport).toBeNull();
  });

  it("keeps the saved file and applies only the exact rounds the user confirmed", async () => {
    const occurrence = {
      conditionId: "alarm:a",
      occurrence: "round-1",
      recurrence: 0,
    };
    const calls: unknown[] = [];
    vi.stubGlobal("window", { confirm: vi.fn(() => true) });
    try {
      const { controller, reports } = setup({
        open: async () => null,
        save: async () => ({
          fileId: 12,
          fileName: "plant.json",
          apply: { status: "confirmationRequired", occurrences: [occurrence] },
        }),
        apply: async (fileId, confirmed) => {
          calls.push({ fileId, confirmed });
          return { status: "applied" };
        },
      });
      controller.save();
      await settle();
      await settle();
      expect(calls).toEqual([{ fileId: 12, confirmed: [occurrence] }]);
      expect(
        reports.some((report) =>
          report.text.includes("警報定義を適用しました"),
        ),
      ).toBe(true);
      expect(controller.saveLabel).toBe("保存後の変更なし");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("confirms a Project switch even when there are no unacknowledged rounds", async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal("window", { confirm });
    try {
      const calls: unknown[] = [];
      const { controller } = setup({
        open: async () => null,
        save: async () => ({
          fileId: 12,
          fileName: "other.json",
          apply: { status: "skippedDifferentProject" },
        }),
        apply: async (fileId, confirmed, confirmedSwitchFrom) => {
          calls.push({ fileId, confirmed, confirmedSwitchFrom });
          return confirmedSwitchFrom
            ? { status: "applied" }
            : {
                status: "switchConfirmationRequired",
                monitoredProjectId: "project-a",
              };
        },
      });
      controller.save();
      await settle();
      await controller.applyAlarm();
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(calls).toEqual([
        { fileId: 12, confirmed: [], confirmedSwitchFrom: undefined },
        { fileId: 12, confirmed: [], confirmedSwitchFrom: "project-a" },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stops a Project switch when the host omits its monitored Project id", async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal("window", { confirm });
    try {
      const apply = vi.fn(
        async () =>
          ({ status: "switchConfirmationRequired" }) as AlarmApplyResult,
      );
      const { controller, reports } = setup({
        open: async () => null,
        save: async () => ({
          fileId: 12,
          fileName: "other.json",
          apply: { status: "skippedDifferentProject" },
        }),
        apply,
      });
      controller.save();
      await settle();
      await controller.applyAlarm();
      expect(apply).toHaveBeenCalledTimes(1);
      expect(confirm).not.toHaveBeenCalled();
      expect(reports.at(-1)?.kind).toBe("error");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not confirm an apply after another Project is opened", async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal("window", { confirm });
    try {
      let finish!: (result: AlarmApplyResult) => void;
      const apply = vi.fn(
        () => new Promise<AlarmApplyResult>((resolve) => (finish = resolve)),
      );
      const { controller, reports } = setup({
        open: async () => null,
        save: async () => ({ fileId: 12, fileName: "old.json" }),
        apply,
      });
      controller.save();
      await settle();
      const pending = controller.applyAlarm();
      controller.adopted(createProject(), "file");
      finish({
        status: "switchConfirmationRequired",
        monitoredProjectId: "project-a",
      });
      await pending;
      expect(apply).toHaveBeenCalledTimes(1);
      expect(apply).toHaveBeenCalledWith(12, []);
      expect(confirm).not.toHaveBeenCalled();
      expect(reports.at(-1)?.text).toContain("Projectが変わりました");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("ignores a second explicit apply until the first one finishes", async () => {
    let finish!: (result: AlarmApplyResult) => void;
    const apply = vi.fn(
      () => new Promise<AlarmApplyResult>((resolve) => (finish = resolve)),
    );
    const { controller } = setup({
      open: async () => null,
      save: async () => ({ fileId: 12, fileName: "plant.json" }),
      apply,
    });
    controller.save();
    await settle();
    const first = controller.applyAlarm();
    expect(controller.alarmApplying).toBe(true);
    await controller.applyAlarm();
    expect(apply).toHaveBeenCalledTimes(1);
    finish({ status: "applied" });
    await first;
    expect(controller.alarmApplying).toBe(false);
    const second = controller.applyAlarm();
    expect(apply).toHaveBeenCalledTimes(2);
    finish({ status: "applied" });
    await second;
  });

  it("says why an apply after a save failed, with the host's code", async () => {
    const { controller, reports } = setup({
      open: async () => null,
      save: async () => ({
        fileId: 12,
        fileName: "plant.json",
        apply: { status: "failed", reason: "historyUnwritable" },
      }),
    });
    controller.save();
    await settle();
    expect(reports.at(-1)).toEqual({
      kind: "error",
      text: "Projectは保存しましたが、警報定義を適用できませんでした。警報の履歴DBに書き込めない間は適用できません。書込みの回復を待ってから再度適用してください（historyUnwritable）。",
    });
  });

  it("says why an explicit apply was refused, not that a file failed", async () => {
    const { controller, reports } = setup({
      open: async () => null,
      save: async () => ({ fileId: 12, fileName: "plant.json" }),
      apply: async () => {
        throw new ProjectFileError("unauthorized");
      },
    });
    controller.save();
    await settle();
    await controller.applyAlarm();
    expect(reports.at(-1)).toEqual({
      kind: "error",
      text: "警報定義を適用できませんでした。警報定義の適用には Admin でのログインが必要です（unauthorized）。",
    });
  });

  // The host sends terminalUnavailable for every TerminalError (in use,
  // unreadable, corrupt, lost), so the text must not claim "in use".
  it("does not call an unavailable terminal in use", async () => {
    const { controller, reports } = setup({
      open: async () => null,
      save: async () => ({ fileId: 12, fileName: "plant.json" }),
      apply: async () => {
        throw new ProjectFileError("terminalUnavailable");
      },
    });
    controller.save();
    await settle();
    await controller.applyAlarm();
    expect(reports.at(-1)?.text).toBe(
      "警報定義を適用できませんでした。この端末の警報設定・監視状態を利用できません（terminalUnavailable）。",
    );

    const skipped = setup({
      open: async () => null,
      save: async () => ({
        fileId: 12,
        fileName: "plant.json",
        apply: { status: "skippedUnavailable", reason: "terminalUnavailable" },
      }),
    });
    skipped.controller.save();
    await settle();
    expect(skipped.reports.at(-1)?.text).not.toContain("使用中");
    expect(skipped.reports.at(-1)?.text).toContain(
      "警報設定・監視状態を利用できない",
    );
  });

  it("does not say the Project was saved when an explicit apply fails", async () => {
    const { controller, reports } = setup({
      open: async () => null,
      save: async () => ({ fileId: 12, fileName: "plant.json" }),
      apply: async () => ({ status: "failed", reason: "somethingNew" }),
    });
    controller.save();
    await settle();
    await controller.applyAlarm();
    expect(reports.at(-1)).toEqual({
      kind: "error",
      text: "警報定義を適用できませんでした。理由: somethingNew。",
    });
  });

  it("does not say the Project was saved when an explicit apply is declined", async () => {
    vi.stubGlobal("window", { confirm: vi.fn(() => false) });
    try {
      const { controller, reports } = setup({
        open: async () => null,
        save: async () => ({ fileId: 12, fileName: "plant.json" }),
        apply: async () => ({
          status: "confirmationRequired",
          occurrences: [],
        }),
      });
      controller.save();
      await settle();
      await controller.applyAlarm();
      expect(reports.at(-1)).toEqual({
        kind: "info",
        text: "警報定義は適用していません。",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("asks before an explicit apply leaves unsaved edits out", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("window", { confirm });
    try {
      const apply = vi.fn(async (): Promise<AlarmApplyResult> => ({
        status: "applied",
      }));
      const { controller, state, reports } = setup({
        open: async () => null,
        save: async () => ({ fileId: 12, fileName: "plant.json" }),
        apply,
      });
      controller.save();
      await settle();
      await controller.applyAlarm();
      expect(confirm).not.toHaveBeenCalled();
      expect(apply).toHaveBeenCalledTimes(1);

      state.project = {
        ...state.project,
        manifest: { ...state.project.manifest, name: "編集後" },
      };
      await controller.applyAlarm();
      expect(confirm).toHaveBeenCalledWith(
        "未保存の変更は適用されません。保存済みの内容で警報定義を適用しますか？",
      );
      expect(apply).toHaveBeenCalledTimes(1);
      expect(reports.at(-1)).toEqual({
        kind: "info",
        text: "警報定義は適用していません。保存してから適用してください。",
      });

      confirm.mockReturnValue(true);
      await controller.applyAlarm();
      expect(apply).toHaveBeenCalledTimes(2);
      expect(apply).toHaveBeenLastCalledWith(12, []);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows an unknown apply code as it is", async () => {
    const { controller, reports } = setup({
      open: async () => null,
      save: async () => ({
        fileId: 12,
        fileName: "plant.json",
        apply: { status: "failed", reason: "somethingNew" },
      }),
    });
    controller.save();
    await settle();
    expect(reports.at(-1)?.text).toBe(
      "Projectは保存しましたが、警報定義を適用できませんでした。理由: somethingNew。",
    );
  });
});

describe("project files in the browser", () => {
  it("opens through the file input and has no save as", () => {
    const { controller, chosen } = setup();
    expect(controller.native).toBe(false);
    controller.openProjectFile();
    expect(chosen()).toBe(1);
  });
});
