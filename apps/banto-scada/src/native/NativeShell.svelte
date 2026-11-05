<script lang="ts">
  import { onMount, tick } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import App from "../App.svelte";
  import { nativeSources } from "./sources";

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
      if (connected) sources = nativeSources((phase) => (streamStatus = phase));
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

{#snippet hubControls()}
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
        <button disabled={busy} onclick={() => void disconnect()}>切断</button>
      </div>
      <p role="status">{status}</p>
      {#if streamStatus}<p role="status">読取: {streamStatus}</p>{/if}
    </div>
  </details>
{/snippet}
<App
  readSource={sources?.readSource}
  catalogSource={sources?.catalogSource}
  headerExtension={hubControls}
/>

<style>
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
    right: 0;
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
