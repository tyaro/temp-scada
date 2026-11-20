<script lang="ts">
  import type { AlarmDefinition } from "../alarms";
  import type { createDraftGuard } from "./drafts.svelte";
  import {
    ALARM_COLOR_NO_DEFINITIONS,
    alarmColorGroups,
  } from "./forms/alarm-color";
  let {
    alarmId,
    definitions,
    externalName,
    objectId,
    targetKey,
    locked,
    drafts,
    onsubmit,
  }: {
    alarmId?: string;
    definitions: readonly AlarmDefinition[];
    externalName?: string;
    objectId: string;
    targetKey: string;
    locked: boolean;
    drafts: ReturnType<typeof createDraftGuard>;
    onsubmit: (event: SubmitEvent) => void;
  } = $props();
  const groups = $derived(alarmColorGroups(definitions, externalName));
  const empty = $derived(definitions.length === 0);
</script>

<form
  use:drafts.track={{ alarmId: alarmId ?? "" }}
  data-editor-form="alarm-color"
  data-object-id={objectId}
  data-target-key={targetKey}
  aria-label="警報の色"
  {onsubmit}
>
  <fieldset disabled={locked}>
    <legend>警報の色</legend>
    <label class="banto-field banto-field--stacked"
      ><span class="banto-field-label">警報の定義</span><select
        class="banto-field-control"
        name="alarmId"
        aria-label="警報の定義"
        disabled={empty}
        ><option value="">使わない</option
        >{#each groups as group (group.label)}<optgroup label={group.label}
            >{#each group.options as option (option.value)}<option
                value={option.value}>{option.label}</option
              >{/each}</optgroup
          >{/each}</select
      ></label
    >
    {#if empty}<p class="empty">{ALARM_COLOR_NO_DEFINITIONS}</p>{/if}
    <p>
      選んだ警報の状態で数値の文字色を変えます。発生中は重要度の色、未確認は下線、状態が不明なら灰色です。「使わない」を適用すると解除します。
    </p>
    <button type="submit">警報の色を適用</button>
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
  p {
    color: var(--banto-text-muted);
    font-size: 12px;
    line-height: 1.6;
  }
  .empty {
    color: var(--banto-text);
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
