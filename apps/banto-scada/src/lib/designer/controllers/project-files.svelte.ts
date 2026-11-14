import { untrack } from "svelte";
import { downloadBlob } from "../../download";
import { AssetStore } from "../../image-assets";
import { readProjectFile, writeProjectPackage } from "../../project-package";
import { serializeProject, type Project } from "../../project";
import { projectContent } from "../../save-state";
import { createProject } from "../../new-project";
import type { ProjectFileService } from "../../project-file-service";

export type ProjectSource = "sample" | "file" | "new";
export interface ProjectReadTarget {
  readonly connected: boolean;
  clear(): void;
}
export interface ProjectFilesHost {
  readonly project: Project;
  readonly generation: number;
  readonly store: AssetStore;
  readonly draftPending: boolean;
  /** The desktop's file host; without it (the browser) a save downloads. */
  readonly fileService?: ProjectFileService;
  chooseFile(): void;
  allow(run: () => void): boolean;
  /** App adopts Project and resets the editor; it calls adopted at the existing baseline boundary. */
  adopt(next: Project, source: ProjectSource, store: AssetStore): void;
  report(
    kind: "info" | "error" | "success",
    text: string,
    options?: { toast?: boolean },
  ): void;
}

/** Own file candidates and save baselines; App remains the only Project/history owner. */
export function createProjectFilesController(host: ProjectFilesHost) {
  let busy = $state(false);
  let baseline = $state(untrack(() => projectContent(host.project)));
  let baselineSource = $state<"sample" | "file" | "download" | "saved" | "new">(
    "sample",
  );
  let lastExport = $state<string | null>(null);
  const native = !!host.fileService;
  /** The host's file of the current Project (desktop), set on adoption. */
  let fileId = $state<number | null>(null);
  let adoptingFileId: number | null = null;
  let projectChanged = $derived(projectContent(host.project) !== baseline);
  // A pending file candidate is replaced as a unit; keep its Project unproxied
  // when the user confirms adoption into App's immutable document state.
  let replacement = $state.raw<{
    project: Project;
    source: "sample" | "file" | "new";
    store: AssetStore;
    fileId: number | null;
  } | null>(null);

  let exporting = $state(false);
  let exportingName = $state("");
  const saveLabel = $derived(
    exporting
      ? native
        ? `保存中（${exportingName}）`
        : `書出し中（${exportingName}）`
      : projectChanged
        ? native
          ? "未保存の変更あり"
          : "未書き出しの変更あり"
        : baselineSource === "download"
          ? "書き出し要求後の変更なし"
          : baselineSource === "saved"
            ? "保存後の変更なし"
            : baselineSource === "file"
              ? "読込後の変更なし"
              : baselineSource === "new"
                ? native
                  ? "新しいProject・未保存"
                  : "新しいProject・未書き出し"
                : "サンプルからの変更なし",
  );
  function adoptNow(
    next: Project,
    source: "sample" | "file" | "new",
    store: AssetStore,
    nextFileId: number | null,
  ) {
    adoptingFileId = nextFileId;
    try {
      host.adopt(next, source, store);
    } finally {
      adoptingFileId = null;
    }
  }
  function requestReplacement(
    next: Project,
    source: "sample" | "file" | "new",
    generation = host.generation,
    store = new AssetStore(),
    nextFileId: number | null = null,
  ) {
    if (generation !== host.generation) {
      store.dispose();
      return;
    }
    if (
      !host.allow(() =>
        requestReplacement(next, source, generation, store, nextFileId),
      )
    )
      return;
    if (projectChanged)
      replacement = { project: next, source, store, fileId: nextFileId };
    else adoptNow(next, source, store, nextFileId);
  }
  function replaceNow() {
    const next = replacement;
    replacement = null;
    if (next) adoptNow(next.project, next.source, next.store, next.fileId);
  }
  function cancelReplacement() {
    replacement?.store.dispose();
    replacement = null;
  }
  function newProject() {
    if (busy || host.draftPending || replacement) return;
    requestReplacement(createProject(), "new");
  }
  function openProjectFile() {
    if (busy || host.draftPending || replacement) return;
    if (host.fileService) void openNative(host.fileService);
    else host.chooseFile();
  }
  let fileReadRequest = 0;
  /** The desktop: the host's dialog picks and reads the file. */
  async function openNative(service: ProjectFileService) {
    const generation = host.generation;
    const request = ++fileReadRequest;
    const current = () =>
      request === fileReadRequest && generation === host.generation;
    busy = true;
    try {
      const opened = await service.open();
      if (!opened || !current()) return;
      const next = await readProjectFile(opened.file);
      if (!current()) {
        next.store.dispose();
        return;
      }
      requestReplacement(
        next.project,
        "file",
        generation,
        next.store,
        opened.fileId,
      );
    } catch (e) {
      if (!current()) return;
      host.report(
        "error",
        `読込エラー: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      if (request === fileReadRequest) busy = false;
    }
  }
  async function load(file: File | undefined, input: ProjectReadTarget) {
    if (!file || !input.connected) return;
    const generation = host.generation;
    const request = ++fileReadRequest;
    const current = () =>
      request === fileReadRequest &&
      generation === host.generation &&
      input.connected;
    busy = true;
    try {
      const next = await readProjectFile(file);
      if (!current()) {
        next.store.dispose();
        return;
      }
      requestReplacement(next.project, "file", generation, next.store);
    } catch (e) {
      if (!current()) return;
      host.report(
        "error",
        `読込エラー: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      if (request === fileReadRequest) busy = false;
      if (input.connected) input.clear();
    }
  }
  function save() {
    if (replacement) {
      writeProject();
      return;
    }
    if (!host.allow(save)) return;
    writeProject();
  }
  /** The desktop's "save as": always ask where to save. */
  function saveAs() {
    if (!host.fileService) return save();
    if (replacement) {
      void writeProject(true);
      return;
    }
    if (!host.allow(saveAs)) return;
    void writeProject(true);
  }
  async function writeProject(asNew = false) {
    if (exporting) {
      host.report(
        "info",
        native
          ? `${exportingName}の保存中です。完了をお待ちください。`
          : `${exportingName}の書出し中です。完了をお待ちください。`,
      );
      return;
    }
    const snapshot = host.project,
      generation = host.generation,
      store = host.store;
    exportingName = snapshot.manifest.name;
    exporting = true;
    try {
      const packaged = snapshot.assets.length > 0;
      const blob = packaged
        ? await writeProjectPackage(snapshot, store)
        : new Blob([serializeProject(snapshot)], { type: "application/json" });
      if (host.fileService) {
        const saved = await host.fileService.save({
          fileId: generation === host.generation ? fileId : null,
          format: packaged ? "package" : "json",
          name: snapshot.manifest.name,
          saveAs: asNew,
          content: new Uint8Array(await blob.arrayBuffer()),
        });
        if (!saved) {
          host.report("info", "保存を取り消しました。");
          return;
        }
        if (generation === host.generation) {
          fileId = saved.fileId;
          baseline = projectContent(snapshot);
          baselineSource = "saved";
          lastExport = new Date().toLocaleTimeString("ja-JP");
        }
        host.report(
          "success",
          `${snapshot.manifest.name}を${saved.fileName}へ保存しました。`,
          { toast: true },
        );
        return;
      }
      downloadBlob(blob, packaged ? "project.bantoscada" : "project.json");
      if (generation === host.generation) {
        baseline = projectContent(snapshot);
        baselineSource = "download";
        lastExport = new Date().toLocaleTimeString("ja-JP");
      }
      host.report(
        "success",
        packaged
          ? `${snapshot.manifest.name}：画像同梱packageのダウンロードを開始しました。保存先でファイルを確認してください。`
          : `${snapshot.manifest.name}：Project JSON のダウンロードを開始しました。保存先でファイルを確認してください。`,
        { toast: true },
      );
    } catch (e) {
      host.report(
        "error",
        `${snapshot.manifest.name}の${native ? "保存" : "書き出し"}エラー: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      exporting = false;
      exportingName = "";
    }
  }

  return {
    get busy() {
      return busy;
    },
    get projectChanged() {
      return projectChanged;
    },
    get replacement() {
      return replacement;
    },
    get saveLabel() {
      return saveLabel;
    },
    get lastExport() {
      return lastExport;
    },
    /** Whether saves go to the desktop's file host (else a download). */
    native,
    adopted(next: Project, source: ProjectSource) {
      baseline = projectContent(next);
      baselineSource = source;
      lastExport = null;
      fileId = adoptingFileId;
    },
    requestReplacement,
    replaceNow,
    cancelReplacement,
    newProject,
    openProjectFile,
    load,
    save,
    saveAs,
    write: () => writeProject(),
  };
}
