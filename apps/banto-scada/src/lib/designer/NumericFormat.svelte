<script lang="ts">
  import type { NumericFormat } from "../project";
  import type { createDraftGuard } from "./drafts.svelte";
  import { MAX_FORMAT_DECIMALS, MAX_UNIT_LENGTH } from "./forms/numeric-format";
  let {
    format,
    catalogUnit,
    objectId,
    targetKey,
    locked,
    drafts,
    onsubmit,
  }: {
    format?: NumericFormat;
    /** Unit of the bound tag in the tag list; the initial unit when unset. */
    catalogUnit?: string;
    objectId: string;
    targetKey: string;
    locked: boolean;
    drafts: ReturnType<typeof createDraftGuard>;
    onsubmit: (event: SubmitEvent) => void;
  } = $props();
  const suggested = $derived(!format && !!catalogUnit);
</script>

<form
  use:drafts.track={{
    decimals: format?.decimals === undefined ? "" : String(format.decimals),
    unit: format?.unit ?? (format ? "" : (catalogUnit ?? "")),
  }}
  data-editor-form="numeric-format"
  data-object-id={objectId}
  data-target-key={targetKey}
  aria-label="数値の書式"
  {onsubmit}
>
  <fieldset disabled={locked}>
    <legend>数値の書式</legend>
    <div class="fields">
      <label class="banto-field banto-field--stacked"
        ><span class="banto-field-label">小数桁</span><select
          class="banto-field-control"
          name="decimals"
          aria-label="小数桁"
          ><option value="">そのまま</option
          >{#each Array.from({ length: MAX_FORMAT_DECIMALS + 1 }, (_, i) => i) as digits}<option
              value={String(digits)}>{digits}</option
            >{/each}</select
        ></label
      >
      <label class="banto-field banto-field--stacked"
        ><span class="banto-field-label">単位</span><input
          class="banto-field-control"
          name="unit"
          aria-label="単位"
          maxlength={MAX_UNIT_LENGTH}
          placeholder="例: m3/h"
        /></label
      >
    </div>
    {#if suggested}<p class="suggested">
        タグ一覧の単位（{catalogUnit}）を初期値として入れています。適用するまで表示には付きません。
      </p>{/if}
    <p>
      Goodの数値だけに書式を使い、単位は数値の後ろに空白を挟んで付けます。未接続・不良などのときは単位を付けません。bool・stateのslotには効きません。両方を空（そのまま・単位なし）にして適用すると書式を解除します。
    </p>
    <button type="submit">数値の書式を適用</button>
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
  .fields {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 8px;
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
  .suggested {
    color: var(--banto-text);
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
  fieldset:disabled {
    opacity: 0.55;
  }
</style>
