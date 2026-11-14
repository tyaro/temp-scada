import { describe, expect, it } from "vitest";
import { createProjectFilesController } from "./project-files.svelte";
import { createProject } from "../../new-project";
import { serializeProject, type Project } from "../../project";
import { AssetStore } from "../../image-assets";
import type {
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
});

describe("project files in the browser", () => {
  it("opens through the file input and has no save as", () => {
    const { controller, chosen } = setup();
    expect(controller.native).toBe(false);
    controller.openProjectFile();
    expect(chosen()).toBe(1);
  });
});
