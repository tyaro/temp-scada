<script lang="ts">
  import type {
    EquipmentSlot,
    SlotStateDisplay,
    SlotStateLabel,
  } from "../equipment";
  import {
    STATE_ROW_LIMIT,
    addStateRow,
    defaultBoolDisplay,
    exampleStateDisplay,
    labelProblem,
    moveStateRow,
    nextMatch,
    stateRowProblem,
  } from "../slot-display-edit";
  /** Edits the display definitions of one bool/state slot of an equipment type. */
  let {
    slot,
    onchange,
    onkeydown,
  }: {
    slot: EquipmentSlot;
    onchange: (patch: Partial<EquipmentSlot>) => void;
    onkeydown: (event: KeyboardEvent) => void;
  } = $props();
  const id = $props.id();
  const display = $derived(slot.stateDisplay);
  const unit = $derived(display?.source === "bits" ? "ビット" : "値");
  function setState(next: SlotStateDisplay) {
    onchange({ stateDisplay: next });
  }
  function setRow(index: number, patch: Partial<SlotStateDisplay["rows"][0]>) {
    if (!display) return;
    setState({
      ...display,
      rows: display.rows.map((row, at) =>
        at === index ? { ...row, ...patch } : row,
      ),
    });
  }
  function setBool(key: "true" | "false", patch: Partial<SlotStateLabel>) {
    if (!slot.boolDisplay) return;
    onchange({
      boolDisplay: {
        ...slot.boolDisplay,
        [key]: { ...slot.boolDisplay[key], ...patch },
      },
    });
  }
</script>

{#snippet label(
  name: string,
  value: SlotStateLabel,
  set: (patch: Partial<SlotStateLabel>) => void,
)}
  {@const problem = labelProblem(value)}
  <input
    class="text"
    aria-label={`${name}の文字`}
    placeholder="（文字なし）"
    value={value.text}
    aria-invalid={problem?.startsWith("文字") ? "true" : undefined}
    oninput={(event) => set({ text: event.currentTarget.value })}
    {onkeydown}
  /><input
    class="color"
    type="color"
    aria-label={`${name}の色`}
    value={value.color}
    oninput={(event) => set({ color: event.currentTarget.value })}
  /><span
    class="preview"
    aria-hidden="true"
    style:color={value.color}
    style:border-color={value.color}>{value.text || "■"}</span
  >
{/snippet}

