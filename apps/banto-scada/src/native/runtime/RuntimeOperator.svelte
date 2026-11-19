<script lang="ts">
  import OperatorView from "../../lib/operator/OperatorView.svelte";
  import { operatorStartScreen } from "../../lib/operator/operator-layout";
  import {
    createReadPresentationController,
    type ReadSource,
  } from "../../lib/designer/controllers/read-presentation.svelte";
  import type { AssetStore } from "../../lib/image-assets";
  import type { Project } from "../../lib/project";

  /**
   * The operator view of the startup Project, filling the Runtime window
   * below the top bar (Runtime mode design §6-4). The Project is fixed for the
   * life of the window; nothing here edits it.
   */
  let {
    project,
    store,
    readSource,
    onmessage,
  }: {
    project: Project;
    store: AssetStore;
    readSource?: ReadSource;
    onmessage: (message: string) => void;
  } = $props();

  const readPresentation = createReadPresentationController(
    () => project,
    () => readSource,
  );
  const readContext = $derived(readPresentation.context);
  const images = $derived(
    new Map(
      project.assets.map((asset) => [
        asset.id,
        {
          url: store.url(asset.sha256),
          width: asset.width,
          height: asset.height,
        },
      ]),
    ),
  );
  // 開始画面は運転表示の設定に従う（Designer の画面は無いので先頭の画面へ）。
  const start = $derived(
    operatorStartScreen(project.operatorFrame, project.screens, ""),
  );
</script>

{#if start}
  <OperatorView
    {project}
    startScreenId={start}
    {images}
    readings={readContext.readings}
    equipmentContext={readContext.equipmentContext}
    {onmessage}
  />
{:else}
  <p class="runtime-empty" role="status">
    運転表示に出せる画面がありません（ヘッダー・フッター以外の画面が要ります）。
  </p>
{/if}

<style>
  .runtime-empty {
    margin: 24px;
    color: var(--banto-text);
  }
</style>
