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
  import RuntimeOperator from "./RuntimeOperator.svelte";
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

  async function connect() {
    if (hubBusy) return;
    hubBusy = true;
    readSource = undefined;
    streamStatus = "";
    try {
      const status = await invoke<HubStatus>("runtime_hub_connect");
      hub = runtimeHubView({ ok: true, status });
    } catch (error) {
      hub = runtimeHubView({ ok: false, error });
    } finally {
      hubBusy = false;
    }
    if (hub.connected)
      readSource = nativeReadSource(runtimeReadStart, (phase) => {
        streamStatus = phase;
        if (phase === "認証が必要") {
          readSource = undefined;
          hub = {
            connected: false,
            needsEditor: false,
            tagCount: 0,
            text: "Hubの読取認証が失効しました",
          };
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
      await connect();
    })();
  });
  onDestroy(() => {
    disposed = true;
    unlisten?.();
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
              ? "success"
              : hub.needsEditor
                ? "warning"
                : "danger"}
          label={hubBusy
            ? "Hub 処理中"
            : hub.connected
              ? `Hub 接続中（${hub.tagCount} 件）`
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
        <span class="runtime-stream" role="status">読取: {streamStatus}</span>
      {/if}
      {#if alarmNotice}
        <span class="runtime-alarm-notice" role="status" data-runtime-alarm
          >{alarmNotice}</span
        >
      {/if}
      {#if message}
        <span class="runtime-message" role="alert">{message}</span>
      {/if}
      <div class="runtime-auth">
        <AuthControls session={authSession} align="end" />
      </div>
    </header>
    <div class="runtime-stage">
      <RuntimeOperator
        project={loaded.project}
        store={loaded.store}
        {readSource}
        onmessage={(text) => (message = text)}
      />
    </div>
  {/if}
</div>
<CloseConfirm />

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
