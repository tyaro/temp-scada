<script lang="ts">
  import type { ScreenObject } from "../project";
  import { paintAlphaTarget } from "../selection-paint-alpha";
  import type { createDraftGuard } from "./drafts.svelte";
  let {
    objects,
    hiddenCount,
    locked,
    definition,
    targetKey,
    objectIds,
    drafts,
    onsubmit,
  }: {
    objects: ScreenObject[];
    hiddenCount: number;
    locked: boolean;
    definition: boolean;
    targetKey: string;
    objectIds: string[];
    drafts: ReturnType<typeof createDraftGuard>;
    onsubmit: (event: SubmitEvent) => void;
  } = $props();
  let fill = $state("");
  let stroke = $state("");
  let form = $state<HTMLFormElement>();
  let composing = false;
  const fillTarget = $derived(paintAlphaTarget(objects, "fill"));
  const strokeTarget = $derived(paintAlphaTarget(objects, "stroke"));
  const channels = $derived([
    { key: "fill", label: "単色塗り", target: fillTarget },
    { key: "stroke", label: "枠線", target: strokeTarget },
  ] as const);
  function refresh() {
    const data = form ? new FormData(form) : null;
    fill = String(data?.get("fillAlpha") ?? "");
    stroke = String(data?.get("strokeAlpha") ?? "");
  }
</script>

<form
  bind:this={form}
  use:drafts.track
  data-editor-form="selection-paint-alpha"
  data-target-key={targetKey}
  data-object-ids={JSON.stringify(objectIds)}
  aria-label="選択した塗り・枠線の不透明度"
  oninput={refresh}
  onreset={() => {
    fill = "";
    stroke = "";
  }}
  oncompositionstart={() => (composing = true)}
  oncompositionend={() => (composing = false)}
  onsubmit={(event) => {
    if (composing) event.preventDefault();
    else {
      onsubmit(event);
      refresh();
    }
  }}
>
  <h3>選択した塗り・枠線の不透明度</h3>
  <p class="hint">
    {objects.length} 件に適用{hiddenCount
      ? `・うち非表示 ${hiddenCount} 件`
      : ""}。{definition
      ? "共有定義内の配置"
      : "選択した配置"}の色αを変更します。配置全体の不透明度・RGBは保持します。
  </p>
  <fieldset disabled={locked}>
    {#each channels as channel}
      <p>
        {channel.label}の現在値：{channel.target.reason
          ? "適用不可"
          : channel.target.common === null
            ? "混在"
            : `${Number((channel.target.common * 100).toPrecision(15))}%`}
      </p>
      <label
        >適用する{channel.label}の不透明度（%）<input
          onkeydown={(event) => {
            if (
              event.key === "Enter" &&
              (composing || event.isComposing || event.keyCode === 229)
            )
              event.preventDefault();
          }}
          name={`${channel.key}Alpha`}
          aria-label={`適用する${channel.label}の不透明度（%）`}
          disabled={!!channel.target.reason}
          inputmode="decimal"
          autocomplete="off"
          spellcheck="false"
          placeholder="0〜100（空欄は変更なし）"
        /></label
      >
      {#if channel.target.reason}<p class="hint">
          {channel.target.reason}
        </p>{/if}
    {/each}
    <p class="hint">
      空欄は変更しません。Enterまたは適用ボタンで確定します。塗り・枠線は新設しません。
    </p>
    <button type="submit" disabled={!fill.trim() && !stroke.trim()}
      >選択した塗り・枠線に不透明度を適用</button
    >
  </fieldset>
</form>

<style>
  form {
    border-top: 1px solid var(--banto-border);
    padding-top: 12px;
    margin-top: 16px;
  }
  h3 {
    font-size: 13px;
    margin: 0 0 8px;
  }
  p {
    font-size: 12px;
    line-height: 1.6;
  }
  .hint {
    color: var(--banto-text-muted);
  }
  fieldset {
    border: 0;
    margin: 0;
    padding: 0;
    min-width: 0;
  }
  label {
    display: grid;
    gap: 5px;
    font-size: 12px;
  }
  input {
    min-width: 0;
    width: 100%;
    box-sizing: border-box;
    padding: 7px;
    border: 1px solid var(--banto-border);
    border-radius: 3px;
    background: var(--banto-surface);
    color: var(--banto-text);
    font: inherit;
  }
  button {
    border: 1px solid var(--banto-border);
    border-radius: 3px;
    background: var(--banto-surface);
    color: var(--banto-text);
    padding: 6px 8px;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
  }
  button:disabled,
  fieldset:disabled {
    opacity: 0.6;
  }
  button:disabled {
    cursor: default;
  }
  button:focus-visible,
  input:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
</style>
