<script lang="ts">
  import { tick } from "svelte";
  import ImagePainting from "../ImagePainting.svelte";
  import ImageCropSelection from "./ImageCropSelection.svelte";
  import { imageCropViewBox, type ImageCrop } from "../image-crop";
  import { imageCropFromForm } from "./image-crop-fields";
  import type { ImageAsset } from "../project";
  import type { createDraftGuard } from "./drafts.svelte";
  let {
    asset,
    url,
    crop,
    objectId = "",
    background = false,
    targetKey,
    locked,
    drafts,
    onsubmit,
  }: {
    asset: ImageAsset;
    url?: string;
    crop?: ImageCrop;
    objectId?: string;
    background?: boolean;
    targetKey: string;
    locked: boolean;
    drafts: ReturnType<typeof createDraftGuard>;
    onsubmit: (event: SubmitEvent) => void;
  } = $props();
  let form: HTMLFormElement;
  let composing = false;
  let preview = $state<ImageCrop | undefined>();
  let error = $state("");
  let selectionOpen = $state(false);
  const percent = (value: number) =>
    String(Number((value * 100).toPrecision(15)));
  const values = $derived({
    cropX: percent(crop?.x ?? 0),
    cropY: percent(crop?.y ?? 0),
    cropWidth: percent(crop?.width ?? 1),
    cropHeight: percent(crop?.height ?? 1),
  });
  const box = $derived(error ? null : imageCropViewBox(asset, preview));
  async function refresh() {
    await tick();
    if (!form?.isConnected) return;
    try {
      preview = locked ? crop : imageCropFromForm(new FormData(form), asset);
      error = "";
    } catch (e) {
      preview = undefined;
      error = e instanceof Error ? e.message : "切出し範囲を確認してください。";
    }
  }
  function write(next: Record<string, string>) {
    for (const [key, value] of Object.entries(next))
      (form.elements.namedItem(key) as HTMLInputElement).value = value;
    form.dispatchEvent(new Event("input", { bubbles: true }));
    void refresh();
  }
  function track(node: HTMLFormElement, next: Record<string, string>) {
    form = node;
    const tracked = drafts.track(node, next);
    void refresh();
    return {
      update(value: Record<string, string>) {
        tracked.update(value);
        void refresh();
      },
      destroy: tracked.destroy,
    };
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (explicit form and IME guard) -->
<form
  use:track={values}
  data-editor-form={background ? "background-crop" : "image-crop"}
  data-object-id={background ? undefined : objectId}
  data-asset-id={asset.id}
  data-target-key={targetKey}
  aria-label={background ? "背景画像のトリミング" : "画像のトリミング"}
  oninput={() => void refresh()}
  onreset={() => void refresh()}
  oncompositionstart={() => (composing = true)}
  oncompositionend={() => (composing = false)}
  onkeydown={(event) => {
    if (
      event.key === "Enter" &&
      (composing || event.isComposing || event.keyCode === 229)
    )
      event.preventDefault();
    if (event.key === "Escape" && !composing && !event.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      write(values);
    }
  }}
  onsubmit={(event) => {
    if (composing) event.preventDefault();
    else onsubmit(event);
  }}
>
  <h3>{background ? "背景画像のトリミング" : "トリミング"}</h3>
  <fieldset disabled={locked}>
    <div class="fields">
      {#each [["cropX", "左から（%）"], ["cropY", "上から（%）"], ["cropWidth", "切出し幅（%）"], ["cropHeight", "切出し高さ（%）"]] as [name, label]}
        <label>{label}<input {name} inputmode="decimal" required /></label>
      {/each}
    </div>
    {#if url}
      <button
        type="button"
        aria-expanded={selectionOpen}
        onclick={() => (selectionOpen = !selectionOpen)}
      >
        {selectionOpen ? "マウス調整を閉じる" : "範囲をマウスで調整"}
      </button>
      {#if selectionOpen && !locked && !error}
        <ImageCropSelection
          {asset}
          {url}
          crop={preview}
          onchange={(next) =>
            write({
              cropX: percent(next.x),
              cropY: percent(next.y),
              cropWidth: percent(next.width),
              cropHeight: percent(next.height),
            })}
        />
      {/if}
    {/if}
    {#if error}<p role="status" class="error">{error}</p>
    {:else if url && box}
      <div class="previews" aria-label="未適用の切出し見本">
        <figure>
          <figcaption>原本と切出し範囲</figcaption>
          <svg
            viewBox={`0 0 ${asset.width} ${asset.height}`}
            aria-label="原本と切出し範囲"
          >
            <image href={url} width={asset.width} height={asset.height} />
            <rect
              {...box}
              fill="none"
              stroke="var(--banto-primary, #2563eb)"
              stroke-width={Math.max(asset.width, asset.height) / 80}
            />
          </svg>
        </figure>
        <figure>
          <figcaption>表示方式適用前の切出し範囲</figcaption>
          <svg viewBox="0 0 160 96" aria-label="切出し結果"
            ><ImagePainting
              image={{ url, width: asset.width, height: asset.height }}
              width={160}
              height={96}
              crop={preview}
            /></svg
          >
        </figure>
      </div>
    {/if}
    <p class="hint">非表示部分を含む原本全体が保存されます。</p>
    <div class="actions">
      <button
        type="button"
        onclick={() =>
          write({
            cropX: "0",
            cropY: "0",
            cropWidth: "100",
            cropHeight: "100",
          })}>原本全体へ戻す</button
      >
      <button type="button" onclick={() => write(values)}>入力を戻す</button>
      <button type="submit"
        >{background ? "背景の切出しを適用" : "切出しを適用"}</button
      >
    </div>
  </fieldset>
</form>

<style>
  form {
    padding: 12px 0;
    border-bottom: 1px solid var(--banto-border);
  }
  h3 {
    font-size: 12px;
    margin: 0 0 10px;
  }
  fieldset {
    border: 0;
    padding: 0;
    min-width: 0;
  }
  .fields {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  label {
    font-size: 11px;
    display: grid;
    gap: 4px;
    min-width: 0;
  }
  input {
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
  }
  .previews {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-top: 10px;
  }
  figure {
    margin: 0;
    min-width: 0;
  }
  figcaption,
  .hint {
    font-size: 10px;
    color: var(--banto-text-muted);
  }
  svg {
    display: block;
    width: 100%;
    height: 80px;
    background: var(--banto-surface-alt);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  button {
    font-size: 11px;
  }
  input,
  button {
    min-height: 30px;
    padding: 5px 6px;
    border: 1px solid var(--banto-border);
    border-radius: 3px;
    background: var(--banto-surface);
    color: var(--banto-text);
    font: inherit;
  }
  button {
    cursor: pointer;
    font-size: 11px;
  }
  :is(input, button):focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
  fieldset:disabled {
    opacity: 0.55;
  }
  .error {
    font-size: 11px;
    color: var(--banto-danger, #b91c1c);
  }
</style>
