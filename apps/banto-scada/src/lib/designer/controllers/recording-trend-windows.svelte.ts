import type { EditCommand } from "../../editor";
import { trendObjectDefinitionId } from "../../history/workspace-model";
import type { Project } from "../../project";
import type { DesiredRecordingPlan } from "../../recording-plan";
import type { TrendDefinition } from "../../trend-definitions";

/**
 * 記録計画・トレンド定義・トレンド履歴の窓（R7e2）。3 つの窓は互いの開閉を
 * 開く条件に使う（履歴はトレンド定義の編集中に開かず、定義は履歴の表示中に
 * 開かない）ので 1 つの controller にまとめる。要求は開いたときの Project・
 * 世代・画面・mode を持ち、今と合わなくなった要求は `current…` で外れる。
 * 外れた要求を捨てる `$effect` は App に残し、ここのメソッドを呼ぶ。
 * 共通の `edit`／draft の確認（`withScreen`）・連続配置の停止・履歴の読取の枠
 * （`historyController`）は App が持つ。
 */
export interface RecordingTrendWindowsHost {
  readonly project: Project;
  readonly workspaceGeneration: number;
  /** Designer で表示中の画面 ID。 */
  readonly screenId: string;
  readonly mode: "edit" | "preview";
  /** Symbol 定義の編集中は値を持つ（真偽だけを見る）。 */
  readonly activeDefinition: unknown;
  readonly menuBlocked: boolean;
  readonly busy: boolean;
  readonly replacement: unknown;
  /** draft の確認を経て、画面がまだあれば `action` を呼ぶ（App の `withScreen`）。 */
  withScreen(id: string, action: () => void): void;
  stopPlacement(): void;
  edit(command: EditCommand, onerror: (message: string) => void): boolean;
  /** トレンドを新しく置くときの枠（表示中の範囲に合わせる）。 */
  trendFrame(): { x: number; y: number; width: number; height: number };
}

export type RecordingEditRequest = {
  project: Project;
  generation: number;
  screenId: string;
  /** Preview opens the plan for reading only (UX review F-7). */
  readonly: boolean;
};

type TrendRequest = {
  project: Project;
  generation: number;
  screenId: string;
  definitionId?: string;
};

type HistoryPreset = {
  project: Project;
  generation: number;
  definitionId: string;
  token: object;
  screenId: string;
  sourceScreenId: string;
  objectId: string;
  mode: string;
  popupToken?: object;
};

