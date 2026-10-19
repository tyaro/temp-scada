<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import {
    createPreviewFullscreen,
    type PreviewFullscreenState,
  } from "../preview-fullscreen";
  let {
    scope,
    onactive,
    onmessage,
  }: {
    scope: string | null;
    onactive: (active: boolean) => void;
    onmessage: (message: string) => void;
  } = $props();
  let status = $state<PreviewFullscreenState>({
    supported: false,
    active: false,
    busy: false,
  });
  const controller = createPreviewFullscreen(
    {
      supported: () =>
        document.fullscreenEnabled &&
        typeof document.documentElement.requestFullscreen === "function",
      isTarget: () => document.fullscreenElement === document.documentElement,
      hasFullscreen: () => !!document.fullscreenElement,
      request: () => document.documentElement.requestFullscreen(),
      exit: () => document.exitFullscreen(),
    },
    (next) => (status = next),
    (message) => onmessage(message),
  );
  $effect(() => controller.setScope(scope));
  $effect(() => onactive(status.active));
  onMount(() => {
    controller.sync();
    document.addEventListener("fullscreenchange", controller.sync);
    return () =>
      document.removeEventListener("fullscreenchange", controller.sync);
  });
  onDestroy(controller.dispose);
</script>

{#if scope !== null || status.active}
  <button
    data-preview-fullscreen
    aria-label={status.active ? "全画面を終了" : "全画面で表示確認"}
    disabled={status.busy || (!status.supported && !status.active)}
    title={!status.supported
      ? "このブラウザでは全画面表示を利用できません。"
      : status.active
        ? "ブラウザのEsc操作でも終了できます。"
        : "表示確認を全画面で開きます。Escで戻ります。"}
    onclick={() => void controller.toggle()}
  >
    {status.busy
      ? "切替中…"
      : status.active
        ? "全画面を終了（Esc）"
        : "全画面で表示確認"}
  </button>
{/if}
