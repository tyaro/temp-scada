<script lang="ts">
  import type { TextBoolDisplay } from "../project";
  import type { createDraftGuard } from "./drafts.svelte";
  import {
    DEFAULT_BOOL_DISPLAY,
    MAX_BOOL_LABEL_LENGTH,
  } from "./forms/bool-display";
  let {
    display,
    hasFormat,
    objectId,
    targetKey,
    locked,
    drafts,
    onsubmit,
  }: {
    display?: TextBoolDisplay;
    /** A Text with a numeric format cannot show a bool. */
    hasFormat: boolean;
    objectId: string;
    targetKey: string;
    locked: boolean;
    drafts: ReturnType<typeof createDraftGuard>;
    onsubmit: (event: SubmitEvent) => void;
  } = $props();
  const shown = $derived(display ?? DEFAULT_BOOL_DISPLAY);
</script>

{#if hasFormat}
  <section aria-label="bool の表示" class="unavailable">
    <h3>bool の表示</h3>
    <p>
      数値の書式を持つTextでは使えません。bool
      の表示を使うには、先に数値の書式を解除してください。
    </p>
  </section>
{:else}
  <form
    use:drafts.track={{
      boolDisplayMode: display ? "enabled" : "disabled",
      trueText: shown.true.text,
      trueColor: shown.true.color,
      falseText: shown.false.text,
      falseColor: shown.false.color,
      unknownColor: shown.unknownColor,
    }}
    data-editor-form="bool-display"
    data-object-id={objectId}
    data-target-key={targetKey}
    aria-label="bool の表示"
    {onsubmit}
  >
    <fieldset disabled={locked}>
      <legend>bool の表示</legend>
      <label class="banto-field banto-field--stacked"
        ><span class="banto-field-label">使用</span><select
          class="banto-field-control"
          name="boolDisplayMode"
          aria-label="bool の表示を使う"
          ><option value="disabled">使用しない</option><option value="enabled"
            >使用する</option
          ></select
        ></label
      >
      <div class="rows">
        <label
          >true の文字<input
            name="trueText"
            aria-label="true の文字"
            maxlength={MAX_BOOL_LABEL_LENGTH}
          /></label
        >
        <label
          >色<input
            type="color"
            name="trueColor"
            aria-label="true の色"
          /></label
        >
        <label
          >false の文字<input
            name="falseText"
            aria-label="false の文字"
            maxlength={MAX_BOOL_LABEL_LENGTH}
          /></label
        >
        <label
          >色<input
            type="color"
            name="falseColor"
            aria-label="false の色"
          /></label
        >
        <label class="wide"
          >取得不能の色<input
            type="color"
            name="unknownColor"
            aria-label="取得不能の色"
          /></label
        >
      </div>
      <p>
        bit タグがGoodのときだけ true / false
        の文字と色を表示し、配置の単色指定より優先します。未接続・不良・更新停止・数値タグなどは理由の文字と取得不能の色にします（直前の色は使いません）。「使用しない」を適用すると指定を解除します。
      </p>
      <button type="submit">bool の表示を適用</button>
    </fieldset>
  </form>
{/if}

<style>
  form,
  section {
    margin-bottom: 16px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--banto-border);
  }
  h3 {
    font-size: 13px;
    font-weight: 600;
    margin: 0 0 10px;
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
  .rows {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
    gap: 8px;
    margin-top: 10px;
  }
  .wide {
    grid-column: 1 / -1;
  }
  label {
    display: grid;
    gap: 5px;
    font-size: 12px;
  }
  input[type="color"] {
    width: 100%;
    height: 30px;
  }
  p {
    color: var(--banto-text-muted);
    font-size: 12px;
    line-height: 1.6;
  }
  select,
  input,
  button {
    padding: 7px;
    background: var(--banto-surface);
    color: var(--banto-text);
    border: 1px solid var(--banto-border);
    border-radius: 3px;
    font: inherit;
    font-size: 12px;
  }
  select,
  input {
    width: 100%;
    min-width: 0;
  }
  input[type="color"] {
    padding: 2px;
  }
  fieldset:disabled {
    opacity: 0.55;
  }
</style>