<div class="display" role="group" aria-label="状態の定義">
  <label class="check"
    ><input
      type="checkbox"
      checked={slot.allowUnassigned === true}
      onchange={(event) =>
        onchange({
          allowUnassigned: event.currentTarget.checked ? true : undefined,
        })}
    />未割付を許す（その機器にない信号は「なし」として表示）</label
  >
  {#if slot.type === "bool"}
    <label class="check"
      ><input
        type="checkbox"
        checked={!!slot.boolDisplay}
        onchange={(event) =>
          onchange({
            boolDisplay: event.currentTarget.checked
              ? defaultBoolDisplay()
              : undefined,
          })}
      />true／falseの文字と色を決める</label
    >
    {#if slot.boolDisplay}
      <div class="rows">
        {#each ["true", "false"] as const as key (key)}
          <div class="row bool">
            <span class="match">{key}</span>
            {@render label(key, slot.boolDisplay[key], (patch) =>
              setBool(key, patch),
            )}
          </div>
        {/each}
      </div>
    {/if}
  {:else if display}
    <label class="banto-field banto-field--stacked"
      ><span class="banto-field-label">元の値</span><select
        class="banto-field-control"
        aria-label="状態の元の値"
        value={display.source}
        onchange={(event) =>
          setState({
            ...display,
            source: event.currentTarget.value as SlotStateDisplay["source"],
          })}
        ><option value="value">ワードの値が一致</option><option value="bits"
          >ワード内のビットが立っている</option
        ></select
      ></label
    >
    <p class="hint" id={`${id}-hint`}>
      上の行から順に見て、最初に当たった行を表示します。{display.source ===
      "bits"
        ? "故障など優先するビットを上に置きます。"
        : ""}
    </p>
    {#if display.rows.length}
      <div class="rows" aria-describedby={`${id}-hint`}>
        <div class="row head" aria-hidden="true">
          <span>{unit}</span><span class="text">文字</span><span>色</span>
        </div>
        {#each display.rows as row, index (index)}
          {@const problem = stateRowProblem(display, index)}
          {@const name = `行${index + 1}`}
          <div class="row" data-state-row={index}>
            <input
              class="match"
              type="number"
              step="1"
              min={display.source === "bits" ? 0 : undefined}
              max={display.source === "bits" ? 31 : undefined}
              aria-label={`${name}の${unit}`}
              value={Number.isFinite(row.match) ? row.match : ""}
              aria-invalid={problem &&
              !problem.startsWith("文字") &&
              !problem.startsWith("色")
                ? "true"
                : undefined}
              oninput={(event) =>
                setRow(index, { match: event.currentTarget.valueAsNumber })}
              {onkeydown}
            />
            {@render label(name, row, (patch) => setRow(index, patch))}
            <span class="tools">
              <button
                type="button"
                aria-label={`${name}を上へ`}
                title="上へ（優先を上げる）"
                disabled={index === 0}
                onclick={() => setState(moveStateRow(display, index, -1))}
                >↑</button
              ><button
                type="button"
                aria-label={`${name}を下へ`}
                title="下へ（優先を下げる）"
                disabled={index === display.rows.length - 1}
                onclick={() => setState(moveStateRow(display, index, 1))}
                >↓</button
              ><button
                type="button"
                aria-label={`${name}を削除`}
                title="この行を削除"
                onclick={() =>
                  setState({
                    ...display,
                    rows: display.rows.filter((_, at) => at !== index),
                  })}>×</button
              >
            </span>
            {#if problem}<small class="problem" role="alert">{problem}</small
              >{/if}
          </div>
        {/each}
      </div>
    {/if}
    <div class="actions">
      <button
        type="button"
        disabled={display.rows.length >= STATE_ROW_LIMIT ||
          nextMatch(display) === undefined}
        onclick={() => setState(addStateRow(display))}>状態の行を追加</button
      >
      {#if !display.rows.length}
        <button
          type="button"
          title="停止・運転・故障の行を入れます。後から直せます"
          onclick={() => setState(exampleStateDisplay(display.source))}
          >例を入れる</button
        >
      {/if}
    </div>
    <div class="rows">
      <div class="row">
        <span class="match">該当なし</span>
        {@render label("該当なし", display.otherwise, (patch) =>
          setState({
            ...display,
            otherwise: { ...display.otherwise, ...patch },
          }),
        )}
      </div>
    </div>
  {/if}
</div>

<style>
  .display {
    grid-column: 1 / -1;
    display: grid;
    gap: 6px;
  }
  .check {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .check input {
    width: auto;
  }
  .rows {
    display: grid;
    gap: 4px;
  }
  /* Two lines fit the narrow panel: match, text and color, then how it looks
     with the priority and delete buttons. */
  .row {
    display: grid;
    grid-template-columns: 52px minmax(0, 1fr) 46px 30px;
    gap: 4px;
    align-items: center;
    padding-bottom: 4px;
    border-bottom: 1px dashed var(--banto-border);
  }
  .row.head {
    color: var(--banto-text-muted);
    padding: 0;
    border: 0;
  }
  .row > .text {
    grid-column: 2 / 4;
  }
  .row > .preview {
    grid-column: 1 / 3;
    justify-self: start;
    max-width: 100%;
  }
  .row > .tools {
    grid-column: 3 / 5;
    justify-content: end;
  }
  span.match {
    color: var(--banto-text-muted);
    padding: 0 2px;
  }
  .color {
    padding: 1px;
    height: 28px;
    width: 30px;
  }
  .preview {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    border-left: 3px solid;
    padding-left: 4px;
    font-weight: 600;
  }
  .tools {
    display: flex;
    gap: 2px;
  }
  .tools button {
    width: 24px;
    padding: 2px 0;
    text-align: center;
  }
  .problem {
    grid-column: 1 / -1;
    color: var(--banto-danger);
  }
  .actions {
    display: flex;
    gap: 6px;
  }
  .hint {
    margin: 0;
    color: var(--banto-text-muted);
  }
  input[aria-invalid="true"] {
    border-color: var(--banto-danger);
  }
</style>
