<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { StatusBadge } from "@banto/ui";
  import AuthControls from "../auth/AuthControls.svelte";
  import CloseConfirm from "../CloseConfirm.svelte";
  import type { NativeAuthClient } from "../auth/client";
  import { AuthSession } from "../auth/session.svelte";
  import { nativeReadSource, runtimeReadStart } from "../sources";
  import type { ReadSource } from "../../lib/designer/controllers/read-presentation.svelte";
  import { applyWindowTitle } from "../../lib/window-title";
  import { runtimeAlarmFeed } from "../project-file";
  import { createNativeHistory, runtimeHistoryContext } from "../history";
  import { createAlarmFeedController } from "../../lib/alarm-list/alarm-feed-controller.svelte";
  import AlarmListWindow from "../../lib/alarm-list/AlarmListWindow.svelte";
  import AlarmSettingsWindow from "../../lib/alarm-list/AlarmSettingsWindow.svelte";
  import { alarmSettingsEntryReason } from "../../lib/alarm-settings";
  import { setAlarmViewProject } from "../../lib/alarm-view-state.svelte";
  import type { AlarmFeed } from "../../lib/project-file-service";
  import HistoryWorkspace from "../../lib/history/HistoryWorkspace.svelte";
  import { createHistoryController } from "../../lib/history/presentation";
  import {
    trendObjectDefinitionId,
    type HistoryPreset,
    type HistoryService,
  } from "../../lib/history/workspace-model";
  import RuntimeOperator from "./RuntimeOperator.svelte";
  import { createOperationHost } from "../../lib/operation-faceplate";
  import {
    createNativeRecordingManagement,
    runtimeRecordingContext,
  } from "../recording-management";
  import type { RecordingManagementService } from "../../lib/recording-management/service";
  import {
    inspectRuntimeRecording,
    recordingFailureView,
    runtimeRecordingBadge,
    type RuntimeRecordingView,
  } from "./recording-status";
  import {
    alarmDefinitionNotice,
    loadRuntimeProject,
    projectFailureText,
    runtimeHubView,
    SECOND_INSTANCE_NOTICE,
    type HubStatus,
    type RuntimeHubView,
    type RuntimeProject,
  } from "./runtime-state";

  /**
   * The Runtime window (Runtime mode design §6-4): the operator view of the
   * host's startup Project and a top bar. No menubar, work tabs, panes, file
   * operations or preview switch, and no route to the Editor screen.
   */
  let { authClient }: { authClient: NativeAuthClient } = $props();
  // The client is fixed for the life of the window.
  // svelte-ignore state_referenced_locally
  const authSession = new AuthSession(authClient);

  let loaded = $state.raw<RuntimeProject>();
  // The faceplate's operation rows (operation stage 3 §8) for the startup Project.
  const operations = $derived(
    loaded?.status === "opened"
      ? createOperationHost(
          (command, args) => invoke(command, args),
          loaded.project.manifest.projectId,
          loaded.projectDigest,
        )
      : undefined,
  );
  let wrongMode = $state(false);
  let hub = $state<RuntimeHubView>({
    connected: false,
    needsEditor: false,
    tagCount: 0,
    text: "未接続",
  });
  let hubBusy = $state(false);
  let streamStatus = $state("");
  let readSource = $state.raw<ReadSource>();
  let alarmNotice = $state<string | null>(null);
  let secondInstance = $state(false);
  let message = $state("");

  // Hub connection and the read subscription fail separately: a failed
  // subscription start leaves the Hub connected but values stopped, so it
  // gets its own state and a retry that only re-creates the subscription.
  let readFailed = $state(false);

  const project = $derived(
    loaded?.status === "opened" ? loaded.project : undefined,
  );

  // Alarms (Runtime mode design §5, §6-4): the same feed controller as the
  // Editor, over the Runtime's commands (no `alarm_apply` / sound import).
  let alarmFeed = $state.raw<AlarmFeed>();
  const alarms = createAlarmFeedController({
    feed: () => alarmFeed,
    projectId: () => project?.manifest.projectId ?? "",
    onerror: (text) => (message = text),
  });
  $effect(() => {
    if (project) setAlarmViewProject(project);
  });
  let alarmListOpen = $state(false);
  let alarmSettingsOpen = $state(false);
  let alarmListOpener: Element | null = null;
  let alarmSettingsOpener: Element | null = null;
  let alarmEntry = $state<HTMLButtonElement>();
  const alarmSettingsReason = $derived(alarmSettingsEntryReason(alarmFeed));
  function openAlarmList() {
    if (alarmListOpen) return;
    alarmListOpener = document.activeElement;
    alarmListOpen = true;
  }
  function openAlarmSettings() {
    if (alarmSettingsOpen || alarmSettingsReason) return;
    alarmSettingsOpener = document.activeElement;
    alarmSettingsOpen = true;
  }
  /** Focus back to the opener while it is still shown, else the top bar entry. */
  function restoreFocus(opener: Element | null, entry?: HTMLElement) {
    if (
      (opener instanceof HTMLElement || opener instanceof SVGElement) &&
      opener.isConnected &&
      !opener.closest("[inert]") &&
      opener.getClientRects().length
    ) {
      opener.focus();
      return undefined;
    }
    return entry;
  }

  // History (Runtime mode design §5): the context of the startup Project comes
  // from `runtime_history_context`; the Project never changes in this window.
  let historyService = $state.raw<HistoryService>();
  const nativeHistory = createNativeHistory(
    invoke,
    (service) => (historyService = service),
    runtimeHistoryContext,
  );
  const historyController = createHistoryController();
  let historyOpen = $state(false);
  let historyPreset = $state.raw<
    (HistoryPreset & { popupToken?: object }) | undefined
  >();
  let historyOpener: Element | null = null;
  let historyEntry = $state<HTMLButtonElement>();
  /** A plan applied after startup gives a context only when asked again. */
  function askContextAgain() {
    if (project && !historyService) nativeHistory.refresh(project);
  }
  function openHistory() {
    if (!project) return;
    askContextAgain();
    historyOpener = document.activeElement;
    historyPreset = undefined;
    historyOpen = true;
  }
  /** A trend object of the operator view opens its saved definition. */
  function openTrend(screenId: string, objectId: string, popupToken?: object) {
    if (!project) return;
    const definitionId = trendObjectDefinitionId(project, screenId, objectId);
    if (!definitionId) return;
    askContextAgain();
    historyOpener = document.activeElement;
    historyPreset = { definitionId, token: {}, popupToken };
    historyOpen = true;
  }
  function retireTrend(token: object) {
    if (historyPreset?.popupToken === token) {
      historyOpen = false;
      historyPreset = undefined;
    }
  }

  // Recording (Runtime mode design §6-4, §8, §10-3 案 A): only its state, from
  // `recording_status` over the startup Project's context
  // (`runtime_recording_context`, Viewer or above). Starting, resuming and
  // stopping are Editor's; the service here never carries those operations.
  let recording = $state.raw<RuntimeRecordingView>({ state: "signedOut" });
  let recordingService: RecordingManagementService | undefined;
  let recordingInspection = 0;
  const nativeRecording = createNativeRecordingManagement(
    invoke,
    (service) => {
      recordingService = service;
      if (service) void inspectRecording();
    },
    () => {},
    undefined,
    {
      request: runtimeRecordingContext,
      failed: (error) => (recording = recordingFailureView(error)),
    },
  );
  const recordingBadge = $derived(runtimeRecordingBadge(recording));
  let recordingSessionKey: string | undefined;
  $effect(() => {
    if (!project) return;
    const view = authSession.view;
    const session = view.status === "ready" ? view.session : null;
    const sessionKey = JSON.stringify(
      session ? [session.identity.id, session.role, session.kind] : null,
    );
    if (sessionKey !== recordingSessionKey) {
      recordingSessionKey = sessionKey;
      recording = session ? { state: "loading" } : { state: "signedOut" };
    }
    nativeRecording.update(project, {
      signedIn: !!session,
      admin: false,
      sessionKey,
    });
  });
  async function inspectRecording() {
    const service = recordingService;
    if (!service) return;
    const issued = ++recordingInspection;
    recording = { state: "loading" };
    const next = await inspectRuntimeRecording(
      service,
      `runtime-inspection:${issued}`,
    );
    if (issued === recordingInspection && service === recordingService)
      recording = next;
  }
  /** A click inspects again, or asks for the context again after a failure. */
  function refreshRecording() {
    if (recordingService) void inspectRecording();
    else if (recording.state === "unavailable") {
      recording = { state: "loading" };
      nativeRecording.refresh();
    }
  }

  async function connect() {
    if (hubBusy) return;
    hubBusy = true;
    readSource = undefined;
    streamStatus = "";
    readFailed = false;
    try {
      const status = await invoke<HubStatus>("runtime_hub_connect");
      hub = runtimeHubView({ ok: true, status });
    } catch (error) {
      hub = runtimeHubView({ ok: false, error });
    } finally {
      hubBusy = false;
    }
    if (hub.connected) startReading();
  }

  /** A new source object makes the read presentation subscribe again. */
  function startReading() {
    readFailed = false;
    streamStatus = "";
    readSource = nativeReadSource(runtimeReadStart, (phase) => {
      streamStatus = phase;
      if (phase === "認証が必要") {
        readSource = undefined;
        readFailed = false;
        hub = {
          connected: false,
          needsEditor: false,
          tagCount: 0,
          text: "Hubの読取認証が失効しました",
        };
      } else if (phase === "購読開始失敗") {
        readFailed = true;
      }
    });
  }

  async function checkAlarms() {
    try {
      alarmNotice = alarmDefinitionNotice(
        await invoke<string>("runtime_alarm_status"),
      );
    } catch {
      alarmNotice = alarmDefinitionNotice(undefined);
    }
  }

  let unlisten: (() => void) | undefined;
  let disposed = false;
  onMount(() => {
    void listen("scada:second-instance", () => {
      secondInstance = true;
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    void (async () => {
      try {
        if ((await invoke("app_mode")) !== "runtime") {
          wrongMode = true;
          return;
        }
      } catch {
        wrongMode = true;
        return;
      }
      const result = await loadRuntimeProject((command, args) =>
        invoke(command, args),
      );
      if (disposed) {
        if (result.status === "opened") result.store.dispose();
        return;
      }
      loaded = result;
      if (result.status !== "opened") return;
      void applyWindowTitle(
        `${result.project.manifest.name.trim() || result.fileName} - Banto SCADA Runtime`,
      ).catch(() => {});
      void checkAlarms();
      alarmFeed = runtimeAlarmFeed((command, args) => invoke(command, args));
      nativeHistory.update(result.project);
      await connect();
    })();
  });
  onDestroy(() => {
    disposed = true;
    nativeRecording.dispose();
    unlisten?.();
    nativeHistory.dispose();
    historyController.dispose();
    if (loaded?.status === "opened") loaded.store.dispose();
  });
</script>

<div class="runtime-shell" data-runtime-shell>
  {#if secondInstance}
    <div class="runtime-notice" role="alert" data-runtime-second-instance>
      <span>{SECOND_INSTANCE_NOTICE}</span>
      <button type="button" onclick={() => (secondInstance = false)}
        >閉じる</button
      >
    </div>
  {/if}
  {#if wrongMode}
    <main class="runtime-failure" data-runtime-failure>
      <h1>Runtime の窓ではありません</h1>
    </main>
  {:else if !loaded}
    <main class="runtime-failure" role="status">Project を読んでいます…</main>
  {:else if loaded.status === "failed"}
    <main class="runtime-failure" data-runtime-failure>
      <h1>Project を開けません</h1>
      <dl>
        <dt>ファイル</dt>
        <dd data-runtime-file>{loaded.fileName || "（不明）"}</dd>
        <dt>理由</dt>
        <dd data-runtime-reason>{projectFailureText(loaded.reason)}</dd>
      </dl>
    </main>
  {:else}
    <header class="runtime-bar" aria-label="Runtime の状態">
      <strong class="runtime-name" title={loaded.fileName}
        >{loaded.project.manifest.name || loaded.fileName}</strong
      >
      <span data-hub-status title={hub.text}
        ><StatusBadge
          variant={hubBusy
            ? "neutral"
            : hub.connected
              ? readFailed
                ? "warning"
                : "success"
              : hub.needsEditor
                ? "warning"
                : "danger"}
          label={hubBusy
            ? "Hub 処理中"
            : hub.connected
              ? readFailed
                ? "Hub 接続中・読取停止"
                : `Hub 接続中（${hub.tagCount} 件）`
              : "Hub 未接続"}
        /></span
      >
      {#if !hubBusy && !hub.connected}
        <span class="runtime-hub-text" role="status" data-runtime-hub-message
          >{hub.text}</span
        >
        {#if !hub.needsEditor}
          <button type="button" onclick={() => void connect()}>再接続</button>
        {/if}
      {/if}
      {#if streamStatus && hub.connected}
        <span class="runtime-stream" role="status" data-runtime-stream
          >読取: {streamStatus}</span
        >
      {/if}
      {#if readFailed && hub.connected && !hubBusy}
        <button type="button" onclick={startReading}>読取を再試行</button>
      {/if}
      {#if alarmNotice}
        <span class="runtime-alarm-notice" role="status" data-runtime-alarm
          >{alarmNotice}</span
        >
      {/if}
      <button
        type="button"
        class="runtime-entry"
        bind:this={alarmEntry}
        onclick={openAlarmList}
        title="アラーム一覧を開く"
        data-runtime-alarm-entry
        ><StatusBadge
          variant={alarms.healthy ? "neutral" : "warning"}
          label={alarms.label}
        /></button
      >
      {#if alarms.soundNotice}<span data-alarm-sound-fallback
          ><StatusBadge variant="warning" label={alarms.soundNotice} /></span
        >{/if}
      <button
        type="button"
        class="runtime-entry"
        onclick={refreshRecording}
        disabled={recording.state === "signedOut" ||
          recording.state === "loading"}
        title={recordingBadge.title}
        data-runtime-recording
        ><StatusBadge
          variant={recordingBadge.variant}
          label={recordingBadge.label}
        /></button
      >
      {#if recordingBadge.note}
        <span class="runtime-stream" data-runtime-recording-note
          >{recordingBadge.note}</span
        >
      {/if}
      <button
        type="button"
        bind:this={historyEntry}
        onclick={openHistory}
        data-runtime-history-entry>履歴トレンド</button
      >
      {#if message}
        <span class="runtime-message" role="alert">{message}</span>
      {/if}
      <div class="runtime-auth">
        <AuthControls session={authSession} align="end" runtime />
      </div>
    </header>
    <div class="runtime-stage">
      <RuntimeOperator
        project={loaded.project}
        store={loaded.store}
        {readSource}
        onmessage={(text) => (message = text)}
        onopentrend={openTrend}
        onretiretrend={retireTrend}
        onopenalarms={openAlarmList}
        onsilencebuzzer={alarms.canSilence ? alarms.silenceBuzzer : undefined}
        {overlays}
        {operations}
      />
    </div>
  {/if}
</div>
<CloseConfirm />

<!-- The windows open over the operator view, as in the Editor's operator view. -->
{#snippet overlays()}
  {#if project}
    <HistoryWorkspace
      open={historyOpen}
      preset={historyPreset}
      onrelease={() => (historyPreset = undefined)}
      {project}
      generation={0}
      service={historyService}
      controller={historyController}
      onclose={() => (historyOpen = false)}
      focusFallback={() => {
        const opener = historyOpener;
        historyOpener = null;
        return restoreFocus(opener, historyEntry);
      }}
    />
    <AlarmListWindow
      open={alarmListOpen}
      snapshot={alarms.snapshot}
      feed={alarmFeed}
      readError={alarms.readError}
      projectId={project.manifest.projectId}
      projectRevision={project.manifest.projectRevision}
      onclose={() => (alarmListOpen = false)}
      onrefresh={alarms.refresh}
      onopensettings={openAlarmSettings}
      focusFallback={() => {
        const opener = alarmListOpener;
        alarmListOpener = null;
        return restoreFocus(opener, alarmEntry);
      }}
    />
    <AlarmSettingsWindow
      open={alarmSettingsOpen}
      feed={alarmFeed}
      snapshot={alarms.snapshot}
      soundImport={false}
      onclose={() => (alarmSettingsOpen = false)}
      onrefresh={alarms.refresh}
      focusFallback={() => {
        const opener = alarmSettingsOpener;
        alarmSettingsOpener = null;
        return restoreFocus(opener, alarmEntry);
      }}
    />
  {/if}
{/snippet}

<style>
  .runtime-shell {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    background: var(--banto-bg);
    color: var(--banto-text);
  }
  .runtime-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    min-height: 40px;
    padding: 4px 12px;
    border-bottom: 1px solid var(--banto-border);
    background: var(--banto-surface);
    font-size: 12px;
  }
  .runtime-name {
    font-size: 13px;
  }
  .runtime-alarm-notice,
  .runtime-message {
    color: var(--banto-danger, #b42318);
    font-weight: 600;
  }
  .runtime-hub-text,
  .runtime-stream {
    color: var(--banto-text-muted);
  }
  .runtime-entry {
    display: inline-flex;
    align-items: center;
    cursor: pointer;
  }
  .runtime-auth {
    margin-left: auto;
  }
  .runtime-bar button,
  .runtime-notice button {
    padding: 3px 10px;
    border: 1px solid var(--banto-border);
    border-radius: 4px;
    background: var(--banto-bg);
    color: var(--banto-text);
    font: inherit;
  }
  .runtime-notice {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    background: var(--banto-warning-bg, #fff4ce);
    color: #3b2f00;
    font-size: 13px;
  }
  .runtime-stage {
    position: relative;
    flex: 1;
    min-height: 0;
  }
  .runtime-failure {
    margin: auto;
    padding: 24px;
    text-align: center;
  }
  .runtime-failure dl {
    display: grid;
    grid-template-columns: auto auto;
    gap: 4px 12px;
    justify-content: center;
    text-align: left;
  }
  .runtime-failure dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
</style>
