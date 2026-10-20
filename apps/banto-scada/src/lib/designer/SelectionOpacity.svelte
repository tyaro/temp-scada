<script lang="ts">
  import type { ScreenObject } from "../project";
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
  let value = $state("");
  let input = $state<HTMLInputElement>();
  let composing = false;
  const common = $derived(
    objects.length &&
      objects.every((o) => (o.opacity ?? 1) === (objects[0].opacity ?? 1))
      ? Number(((objects[0].opacity ?? 1) * 100).toPrecision(15))
      : null,
  );
</script>

<form
  use:drafts.track
  data-editor-form="selection-opacity"
  data-target-key={targetKey}
  data-object-ids={JSON.stringify(objectIds)}
  aria-label="選択した配置の不透明度"
  onreset={() => (value = "")}
  onsubmit={(event) => {
    if (composing) event.preventDefault();
    else {
      onsubmit(event);
      value = input?.value ?? "";
    }
  }}
>
  <h3>選択した配置の不透明度</h3>
  <p>現在の不透明度：{common === null ? "混在" : `${common}%`}</p>
  <p class="hint">
    {objects.length} 件に適用{hiddenCount
      ? `・うち非表示 ${hiddenCount} 件`
      : ""}。{definition
      ? "共有定義内の配置"
      : "選択した配置"}全体の不透明度を変更します。色や塗り、共有シンボルの色モードは保持します。
  </p>
  <fieldset disabled={locked}>
    <label
      >適用する不透明度（%）<input
        bind:this={input}
        bind:value
        name="opacity"
        aria-label="適用する不透明度（%）"
        inputmode="decimal"
        autocomplete="off"
        spellcheck="false"
        placeholder="0〜100（空欄は変更なし）"
        oncompositionstart={() => (composing = true)}
        oncompositionend={() => (composing = false)}
        onkeydown={(event) => {
          if (
            event.key === "Enter" &&
            (composing || event.isComposing || event.keyCode === 229)
          )
            event.preventDefault();
        }}
      /></label
    >
    <p class="hint">
      0%でもレイヤーから選択できます。Enterまたは適用ボタンで確定します。
    </p>
    <button type="submit" disabled={!value.trim()}
      >選択した配置に不透明度を適用</button
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
