import { untrack } from "svelte";
import { downloadBlob } from "../../download";
import { AssetStore } from "../../image-assets";
import { readProjectFile, writeProjectPackage } from "../../project-package";
import { serializeProject, type Project } from "../../project";
import { projectContent } from "../../save-state";
import { createProject } from "../../new-project";
import {
  alarmApplyReasonText,
  ProjectFileError,
  type AlarmApplyResult,
  type ProjectFileService,
} from "../../project-file-service";

/** The cause of a thrown apply refusal, in words (see `alarmApplyReasonText`). */
function applyErrorText(error: unknown): string {
  return error instanceof ProjectFileError
    ? alarmApplyReasonText(error.reason)
    : String(error);
}

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
  alarmRefresh?(): void;
  alarmUnavailable?(reason: string | null): void;
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

type AlarmApplyOrigin = "save" | "explicit";

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
  let alarmApplying = $state(false);
  let lastUnavailableReason: string | null = null;
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
  /**
   * 保存に続く適用（"save"）と「警報を適用」ボタン（"explicit"）で同じ結果を報告する。
   * 明示の適用は保存していないので、文言に保存を含めない。
   */
  async function reportAlarmApply(
    result: AlarmApplyResult | undefined,
    savedFileId: number,
    origin: AlarmApplyOrigin,
    confirmedSwitchFrom?: string,
  ) {
    const saved = origin === "save";
    const afterSave = (text: string) =>
      saved ? `Projectを保存しました。${text}` : text;
    const failedText = (reason: string) =>
      saved
        ? `Projectは保存しましたが、警報定義を適用できませんでした。${reason}。`
        : `警報定義を適用できませんでした。${reason}。`;
    host.alarmRefresh?.();
    if (result?.status === "skippedUnavailable") {
      host.alarmUnavailable?.(result.reason);
      if (lastUnavailableReason !== result.reason) {
        const message = afterSave(
          result.reason === "terminalUnavailable"
            ? "この端末の警報設定・監視状態を利用できないため、警報定義を適用していません。"
            : result.reason === "noDataDir"
              ? "警報Engineの保存先がないため、警報定義を適用していません。"
              : "認証の切替中のため、警報定義を適用していません。",
        );
        host.report("info", message);
        lastUnavailableReason = result.reason;
      }
      return;
    }
    host.alarmUnavailable?.(null);
    lastUnavailableReason = null;
    if (
      !result ||
      result.status === "skippedDifferentProject" ||
      result.status === "skippedEndpointChanged" ||
      result.status === "skippedNoHub" ||
      result.status === "skippedBusy"
    ) {
      // skippedDifferentProject・skippedNoHub・skippedEndpointChanged は保存に続く適用でだけ返る。
      if (result?.status === "skippedDifferentProject")
        host.report(
          "info",
          "別のProjectを保存しました。監視中のProjectは切り替わっていません。",
        );
      if (result?.status === "skippedNoHub")
        host.report(
          "info",
          "Projectを保存しました。Hub未設定のため警報定義は適用していません。",
        );
      if (result?.status === "skippedBusy")
        host.report(
          "info",
          afterSave(
            saved
              ? "Hubへの接続処理中のため警報定義は適用していません。接続後に明示的に適用してください。"
              : "Hubへの接続処理中のため警報定義は適用していません。接続後に再度適用してください。",
          ),
        );
      if (result?.status === "skippedEndpointChanged")
        host.report(
          "info",
          "Projectを保存しました。Hubの接続先が変わったため、警報定義は明示的に適用してください。",
        );
      return;
    }
    if (result.status === "applied") {
      if (result.warning) {
        host.report(
          "info",
          result.warning === "monitorPathNotSaved"
            ? "警報定義は適用しましたが、監視ファイルの記録を更新できませんでした。再起動後の状態を確認してください。"
            : "警報定義は復旧処理で適用されました。警報の状態を確認してください。",
        );
        return;
      }
      host.report(
        result.snapshot?.status && result.snapshot.status !== "running"
          ? "info"
          : "success",
        result.initialMonitoring
          ? result.snapshot?.status && result.snapshot.status !== "running"
            ? `このProjectを警報の監視先に設定しました。Engineは停止中です（${result.snapshot.status}）。`
            : "このProjectの警報監視を開始しました。"
          : result.snapshot?.status && result.snapshot.status !== "running"
            ? `保存済みProjectの警報定義を適用しました。Engineは停止中です（${result.snapshot.status}）。`
            : "保存済みProjectの警報定義を適用しました。",
      );
      return;
    }
    if (result.status === "failed") {
      host.report("error", failedText(alarmApplyReasonText(result.reason)));
      return;
    }
    if (
      (result.status === "switchConfirmationRequired" ||
        result.status === "confirmationRequired") &&
      fileId !== savedFileId
    ) {
      host.report(
        "info",
        "開いているProjectが変わりました。警報の状態を確認して再度適用してください。",
      );
      return;
    }
    if (result.status === "switchConfirmationRequired") {
      if (!result.monitoredProjectId) {
        host.report(
          "error",
          "監視中のProjectを確認できません。警報の状態を再取得してください。",
        );
        return;
      }
      if (confirmedSwitchFrom) {
        host.report(
          "error",
          "監視先が変わりました。警報の状態を確認して再度適用してください。",
        );
        return;
      }
      if (
        !window.confirm(
          "現在のProjectの警報監視を停止し、このProjectへ切り替えますか？",
        )
      ) {
        host.report("info", "警報の監視先は切り替えていません。");
        return;
      }
      try {
        await reportAlarmApply(
          await host.fileService?.apply?.(
            savedFileId,
            [],
            result.monitoredProjectId,
          ),
          savedFileId,
          origin,
          result.monitoredProjectId,
        );
      } catch (error) {
        host.report(
          "error",
          `警報定義を適用できませんでした。${applyErrorText(error)}。`,
        );
      }
      return;
    }
    if (!host.fileService?.apply) return;
    const yes = window.confirm(
      `未確認 ${result.occurrences.length} 件が終了します。警報定義を適用しますか？`,
    );
    if (!yes) {
      host.report(
        "info",
        saved
          ? "Projectは保存しました。警報定義は適用していません。"
          : "警報定義は適用していません。",
      );
      return;
    }
    try {
      const retried = await host.fileService.apply(
        savedFileId,
        result.occurrences,
        confirmedSwitchFrom,
      );
      if (retried.status === "confirmationRequired") {
        host.report(
          "error",
          "警報の状態が変わりました。最新の未確認件数を確かめて再度適用してください。",
        );
      } else {
        await reportAlarmApply(
          retried,
          savedFileId,
          origin,
          confirmedSwitchFrom,
        );
      }
    } catch (error) {
      host.report("error", failedText(applyErrorText(error)));
    }
  }
  async function applyAlarm() {
    if (!host.fileService?.apply) return;
    // 連打で同じ適用を重ねて送らない。切替の確認と再送も含めて 1 回が終わるまで受けない。
    if (alarmApplying) return;
    const requestedFileId = fileId;
    if (requestedFileId === null) {
      host.report(
        "info",
        "警報定義を適用するProjectファイルを先に開くか保存してください。",
      );
      return;
    }
    // host が読むのは保存済みのファイルなので、画面上の未保存の編集は適用されない。
    if (
      (projectChanged || host.draftPending) &&
      !window.confirm(
        "未保存の変更は適用されません。保存済みの内容で警報定義を適用しますか？",
      )
    ) {
      host.report(
        "info",
        "警報定義は適用していません。保存してから適用してください。",
      );
      return;
    }
    alarmApplying = true;
    try {
      await reportAlarmApply(
        await host.fileService.apply(requestedFileId, []),
        requestedFileId,
        "explicit",
      );
    } catch (error) {
      host.report(
        "error",
        `警報定義を適用できませんでした。${applyErrorText(error)}。`,
      );
    } finally {
      alarmApplying = false;
    }
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
        await reportAlarmApply(saved.apply, saved.fileId, "save");
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
    /** 「警報を適用」の要求が終わっていない間 true。 */
    get alarmApplying() {
      return alarmApplying;
    },
    /** Whether saves go to the desktop's file host (else a download). */
    native,
    adopted(next: Project, source: ProjectSource) {
      baseline = projectContent(next);
      baselineSource = source;
      lastExport = null;
      fileId = adoptingFileId;
      host.alarmRefresh?.();
    },
    requestReplacement,
    replaceNow,
    cancelReplacement,
    newProject,
    openProjectFile,
    load,
    save,
    saveAs,
    applyAlarm,
    write: () => writeProject(),
  };
}
