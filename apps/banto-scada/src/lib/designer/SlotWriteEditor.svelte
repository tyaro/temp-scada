<script lang="ts">
  import type { EquipmentSlot, SlotWrite } from "../equipment";
  import {
    WRITE_BUTTON_LABEL_MAX,
    WRITE_BUTTON_LIMIT,
    WRITE_LABEL_MAX,
    buttonValueProblem,
    defaultSlotWrite,
    nextButtonValue,
    parseWriteNumber,
    slotWriteProblem,
    writeLabelProblem,
  } from "../slot-write-edit";
  /**
   * Edits the operation (`write`) of one equipment-type slot (O1b). Writing
   * itself happens only in Runtime mode; this defines what may be written.
   */
  let {
    slot,
    onchange,
    onkeydown,
  }: {
    slot: EquipmentSlot;
    onchange: (patch: Partial<EquipmentSlot>) => void;
    onkeydown: (event: KeyboardEvent) => void;
  } = $props();
  const write = $derived(slot.write);
  const problem = $derived(write && slotWriteProblem(slot.type, write));
  /**
   * What is typed in a number field while it has focus, so a partial entry
   * such as "-" or "1." is not replaced by the parsed value.
   */
  let typing = $state<{ field: string; text: string }>();
  function set(next: SlotWrite) {
    onchange({ write: next });
  }
  function shown(field: string, value: unknown) {
    if (typing?.field === field) return typing.text;
    return typeof value === "number" && isFinite(value) ? String(value) : "";
  }
  function typed(field: string, text: string) {
    typing = { field, text };
    return parseWriteNumber(text);
  }
  function setButton(
    index: number,
    patch: Partial<NonNullable<SlotWrite["buttons"]>[0]>,
  ) {
    if (!write?.buttons) return;
    set({
      ...write,
      buttons: write.buttons.map((button, at) =>
        at === index ? { ...button, ...patch } : button,
      ),
    });
  }
</script>

<div class="write" role="group" aria-label={`${slot.name || "slot"}の操作`}>
  <label class="check"
    ><input
      type="checkbox"
      checked={!!write}
      onchange={(event) =>
        onchange({
          write: event.currentTarget.checked
            ? defaultSlotWrite(slot.type)
            : undefined,
        })}
    />操作を定義する（Runtime で値を書く）</label
  >
  {#if write}
    <label class="banto-field banto-field--stacked"
      ><span class="banto-field-label">操作の見出し</span><input
        class="banto-field-control"
        aria-label="操作の見出し"
        maxlength={WRITE_LABEL_MAX * 2}
        value={write.label}
        aria-invalid={writeLabelProblem(write.label, WRITE_LABEL_MAX)
          ? "true"
          : undefined}
        oninput={(event) => set({ ...write, label: event.currentTarget.value })}
        {onkeydown}
      /></label
    >
    {#if write.buttons?.length}
      <div class="rows">
        <div class="row head" aria-hidden="true">
          <span>ボタンの見出し</span><span>書く値</span><span></span>
        </div>
        {#each write.buttons as button, index (index)}
          {@const name = `ボタン${index + 1}`}
          <div class="row" data-write-button={index}>
            <input
              aria-label={`${name}の見出し`}
              maxlength={WRITE_BUTTON_LABEL_MAX * 2}
              value={button.label}
              aria-invalid={writeLabelProblem(
                button.label,
                WRITE_BUTTON_LABEL_MAX,
              )
                ? "true"
                : undefined}
              oninput={(event) =>
                setButton(index, { label: event.currentTarget.value })}
              {onkeydown}
            />
            {#if slot.type === "bool"}
              <select
                aria-label={`${name}の値`}
                value={String(button.value)}
                onchange={(event) =>
                  setButton(index, {
                    value: event.currentTarget.value === "true",
                  })}
                ><option value="true">true</option><option value="false"
                  >false</option
                ></select
              >
            {:else}
              <input
                aria-label={`${name}の値`}
                inputmode={slot.type === "state" ? "numeric" : "decimal"}
                value={shown(`button${index}`, button.value)}
                aria-invalid={buttonValueProblem(slot.type, button.value)
                  ? "true"
                  : undefined}
                oninput={(event) =>
                  setButton(index, {
                    value: typed(`button${index}`, event.currentTarget.value),
                  })}
                onblur={() => (typing = undefined)}
                {onkeydown}
              />
            {/if}
            <button
              type="button"
              aria-label={`${name}を削除`}
              title="このボタンを削除"
              onclick={() => {
                const buttons = write.buttons!.filter((_, at) => at !== index);
                set({
                  ...write,
                  buttons: buttons.length ? buttons : undefined,
                });
              }}>×</button
            >
          </div>
        {/each}
      </div>
    {/if}
    <div class="actions">
      <button
        type="button"
        disabled={(write.buttons?.length ?? 0) >= WRITE_BUTTON_LIMIT}
        onclick={() =>
          set({
            ...write,
            buttons: [
              ...(write.buttons ?? []),
              { label: "", value: nextButtonValue(slot.type, write) },
            ],
          })}>ボタンを追加</button
      >
    </div>
    {#if slot.type === "number"}
      <label class="check"
        ><input
          type="checkbox"
          checked={!!write.input}
          onchange={(event) =>
            set({
              ...write,
              input: event.currentTarget.checked
                ? { min: 0, max: 100 }
                : undefined,
            })}
        />数値を入れて書く（範囲の外は送りません）</label
      >
      {#if write.input}
        {@const input = write.input}
        <div class="range">
          {#each ["min", "max"] as const as key (key)}
            <label class="banto-field banto-field--stacked"
              ><span class="banto-field-label"
                >{key === "min" ? "下限" : "上限"}</span
              ><input
                class="banto-field-control"
                aria-label={`入力の${key === "min" ? "下限" : "上限"}`}
                inputmode="decimal"
                value={shown(key, input[key])}
                aria-invalid={!isFinite(input[key]) || input.min > input.max
                  ? "true"
                  : undefined}
                oninput={(event) =>
                  set({
                    ...write,
                    input: {
                      ...input,
                      [key]: typed(key, event.currentTarget.value),
                    },
                  })}
                onblur={() => (typing = undefined)}
                {onkeydown}
              /></label
            >
          {/each}
        </div>
      {/if}
    {/if}
    {#if problem}<small class="problem" role="alert">{problem}</small>{/if}
  {/if}
</div>

<style>
  .write {
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
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 88px 30px;
    gap: 4px;
    align-items: center;
  }
  .row.head {
    color: var(--banto-text-muted);
  }
  .row button {
    width: 24px;
    padding: 2px 0;
    text-align: center;
  }
  .range {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
  }
  .actions {
    display: flex;
    gap: 6px;
  }
  .problem {
    color: var(--banto-danger);
  }
  input[aria-invalid="true"] {
    border-color: var(--banto-danger);
  }
</style>
