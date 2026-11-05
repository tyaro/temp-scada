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
  let busy = $state(false);
  let sources = $state.raw<ReturnType<typeof nativeSources>>();

  async function connect() {
    if (busy) return;
    busy = true;
    sources = undefined;
    streamStatus = "";
    await tick();
    try {
      const result = await invoke<HubStatus>("hub_connect", { endpoint });
      status =
        result.state === "connected"
          ? `Hub接続済み（タグ ${result.tagCount ?? 0} 件）`
          : `Hub接続: ${result.state}${result.cause ? ` / ${result.cause}` : ""}`;
      if (result.state === "connected")
        sources = nativeSources((phase) => (streamStatus = phase));
    } catch {
      status = "Hub接続に失敗しました";
    } finally {
      busy = false;
    }
  }

  async function disconnect() {
    if (busy) return;
    busy = true;
    sources = undefined;
    streamStatus = "";
    await tick();
    try {
      await invoke("hub_disconnect");
      status = "切断しました";
    } catch {
      status = "切断処理に失敗しました";
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    void (async () => {
      busy = true;
      try {
        endpoint =
          (await invoke<string | null>("hub_saved_endpoint")) || endpoint;
      } catch {
        status = "保存済み接続先を読み取れません";
        return;
      } finally {
        busy = false;
      }
      await connect();
    })();
  });
</script>

<div class="hub-bar">
  <label class="banto-field banto-field--stacked hub-endpoint">
    <span class="banto-field-label">Hub</span>
    <input
      class="banto-field-control"
      id="hub-endpoint"
      bind:value={endpoint}
      disabled={busy}
    />
  </label>
  <button disabled={busy} onclick={() => void connect()}>接続</button>
  <button disabled={busy} onclick={() => void disconnect()}>切断</button>
  <span role="status">{status}</span>
  {#if streamStatus}<span role="status">読取: {streamStatus}</span>{/if}
</div>
<App readSource={sources?.readSource} catalogSource={sources?.catalogSource} />

<style>
  .hub-bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.35rem 0.75rem;
    font:
      13px system-ui,
      sans-serif;
    color: #e2e8f0;
    background: #0f172a;
  }
  .hub-endpoint {
    width: 19rem;
  }
  .hub-bar button {
    padding: 0.2rem 0.6rem;
  }
</style>
