<script lang="ts">
  import { tick } from "svelte";
  import ImagePainting from "../ImagePainting.svelte";
  import { parseImageFit, type ImageFit } from "../image-fit";
  import type { ImageCrop } from "../image-crop";
  import type { createDraftGuard } from "./drafts.svelte";
  let {
    image,
    fit,
    crop,
    width,
    height,
    objectId,
    targetKey,
    locked,
    drafts,
    onsubmit,
  }: {
    image?: { url: string; width: number; height: number };
    fit: ImageFit;
    crop?: ImageCrop;
    width: number;
    height: number;
    objectId: string;
    targetKey: string;
    locked: boolean;
    drafts: ReturnType<typeof createDraftGuard>;
    onsubmit: (event: SubmitEvent) => void;
  } = $props();
  let form: HTMLFormElement;
  let preview = $state<ImageFit>("contain"),
    error = $state("");
  async function refresh() {
    await tick();
    if (!form?.isConnected) return;
    try {
      preview = locked
        ? fit
        : parseImageFit(new FormData(form).get("imageFit"));
      error = "";
    } catch (e) {
      error = e instanceof Error ? e.message : "表示方式を確認してください。";
    }
  }
  function track(node: HTMLFormElement, values: Record<string, string>) {
    form = node;
    const tracked = drafts.track(node, values);
    void refresh();
    return {
      update(values: Record<string, string>) {
        tracked.update(values);
        void refresh();
      },
      destroy: tracked.destroy,
    };
  }
</script>

<form
  use:track={{ imageFit: fit }}
  data-editor-form="image-fit"
  data-object-id={objectId}
  data-target-key={targetKey}
  aria-label="画像の表示方式"
  oninput={() => void refresh()}
  onreset={() => void refresh()}
  {onsubmit}
>
  <fieldset disabled={locked}>
    <legend>画像の表示方式</legend>
    <label
      >表示方式<select name="imageFit" aria-label="画像の表示方式">
        <option value="contain">全体を収める（contain）</option><option
          value="cover">枠を埋める（cover）</option
        ><option value="stretch">枠へ伸ばす（stretch）</option>
      </select></label
    >
    <p>
      coverは比率を保って中央を表示し、はみ出す部分を隠します。stretchは枠に合わせて比率が変わります。切出し範囲・原本・配置枠は変更しません。
    </p>
    {#if error}<p role="status">{error}</p>
    {:else if image}
      <figure>
        <figcaption>未適用の枠内表示 · {width} × {height}</figcaption>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          aria-label="未適用の画像表示方式の見本"
          ><ImagePainting {image} {width} {height} {crop} fit={preview} /></svg
        >
      </figure>
    {/if}
    <button type="submit">表示方式を適用</button>
  </fieldset>
</form>

<style>
  form {
    padding: 12px 0;
    border-bottom: 1px solid var(--banto-border);
  }
  fieldset {
    border: 0;
    padding: 0;
    margin: 0;
    min-width: 0;
  }
  legend {
    font-size: 12px;
    font-weight: 600;
    margin-bottom: 8px;
  }
  label {
    display: grid;
    gap: 4px;
    font-size: 12px;
  }
  p,
  figcaption {
    color: var(--banto-text-muted);
    font-size: 11px;
    line-height: 1.6;
  }
  figure {
    margin: 8px 0;
  }
  svg {
    display: block;
    width: 100%;
    height: 100px;
    background: var(--banto-surface-alt);
  }
  select,
  button {
    font: inherit;
    font-size: 12px;
    max-width: 100%;
    min-width: 0;
    min-height: 30px;
    padding: 5px;
    border: 1px solid var(--banto-border);
    border-radius: 3px;
    background: var(--banto-surface);
    color: var(--banto-text);
  }
  button {
    cursor: pointer;
  }
  :is(select, button):focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
  fieldset:disabled {
    opacity: 0.55;
  }
</style>
