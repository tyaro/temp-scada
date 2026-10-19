<script lang="ts">
  import type { BackgroundImage, ImageAsset } from "../project";
  import type { createDraftGuard } from "./drafts.svelte";
  let {
    image,
    asset,
    targetKey,
    drafts,
    busy,
    onimport,
    onremove,
    onsubmit,
  }: {
    image?: BackgroundImage;
    asset?: ImageAsset;
    targetKey: string;
    drafts: ReturnType<typeof createDraftGuard>;
    busy: boolean;
    onimport: (file: File) => void;
    onremove: () => void;
    onsubmit: (event: SubmitEvent) => void;
  } = $props();
  let composing = false;
  let fileInput = $state<HTMLInputElement>();
  const values = $derived({
    fit: image?.fit ?? "contain",
    opacity: String(Number(((image?.opacity ?? 1) * 100).toPrecision(15))),
  });
</script>

<section aria-label="背景画像の設定">
  <h3>背景画像</h3>
  <input
    hidden
    bind:this={fileInput}
    type="file"
    accept=".png,.jpg,.jpeg,image/png,image/jpeg"
    aria-label="背景画像を取り込む"
    disabled={busy}
    onchange={(event) => {
      const input = event.currentTarget,
        file = input.files?.[0];
      if (file) onimport(file);
      input.value = "";
    }}
  />
  <button type="button" disabled={busy} onclick={() => fileInput?.click()}
    >背景画像を選択…</button
  >
  <p>
    {busy
      ? "画像を確認しています…"
      : "静止PNG／JPEG・8MiB以下。背景色と図形は保持します。"}
  </p>
  {#if image && asset}
    <p class="asset-name" title={asset.name}>
      {asset.name} · {asset.width} × {asset.height}
    </p>
    <form
      use:drafts.track={values}
      data-editor-form="background-image"
      data-target-key={targetKey}
      aria-label="背景画像"
      oncompositionstart={() => (composing = true)}
      oncompositionend={() => (composing = false)}
      onsubmit={(event) => {
        if (composing) event.preventDefault();
        else onsubmit(event);
      }}
    >
      <label
        >表示方法<select name="fit" aria-label="背景画像の表示方法"
          ><option value="contain">全体表示（中央）</option><option
            value="cover">枠を埋める（中央で切抜き）</option
          ><option value="stretch">画面に引き伸ばす</option><option
            value="original">元のサイズ（中央）</option
          ></select
        ></label
      >
      <label
        >不透明度（%）<input
          onkeydown={(event) => {
            if (
              event.key === "Enter" &&
              (composing || event.isComposing || event.keyCode === 229)
            )
              event.preventDefault();
          }}
          name="opacity"
          aria-label="背景画像の不透明度（%）"
          type="number"
          min="0"
          max="100"
          step="any"
          required
        /></label
      >
      <button type="submit" disabled={busy}>背景画像の設定を適用</button>
    </form>
    <button type="button" disabled={busy} onclick={onremove}
      >背景画像を解除</button
    >
    <p>画像は図形の背面に表示します。通常の選択対象には含めません。</p>
  {/if}
</section>

<style>
  section {
    border-top: 1px solid var(--banto-border);
    margin-top: 12px;
    padding-top: 12px;
    min-width: 0;
  }
  h3 {
    font-size: 12px;
    margin: 0 0 10px;
  }
  label {
    display: grid;
    gap: 5px;
    font-size: 12px;
    margin-bottom: 10px;
  }
  p {
    font-size: 11px;
    color: var(--banto-text-muted);
    line-height: 1.6;
  }
  input,
  select {
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    font: inherit;
    color: var(--banto-text);
    background: var(--banto-surface);
    border: 1px solid var(--banto-border);
    border-radius: 3px;
    padding: 6px;
  }
  button {
    font: inherit;
    font-size: 12px;
    color: var(--banto-text);
    background: var(--banto-surface);
    border: 1px solid var(--banto-border);
    border-radius: 3px;
    padding: 7px;
    margin: 0 0 8px;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .asset-name {
    overflow-wrap: anywhere;
  }
  input:focus-visible,
  select:focus-visible,
  button:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
</style>
