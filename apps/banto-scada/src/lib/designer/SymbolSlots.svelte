<script lang="ts">
  import type { SymbolDefinition } from "../project";
  import type { EditCommand } from "../editor";
  import { symbolSlotUsages } from "../symbol-slots";
  import type { createDraftGuard } from "./drafts.svelte";
  let {
    definition,
    generation,
    drafts,
    onsubmit,
    oncommand,
  }: {
    definition: SymbolDefinition;
    generation: number;
    drafts: ReturnType<typeof createDraftGuard>;
    onsubmit: (event: SubmitEvent) => void;
    oncommand: (command: EditCommand) => unknown;
  } = $props();
  let composing = false;
  function inputKey(event: KeyboardEvent) {
    if (
      event.key === "Enter" &&
      (composing || event.isComposing || event.keyCode === 229)
    )
      event.preventDefault();
  }
  const presets = [
    { name: "running", type: "bool" as const },
    { name: "current", type: "number" as const },
    { name: "value", type: "number" as const },
  ];
</script>

<section aria-label="共有Symbolの読取slot">
  <h3>読取slot</h3>
  <p>共有定義が要求する役割です。機器のslotや外部名は変更しません。</p>
  {#key `${generation}:${definition.id}`}
    <form
      use:drafts.track={{ slotName: "", slotType: "number" }}
      data-editor-form="symbol-slot"
      data-slot-action="create"
      data-symbol-id={definition.id}
      data-target-key={`${generation}:${definition.id}`}
      aria-label="読取slotを追加"
      oncompositionstart={() => (composing = true)}
      oncompositionend={() => (composing = false)}
      onsubmit={(event) => {
        if (composing) event.preventDefault();
        else onsubmit(event);
      }}
    >
      <label
        >slot名<input
          name="slotName"
          required
          maxlength="64"
          pattern={"[A-Za-z_][A-Za-z0-9_]{0,63}"}
          placeholder="pressure"
          onkeydown={inputKey}
        /></label
      >
      <label
        >slot型<select name="slotType" aria-label="slot型"
          ><option value="number">number</option><option value="bool"
            >bool</option
          ></select
        ></label
      >
      <button type="submit" disabled={(definition.readSlots?.length ?? 0) >= 64}
        >宣言を追加</button
      >
    </form>
    {#each definition.readSlots ?? [] as slot (slot.name)}
      {@const usages = symbolSlotUsages(definition, slot.name)}
      <section class="slot-row" aria-label={`slot宣言 ${slot.name}`}>
        {#if usages.length}
          <strong>{slot.name} · {slot.type} / read</strong>
          <p>
            Text {usages.length} 件で使用中。改名・型変更・削除は、先にTextの割付を解除してください。
          </p>
        {:else}
          <form
            use:drafts.track={{ slotName: slot.name, slotType: slot.type }}
            data-editor-form="symbol-slot"
            data-slot-action="update"
            data-slot-name={slot.name}
            data-symbol-id={definition.id}
            data-target-key={`${generation}:${definition.id}`}
            aria-label={`slot宣言 ${slot.name} を編集`}
            oncompositionstart={() => (composing = true)}
            oncompositionend={() => (composing = false)}
            onsubmit={(event) => {
              if (composing) event.preventDefault();
              else onsubmit(event);
            }}
          >
            <label
              >slot名<input
                name="slotName"
                required
                maxlength="64"
                pattern={"[A-Za-z_][A-Za-z0-9_]{0,63}"}
                onkeydown={inputKey}
              /></label
            >
            <label
              >slot型<select name="slotType" aria-label="slot型"
                ><option value="number">number</option><option value="bool"
                  >bool</option
                ></select
              ></label
            >
            <button type="submit">宣言を適用</button>
          </form>
          <p>未使用の宣言</p>
        {/if}
        <div class="actions">
          <button
            disabled={definition.objects.length >= 100}
            onclick={() =>
              oncommand({
                type: "add-symbol-readout",
                symbolId: definition.id,
                slotName: slot.name,
                requireExisting: true,
                slotType: slot.type,
              })}>{slot.name} · {slot.type} 表示を追加</button
          >
          <button
            disabled={usages.length > 0}
            onclick={() =>
              oncommand({
                type: "remove-symbol-slot",
                symbolId: definition.id,
                slotName: slot.name,
              })}>宣言を削除</button
          >
        </div>
      </section>
    {/each}
    <div class="presets" aria-label="読取slot表示を追加">
      {#each presets.filter((preset) => !definition.readSlots?.some((slot) => slot.name === preset.name)) as slot}
        <button
          disabled={definition.objects.length >= 100 ||
            (definition.readSlots?.length ?? 0) >= 64}
          onclick={() =>
            oncommand({
              type: "add-symbol-readout",
              symbolId: definition.id,
              slotName: slot.name,
              slotType: slot.type,
            })}>{slot.name} · {slot.type} 表示を追加</button
        >
      {/each}
    </div>
  {/key}
</section>

<style>
  section,
  form,
  .actions,
  .presets {
    display: grid;
    gap: 6px;
  }
  section {
    min-width: 0;
  }
  h3 {
    font-size: 12px;
    margin: 8px 0 0;
  }
  p {
    font-size: 11px;
    color: var(--banto-text-muted);
    margin: 0;
    overflow-wrap: anywhere;
  }
  label {
    display: grid;
    gap: 4px;
    font-size: 12px;
  }
  button,
  input,
  select {
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    font: inherit;
    font-size: 12px;
    color: var(--banto-text);
    border: 1px solid var(--banto-border);
    border-radius: 4px;
    padding: 7px;
    background: var(--banto-bg);
  }
  button {
    cursor: pointer;
    text-align: left;
    background: var(--banto-surface);
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  button:focus-visible,
  input:focus-visible,
  select:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
  .slot-row {
    border-top: 1px solid var(--banto-border);
    padding-top: 8px;
  }
  strong {
    font-size: 12px;
    overflow-wrap: anywhere;
  }
</style>
