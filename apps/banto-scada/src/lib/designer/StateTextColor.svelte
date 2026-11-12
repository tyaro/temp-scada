<script lang="ts">
  import type { StateTextColors } from "../project";
  import type { createDraftGuard } from "./drafts.svelte";
  let {
    colors,
    objectId,
    targetKey,
    locked,
    drafts,
    onsubmit,
  }: {
    colors?: StateTextColors;
    objectId: string;
    targetKey: string;
    locked: boolean;
    drafts: ReturnType<typeof createDraftGuard>;
    onsubmit: (event: SubmitEvent) => void;
  } = $props();
</script>

<form
  use:drafts.track={{
    stateColorsMode: colors ? "enabled" : "disabled",
    unknownColor: colors?.unknownColor ?? "#b45309",
  }}
  data-editor-form="state-text-color"
  data-object-id={objectId}
  data-target-key={targetKey}
  aria-label="slotの状態の色に従う"
  {onsubmit}
>
  <fieldset disabled={locked}>
    <legend>状態の色に従う</legend>
    <label class="banto-field banto-field--stacked"
      ><span class="banto-field-label">使用</span><select
        class="banto-field-control"
        name="stateColorsMode"
        aria-label="状態の色に従う"
        ><option value="disabled">使用しない</option><option value="enabled"
          >使用する</option
        ></select
      ></label
    >
    <div class="colors">
      <label
        >取得不能<input
          type="color"
          name="unknownColor"
          aria-label="取得不能の文字色"
        /></label
      >
    </div>
    <p>
      既知の状態の色は機器種別のslotの状態の定義に従い、配置の単色指定より優先します。色の定義がないbool
      slotは通常の色のままです。未関連付け・未接続・Badなど状態が分からないときは取得不能の色にします。文字表示と不透明度は既存設定を使います。「使用しない」を適用すると指定を解除します。
    </p>
    <button type="submit">状態の色に従う指定を適用</button>
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
    grid-template-columns: minmax(0, 1fr);
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
