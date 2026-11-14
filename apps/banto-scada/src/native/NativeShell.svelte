<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import App from "../App.svelte";
  import type { HistoryService } from "../lib/history/workspace-model";
  import { createNativeHistory } from "./history";
  import { createNativeRecordingManagement } from "./recording-management";
  import type { RecordingManagementService } from "../lib/recording-management/service";
  import { createNativeRecordingOperations } from "./recording/operations";
  import type { AsyncOperationsClient } from "../lib/recording-async/coordinator";
  import type { Project } from "../lib/project";
  import { nativeSources } from "./sources";
  import { nativeProjectFiles } from "./project-file";
  import AuthControls from "./auth/AuthControls.svelte";
  import CloseConfirm from "./CloseConfirm.svelte";
  import { StatusBadge } from "@banto/ui";
  import type { NativeAuthClient } from "./auth/client";
  import { AuthSession } from "./auth/session.svelte";

  let { authClient }: { authClient: NativeAuthClient } = $props();
  // The client is fixed for the life of the window.
  // svelte-ignore state_referenced_locally
  const authSession = new AuthSession(authClient);
  const projectFileService = nativeProjectFiles(invoke);

  interface HubStatus {
    state: string;
    tagCount?: number;
    cause?: string;
  }

  let endpoint = $state("http://127.0.0.1:8722");
  let status = $state("未接続");
  let streamStatus = $state("");
  let connected = $state(false);
  let error = $state(false);
  let tagCount = $state(0);
  let busy = $state(false);
  let sources = $state.raw<ReturnType<typeof nativeSources>>();
  // History reads the recording DB, not the Hub: it does not follow the Hub
  // connection (product-owner design §8-6).
  let historyService = $state.raw<HistoryService>();
  const nativeHistory = createNativeHistory(
    invoke,
    (service) => (historyService = service),
  );
  onDestroy(() => nativeHistory.dispose());
  // The recording management service follows the Project and the session:
  // inspection needs a session, the first setup an administrator (design §5).
  let recordingManagementService = $state.raw<RecordingManagementService>();
  // The asynchronous recording operations follow the installed recording
  // root (`recording_slot`), the session and the Project (design §7.2). The
  // synchronous operations service is never passed on the desktop.
  let recordingAsyncOperations = $state.raw<AsyncOperationsClient>();
  const nativeOperations = createNativeRecordingOperations(
    invoke,
    // The host emits a subscription's events to the webview that attached it.
    (event, handler) => getCurrentWebview().listen(event, handler),
    (client) => (recordingAsyncOperations = client),
  );
  onDestroy(() => nativeOperations.dispose());
  const nativeManagement = createNativeRecordingManagement(
    invoke,
    (service) => (recordingManagementService = service),
    (project) => nativeHistory.refresh(project),
    () => nativeOperations.refresh(),
  );
  onDestroy(() => nativeManagement.dispose());
  let currentProject = $state.raw<Project>();
  const access = $derived.by(() => {
    const view = authSession.view;
    const session = view.status === "ready" ? view.session : null;
    return {
      signedIn: !!session,
      admin: session?.role === "admin",
      sessionKey: JSON.stringify(
        session ? [session.identity.id, session.role, session.kind] : null,
      ),
    };
  });
  $effect(() => {
    if (currentProject) nativeManagement.update(currentProject, access);
  });
  $effect(() => {
    if (currentProject)
      nativeOperations.update(
        JSON.stringify([
          currentProject.manifest.projectId,
          currentProject.manifest.projectRevision,
        ]),
        access,
      );
  });
  let hubDetails: HTMLDetailsElement;

  function closeHubOnOutsidePointer(event: PointerEvent) {
    if (hubDetails?.open && !hubDetails.contains(event.target as Node))
      hubDetails.open = false;
  }

  function closeHubOnEscape(event: KeyboardEvent) {
    if (event.key !== "Escape" || !hubDetails.open) return;
    hubDetails.open = false;
    hubDetails.querySelector("summary")?.focus();
    event.stopPropagation();
  }

  async function connect() {
    if (busy) return;
    busy = true;
    sources = undefined;
    streamStatus = "";
    connected = false;
    error = false;
    await tick();
    try {
      const result = await invoke<HubStatus>("hub_connect", { endpoint });
      status =
        result.state === "connected"
          ? `Hub接続済み（タグ ${result.tagCount ?? 0} 件）`
          : `Hub接続: ${result.state}${result.cause ? ` / ${result.cause}` : ""}`;
      connected = result.state === "connected";
      error = !connected;
      tagCount = connected ? (result.tagCount ?? 0) : 0;
      if (connected)
        sources = nativeSources((phase) => {
          streamStatus = phase;
          if (phase === "認証が必要") {
            sources = undefined;
            connected = false;
            error = true;
            tagCount = 0;
            status = "Hubの読取認証が失効しました";
          }
        });
    } catch {
      status = "Hub接続に失敗しました";
      error = true;
    } finally {
      busy = false;
    }
  }

  async function disconnect() {
    if (busy) return;
    busy = true;
    sources = undefined;
    streamStatus = "";
    connected = false;
    error = false;
    tagCount = 0;
    await tick();
    try {
      await invoke("hub_disconnect");
      status = "切断しました";
    } catch {
      status = "切断処理に失敗しました";
      error = true;
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    document.addEventListener("pointerdown", closeHubOnOutsidePointer);
    document.addEventListener("keydown", closeHubOnEscape);
    void (async () => {
      busy = true;
      try {
        endpoint =
          (await invoke<string | null>("hub_saved_endpoint")) || endpoint;
      } catch {
        status = "保存済み接続先を読み取れません";
        error = true;
        return;
      } finally {
        busy = false;
      }
      await connect();
    })();
    return () => {
      document.removeEventListener("pointerdown", closeHubOnOutsidePointer);
      document.removeEventListener("keydown", closeHubOnEscape);
    };
  });
