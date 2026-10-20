<script lang="ts">
  import type { BoolColors } from "../project";
  import type { createDraftGuard } from "./drafts.svelte";
  let {
    colors,
    objectId,
    targetKey,
    locked,
    drafts,
    onsubmit,
  }: {
    colors?: BoolColors;
    objectId: string;
    targetKey: string;
    locked: boolean;
    drafts: ReturnType<typeof createDraftGuard>;
    onsubmit: (event: SubmitEvent) => void;
  } = $props();
</script>

<form
  use:drafts.track={{
    boolColorsMode: colors ? "enabled" : "disabled",
    trueColor: colors?.trueColor ?? "#15803d",
    falseColor: colors?.falseColor ?? "#64748b",
    unknownColor: colors?.unknownColor ?? "#b45309",
  }}
  data-editor-form="bool-colors"
  data-object-id={objectId}
  data-target-key={targetKey}
  aria-label="bool slotの状態別文字色"
  {onsubmit}
>
  <fieldset disabled={locked}>
    <legend>状態別の文字色</legend>
    <label
      >使用<select name="boolColorsMode" aria-label="状態別の文字色を使用"
        ><option value="disabled">使用しない</option><option value="enabled"
          >使用する</option
        ></select
      ></label
    >
    <div class="colors">
      <label
        >true<input
          type="color"
          name="trueColor"
          aria-label="trueの文字色"
        /></label
      >
      <label
        >false<input
          type="color"
          name="falseColor"
          aria-label="falseの文字色"
        /></label
      >
      <label
        >取得不能<input
          type="color"
          name="unknownColor"
          aria-label="取得不能の文字色"
        /></label
      >
    </div>
    <p>
      配置の単色指定より優先します。true／false・取得不能理由・SIMの文字表示は維持します。不透明度は既存設定を使います。「使用しない」を適用すると3色設定を解除します。
    </p>
    <button type="submit">状態別の文字色を適用</button>
  </fieldset>
</form>

<style>
  form {
    margin-bottom: 16px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--banto-border);
  }
  fieldset {
    border: 0;
    padding: 0;
    margin: 0;
    min-width: 0;
  }
  legend {
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 10px;
  }
  label {
    display: grid;
    gap: 5px;
    font-size: 12px;
  }
  .colors {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
    margin-top: 10px;
  }
  input {
    width: 100%;
    height: 30px;
  }
  p {
    color: var(--banto-text-muted);
    font-size: 12px;
    line-height: 1.6;
  }
  select,
  button {
    padding: 7px;
    background: var(--banto-surface);
    color: var(--banto-text);
    border: 1px solid var(--banto-border);
    border-radius: 3px;
    font: inherit;
    font-size: 12px;
  }
  select {
    width: 100%;
    min-width: 0;
  }
  fieldset:disabled {
    opacity: 0.55;
  }
</style>