export function createRecordingTrendWindowsController(
  host: RecordingTrendWindowsHost,
) {
  let trendRequest = $state.raw<TrendRequest | null>(null);
  let trendError = $state("");
  let recordingRequest = $state.raw<RecordingEditRequest | null>(null);
  // Keep one closed view for Banto's open -> closed focus transition. A new
  // request keys a fresh draft; adopting another Project drops the old view.
  let recordingView = $state.raw<RecordingEditRequest | null>(null);
  let recordingError = $state("");
  let historyOpen = $state(false);
  // Each explicit open is a new owner, even for the same saved definition.
  let historyPreset = $state.raw<HistoryPreset | undefined>();
  let historySvgOpener: SVGElement | null = null;

  function openRecordingPlan() {
    if (host.menuBlocked || host.activeDefinition) return;
    const generation = host.workspaceGeneration,
      id = host.screenId,
      readonly = host.mode !== "edit";
    host.withScreen(id, () => {
      if (
        generation !== host.workspaceGeneration ||
        (host.mode !== "edit") !== readonly ||
        host.activeDefinition
      )
        return;
      host.stopPlacement();
      recordingError = "";
      recordingRequest = {
        project: host.project,
        generation,
        screenId: id,
        readonly,
      };
      recordingView = recordingRequest;
    });
  }
  const currentRecordingRequest = $derived(
    recordingRequest &&
      recordingRequest.project === host.project &&
      recordingRequest.generation === host.workspaceGeneration &&
      recordingRequest.screenId === host.screenId &&
      recordingRequest.readonly === (host.mode !== "edit") &&
      !host.activeDefinition
      ? recordingRequest
      : null,
  );
  function saveRecordingPlan(
    request: RecordingEditRequest,
    plan: DesiredRecordingPlan,
  ) {
    if (currentRecordingRequest !== request || host.busy || host.replacement)
      return;
    recordingError = "";
    if (
      host.edit(
        {
          type: "save-recording-plan",
          plan,
          expected: request.project.recordingPlan ?? null,
        },
        (message) => (recordingError = message),
      )
    )
      recordingRequest = null;
  }
  function removeRecordingPlan(request: RecordingEditRequest) {
    if (
      currentRecordingRequest !== request ||
      !request.project.recordingPlan ||
      host.busy ||
      host.replacement
    )
      return;
    recordingError = "";
    if (
      host.edit(
        {
          type: "remove-recording-plan",
          expected: request.project.recordingPlan,
        },
        (message) => (recordingError = message),
      )
    )
      recordingRequest = null;
  }
  function closeRecordingPlan(request: RecordingEditRequest) {
    if (recordingRequest === request) recordingRequest = null;
  }
  // 今と合わなくなった要求を捨てる（App の `$effect` から呼ぶ）。
  function dropStaleRecordingRequest() {
    if (recordingRequest && !currentRecordingRequest) recordingRequest = null;
  }
  // Project の採用で記録計画の要求と閉じた窓の残りを捨てる。
  function resetRecordingPlan() {
    recordingRequest = null;
    recordingView = null;
  }

  const currentHistoryPreset = $derived(
    historyPreset &&
      historyPreset.project === host.project &&
      historyPreset.generation === host.workspaceGeneration &&
      historyPreset.screenId === host.screenId &&
      historyPreset.mode === host.mode &&
      !host.activeDefinition
      ? historyPreset
      : undefined,
  );
  // 今と合わなくなった履歴の preset で開いた窓を閉じる（App の `$effect` から呼ぶ）。
  function closeStaleHistory() {
    if (historyPreset && !currentHistoryPreset) {
      historyOpen = false;
      historyPreset = undefined;
    }
  }
  function openTrendHistory(
    sourceScreenId: string,
    objectId: string,
    popupToken?: object,
  ) {
    if (host.busy || host.replacement || trendRequest || host.activeDefinition)
      return;
    const originId = host.screenId,
      generation = host.workspaceGeneration,
      sourceMode = host.mode;
    host.withScreen(originId, () => {
      if (
        generation !== host.workspaceGeneration ||
        host.screenId !== originId ||
        host.mode !== sourceMode ||
        host.activeDefinition
      )
        return;
      // Resolve against the current Project after any pending form was applied.
      const project = host.project;
      const definitionId = trendObjectDefinitionId(
        project,
        sourceScreenId,
        objectId,
      );
      if (!definitionId) return;
      host.stopPlacement();
      historySvgOpener =
        document.activeElement instanceof SVGElement
          ? document.activeElement
          : null;
      historyPreset = {
        project,
        generation,
        definitionId,
        token: {},
        screenId: originId,
        sourceScreenId,
        objectId,
        mode: sourceMode,
        popupToken,
      };
      historyOpen = true;
    });
  }
  function retirePopupTrend(token: object) {
    if (historyPreset?.popupToken === token) {
      historyOpen = false;
      historyPreset = undefined;
    }
  }
  // メニューから preset なしで開く（`menuBlocked` の判定は App が先にする）。
  function openHistory() {
    historySvgOpener = null;
    historyPreset = undefined;
    historyOpen = true;
  }
  function closeHistory() {
    historyOpen = false;
  }
  function releaseHistoryPreset() {
    historyPreset = undefined;
  }
  // 閉じたときの SVG へのフォーカスの戻り先を一度だけ渡す（受け取ったら空にする）。
  function takeHistorySvgOpener() {
    const opener = historySvgOpener;
    historySvgOpener = null;
    return opener;
  }

  function openTrendDefinitions(definitionId?: string) {
    if (
      host.mode !== "edit" ||
      host.activeDefinition ||
      host.busy ||
      host.replacement ||
      historyOpen
    )
      return;
    const id = host.screenId,
      generation = host.workspaceGeneration;
    host.withScreen(id, () => {
      if (
        generation !== host.workspaceGeneration ||
        host.activeDefinition ||
        host.mode !== "edit"
      )
        return;
      host.stopPlacement();
      trendError = "";
      trendRequest = {
        project: host.project,
        generation,
        screenId: id,
        definitionId,
      };
    });
  }
  const currentTrendRequest = $derived(
    trendRequest &&
      trendRequest.project === host.project &&
      trendRequest.generation === host.workspaceGeneration &&
      trendRequest.screenId === host.screenId &&
      host.mode === "edit" &&
      !host.activeDefinition
      ? trendRequest
      : null,
  );
  function saveTrend(
    definition: TrendDefinition,
    create: boolean,
    place: boolean,
  ) {
    const request = currentTrendRequest;
    if (!request) return;
    trendError = "";
    const frame = host.trendFrame();
    if (
      host.edit(
        {
          type: "save-trend",
          definition,
          create,
          ...(place
            ? { placement: { screenId: request.screenId, frame } }
            : {}),
        },
        (message) => (trendError = message),
      )
    )
      trendRequest = null;
  }
  function removeTrend(trendId: string) {
    if (!currentTrendRequest) return;
    trendError = "";
    if (
      host.edit(
        { type: "remove-trend", trendId },
        (message) => (trendError = message),
      )
    )
      trendRequest = null;
  }
  function closeTrendDefinitions() {
    trendRequest = null;
  }
  // 今と合わなくなった要求を捨てる（App の `$effect` から呼ぶ）。
  function dropStaleTrendRequest() {
    if (trendRequest && !currentTrendRequest) trendRequest = null;
  }

  return {
    get recordingRequest() {
      return recordingRequest;
    },
    get recordingView() {
      return recordingView;
    },
    get recordingError() {
      return recordingError;
    },
    get currentRecordingRequest() {
      return currentRecordingRequest;
    },
    get trendRequest() {
      return trendRequest;
    },
    get trendError() {
      return trendError;
    },
    get currentTrendRequest() {
      return currentTrendRequest;
    },
    get historyOpen() {
      return historyOpen;
    },
    get historyPreset() {
      return historyPreset;
    },
    get currentHistoryPreset() {
      return currentHistoryPreset;
    },
    openRecordingPlan,
    saveRecordingPlan,
    removeRecordingPlan,
    closeRecordingPlan,
    dropStaleRecordingRequest,
    resetRecordingPlan,
    openTrendHistory,
    retirePopupTrend,
    closeStaleHistory,
    openHistory,
    closeHistory,
    releaseHistoryPreset,
    takeHistorySvgOpener,
    openTrendDefinitions,
    saveTrend,
    removeTrend,
    closeTrendDefinitions,
    dropStaleTrendRequest,
  };
}