</script>

{#snippet hubBadge()}
  <span data-hub-status title={status}
    ><StatusBadge
      variant={busy
        ? "neutral"
        : connected
          ? "success"
          : error
            ? "danger"
            : "warning"}
      label={busy
        ? "Hub 処理中"
        : connected
          ? `Hub 接続中（${tagCount} 件）`
          : error
            ? "Hub 要確認"
            : "Hub 未接続"}
    /></span
  >
{/snippet}
{#snippet hubControls()}
  <div class="native-controls">
    <AuthControls session={authSession} />
    <details class="hub-connection" bind:this={hubDetails}>
      <summary aria-label={`Hub: ${status}。接続設定を開く`} title={status}>
        <span class="hub-dot" class:connected class:error></span>
        <span>Hub</span>
        <span class="hub-summary-state"
          >{busy
            ? "処理中"
            : connected
              ? `${tagCount} 件`
              : error
                ? "要確認"
                : "未接続"}</span
        >
      </summary>
      <div class="hub-popover">
        <label class="banto-field banto-field--stacked hub-endpoint">
          <span class="banto-field-label">Hub 接続先</span>
          <input
            class="banto-field-control"
            id="hub-endpoint"
            bind:value={endpoint}
            disabled={busy}
          />
        </label>
        <div class="hub-actions">
          <button disabled={busy} onclick={() => void connect()}>接続</button>
          <button disabled={busy} onclick={() => void disconnect()}>切断</button
          >
        </div>
        <p role="status">{status}</p>
        {#if streamStatus}<p role="status">読取: {streamStatus}</p>{/if}
      </div>
    </details>
  </div>
{/snippet}
<App
  readSource={sources?.readSource}
  catalogSource={sources?.catalogSource}
  {historyService}
  {recordingManagementService}
  {recordingAsyncOperations}
  onprojectchange={(project) => {
    nativeHistory.update(project);
    currentProject = project;
  }}
  {projectFileService}
  headerExtension={hubControls}
  connectionStatus={hubBadge}
/>
<CloseConfirm />

<style>
  .native-controls {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .hub-connection {
    position: relative;
    z-index: calc(var(--banto-z-header, 100) + 1);
    font-size: 12px;
  }
  .hub-connection summary {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 28px;
    padding: 3px 7px;
    list-style: none;
    border: 1px solid var(--banto-border);
    border-radius: 4px;
    color: var(--banto-text);
    cursor: pointer;
    white-space: nowrap;
  }
  .hub-connection summary::-webkit-details-marker {
    display: none;
  }
  .hub-connection summary:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
  .hub-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--banto-text-muted);
  }
  .hub-dot.connected {
    background: var(--banto-primary);
  }
  .hub-dot.error {
    background: var(--banto-danger, #b42318);
  }
  .hub-summary-state {
    color: var(--banto-text-muted);
  }
  .hub-popover {
    position: absolute;
    top: calc(100% + 5px);
    left: 0;
    width: min(340px, calc(100vw - 24px));
    padding: 12px;
    border: 1px solid var(--banto-border);
    border-radius: 6px;
    background: var(--banto-surface);
    color: var(--banto-text);
    box-shadow: 0 10px 28px #0004;
  }
  .hub-endpoint {
    width: 100%;
  }
  .hub-actions {
    display: flex;
    gap: 6px;
    margin-top: 10px;
  }
  .hub-actions button {
    padding: 4px 10px;
    border: 1px solid var(--banto-border);
    border-radius: 4px;
    background: var(--banto-bg);
    color: var(--banto-text);
    font: inherit;
  }
  .hub-popover p {
    margin: 8px 0 0;
    overflow-wrap: anywhere;
  }
</style>
