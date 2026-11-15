import { describe, expect, it, vi } from "vitest";
import { createProjectFilesController } from "./project-files.svelte";
import { createProject } from "../../new-project";
import { serializeProject, type Project } from "../../project";
import { AssetStore } from "../../image-assets";
import type {
  AlarmApplyResult,
  ProjectFileService,
  SaveProjectFileRequest,
} from "../../project-file-service";

/** A host whose adopt behaves as App's: it calls `adopted` on the controller. */
function setup(service?: ProjectFileService) {
  const reports: { kind: string; text: string }[] = [];
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
      chooseFile: () => chosen++,
      allow: () => true,
      adopt(next: Project, source) {
        state.project = next;
        controller.adopted(next, source);
        state.generation++;
      },
      report: (kind, text) => reports.push({ kind, text }),
    });
  return { controller, state, reports, chosen: () => chosen };
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
});

describe("project files in the browser", () => {
  it("opens through the file input and has no save as", () => {
    const { controller, chosen } = setup();
    expect(controller.native).toBe(false);
    controller.openProjectFile();
    expect(chosen()).toBe(1);
  });
});
