<script lang="ts">
  import type { SymbolColorMode } from "../project";
  import type { createDraftGuard } from "./drafts.svelte";
  let {
    mode,
    objectId,
    targetKey,
    locked,
    drafts,
    onsubmit,
  }: {
    mode: SymbolColorMode;
    objectId: string;
    targetKey: string;
    locked: boolean;
    drafts: ReturnType<typeof createDraftGuard>;
    onsubmit: (event: SubmitEvent) => void;
  } = $props();
</script>

<form
  use:drafts.track={{ colorMode: mode }}
  data-editor-form="symbol-color-mode"
  data-object-id={objectId}
  data-target-key={targetKey}
  aria-label="Symbolの色の使い方"
  {onsubmit}
>
  <fieldset disabled={locked}>
    <label
      >色の使い方<select name="colorMode" aria-label="色の使い方"
        ><option value="monochrome">配置の単色</option><option
          value="definition">共有定義の色</option
        ></select
      ></label
    >
    <p>
      共有定義の色は各図形の色を使います。配置の単色は保持し、戻したときに再び使います。切替は適用するまで図面へ反映しません。
    </p>
    <button type="submit">色の使い方を適用</button>
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
  label {
    display: grid;
    gap: 5px;
    font-size: 12px;
  }
  p {
    color: var(--banto-text-muted);
    font-size: 12px;
    line-height: 1.6;
  }
  select {
    width: 100%;
    min-width: 0;
    padding: 7px;
    background: var(--banto-surface);
    color: var(--banto-text);
    border: 1px solid var(--banto-border);
    border-radius: 3px;
    font: inherit;
  }
  button {
    padding: 7px 10px;
    border: 1px solid var(--banto-border);
    border-radius: 3px;
    background: var(--banto-surface);
    color: var(--banto-text);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  fieldset:disabled {
    opacity: 0.55;
  }
  select:focus-visible,
  button:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
</style>
