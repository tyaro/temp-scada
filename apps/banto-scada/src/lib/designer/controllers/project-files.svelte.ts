import { untrack } from "svelte";
import { AssetStore } from "../../image-assets";
import { readProjectFile, writeProjectPackage } from "../../project-package";
import { serializeProject, type Project } from "../../project";
import { projectContent } from "../../save-state";
import { createProject } from "../../new-project";

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
  chooseFile(): void;
  allow(run: () => void): boolean;
  /** App adopts Project and resets the editor; it calls adopted at the existing baseline boundary. */
  adopt(next: Project, source: ProjectSource, store: AssetStore): void;
  report(kind: "info" | "error" | "success", text: string): void;
}

/** Own file candidates and save baselines; App remains the only Project/history owner. */
export function createProjectFilesController(host: ProjectFilesHost) {
  let busy = $state(false);
  let baseline = $state(untrack(() => projectContent(host.project)));
  let baselineSource = $state<"sample" | "file" | "download" | "new">("sample");
  let lastExport = $state<string | null>(null);
  let projectChanged = $derived(projectContent(host.project) !== baseline);
  // A pending file candidate is replaced as a unit; keep its Project unproxied
  // when the user confirms adoption into App's immutable document state.
  let replacement = $state.raw<{
    project: Project;
    source: "sample" | "file" | "new";
    store: AssetStore;
  } | null>(null);

  let exporting = $state(false);
  let exportingName = $state("");
  const saveLabel = $derived(
    exporting
      ? `書出し中（${exportingName}）`
      : projectChanged
        ? "未書き出しの変更あり"
        : baselineSource === "download"
          ? "書き出し要求後の変更なし"
          : baselineSource === "file"
            ? "読込後の変更なし"
            : baselineSource === "new"
              ? "新しいProject・未書き出し"
              : "サンプルからの変更なし",
  );
  function requestReplacement(
    next: Project,
    source: "sample" | "file" | "new",
    generation = host.generation,
    store = new AssetStore(),
  ) {
    if (generation !== host.generation) {
      store.dispose();
      return;
    }
    if (!host.allow(() => requestReplacement(next, source, generation, store)))
      return;
    if (projectChanged) replacement = { project: next, source, store };
    else host.adopt(next, source, store);
  }
  function replaceNow() {
    const next = replacement;
    replacement = null;
    if (next) host.adopt(next.project, next.source, next.store);
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
    host.chooseFile();
  }
  let fileReadRequest = 0;
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
  async function writeProject() {
    if (exporting) {
      host.report(
        "info",
        `${exportingName}の書出し中です。完了をお待ちください。`,
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
      const url = URL.createObjectURL(blob);
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = packaged ? "project.bantoscada" : "project.json";
        link.click();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
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
      );
    } catch (e) {
      host.report(
        "error",
        `${snapshot.manifest.name}の書き出しエラー: ${e instanceof Error ? e.message : String(e)}`,
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
    adopted(next: Project, source: ProjectSource) {
      baseline = projectContent(next);
      baselineSource = source;
      lastExport = null;
    },
    requestReplacement,
    replaceNow,
    cancelReplacement,
    newProject,
    openProjectFile,
    load,
    save,
    write: writeProject,
  };
}
