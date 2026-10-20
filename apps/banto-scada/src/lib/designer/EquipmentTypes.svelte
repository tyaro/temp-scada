<script lang="ts">
  import { tick, untrack } from "svelte";
  import type { Project } from "../project";
  import type { EditCommand } from "../editor";
  import type { EquipmentSlot } from "../equipment";
  import type { createDraftGuard } from "./drafts.svelte";
  let {
    project,
    generation,
    drafts,
    transition,
    oncommand,
    onsubmit,
  }: {
    project: Project;
    generation: number;
    drafts: ReturnType<typeof createDraftGuard>;
    transition: (action: () => void) => void;
    oncommand: (command: EditCommand) => unknown;
    onsubmit: (event: SubmitEvent) => void;
  } = $props();
  const formId = $props.id();
  let selectedId = $state("");
  const selected = $derived(
    project.equipmentTypes?.find((type) => type.id === selectedId),
  );
  const savedSlots = $derived(JSON.stringify(selected?.slots ?? []));
  const scope = $derived(
    `${generation}:${project.manifest.projectId}:${selectedId || "new"}`,
  );
  const users = $derived(
    (project.equipment ?? []).filter((item) => item.typeId === selectedId),
  );
  let rows = $state<(EquipmentSlot & { key: number; originalName?: string })[]>(
    [],
  );
  let nextKey = 0;
  let composing = false;
  let form = $state<HTMLFormElement>();
  const serialized = $derived(
    JSON.stringify(
      rows.map(({ name, type, direction }) => ({ name, type, direction })),
    ),
  );
  $effect(() => {
    scope;
    savedSlots;
    untrack(
      () =>
        (rows = JSON.parse(savedSlots).map((slot: EquipmentSlot) => ({
          ...slot,
          key: nextKey++,
          originalName: slot.name,
        }))),
    );
  });
  $effect(() => {
    if (selectedId && !selected) selectedId = "";
  });
  function adopted(name: string) {
    return users.filter((item) =>
      item.bindings.some((binding) => binding.slotName === name),
    ).length;
  }
  function mark() {
    const input = form?.querySelector<HTMLInputElement>('input[name="slots"]');
    if (!form?.isConnected || !input) return;
    // Protect structure immediately, before a following navigation event can run.
    input.value = serialized;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function update(key: number, patch: Partial<EquipmentSlot>) {
    rows = rows.map((row) => (row.key === key ? { ...row, ...patch } : row));
    mark();
  }
  function inputKey(event: KeyboardEvent) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (!composing && !event.isComposing && event.keyCode !== 229)
      form?.requestSubmit();
  }
</script>

<section aria-label="機器種別の編集">
  <label
    >編集する種別<select
      aria-label="編集する機器種別"
      value={selectedId}
      onchange={(event) => {
        const value = event.currentTarget.value;
        event.currentTarget.value = selectedId;
        transition(() => (selectedId = value));
      }}
      ><option value="">新しい種別</option
      >{#each project.equipmentTypes ?? [] as type (type.id)}<option
          value={type.id}>{type.name} · {type.id.slice(-6)}</option
        >{/each}</select
    ></label
  >
  <p>
    種別は信号の役割と型を定義します。外部名は機器ごとに割り付けます。変更しても機器割付・Symbol宣言は自動変更しません。
  </p>
  {#key scope}
    <form
      id={formId}
      bind:this={form}
      use:drafts.track={{ name: selected?.name ?? "", slots: savedSlots }}
      data-editor-form="equipment-type"
      data-type-id={selected?.id ?? ""}
      data-target-key={scope}
      aria-label="機器種別を保存"
      onreset={(event) => {
        const input = event.currentTarget.querySelector<HTMLInputElement>(
          'input[name="slots"]',
        );
        if (input)
          rows = JSON.parse(input.value).map((slot: EquipmentSlot) => ({
            ...slot,
            key: nextKey++,
            originalName: slot.name,
          }));
      }}
      oncompositionstart={() => (composing = true)}
      oncompositionend={() => (composing = false)}
      onsubmit={(event) => {
        if (composing) {
          event.preventDefault();
          return;
        }
        const before = new Set(project.equipmentTypes?.map((type) => type.id));
        const target = event.currentTarget;
        const owner = generation;
        onsubmit(event);
        if (!selected)
          void tick().then(() => {
            if (owner !== generation || !target.isConnected || selectedId)
              return;
            const created = project.equipmentTypes?.find(
              (type) => !before.has(type.id),
            );
            if (created) selectedId = created.id;
          });
      }}
    >
      <label
        >種別名<input
          name="name"
          required
          maxlength="200"
          onkeydown={inputKey}
        /></label
      >
      <input type="hidden" name="slots" value={serialized} />
    </form>
    <h4>読取slot {rows.length} / 64</h4>
    <div
      role="group"
      aria-label="読取slotの構成"
      oncompositionstart={() => (composing = true)}
      oncompositionend={() => (composing = false)}
    >
      {#each rows as row (row.key)}
        {@const count = row.originalName ? adopted(row.originalName) : 0}
        <div class="slot" data-equipment-type-slot={row.key}>
          <label
            >slot名<input
              aria-label="slot名"
              value={row.name}
              readonly={count > 0}
              oninput={(event) =>
                update(row.key, { name: event.currentTarget.value })}
              onkeydown={inputKey}
            /></label
          >
          <label
            >型<select
              aria-label="slot型"
              value={row.type}
              disabled={count > 0}
              onchange={(event) =>
                update(row.key, {
                  type: event.currentTarget.value as "bool" | "number",
                })}
              ><option value="bool">bool</option><option value="number"
                >number</option
              ></select
            ></label
          >
          <span>採用機器 {count}件</span>
          <button
            type="button"
            disabled={count > 0}
            title={count ? "採用中slotは削除できません" : "この読取slotを削除"}
            onclick={() => {
              rows = rows.filter((item) => item.key !== row.key);
              mark();
            }}>slotを削除</button
          >
          {#if count}<small
              >未割付も採用に含みます。先に機器の採用を解除してください。</small
            >{/if}
        </div>
      {/each}
    </div>
    <button
      type="button"
      disabled={rows.length >= 64}
      onclick={() => {
        rows = [
          ...rows,
          { key: nextKey++, name: "", type: "number", direction: "read" },
        ];
        mark();
      }}>読取slotを追加</button
    >
    <button
      type="submit"
      form={formId}
      disabled={!selected && (project.equipmentTypes?.length ?? 0) >= 100}
      >{selected ? "機器種別を適用" : "機器種別を作成"}</button
    >
    {#if selected}
      <p>
        使用機器 {users.length}件。採用中slotの改名・型変更・削除を保護します。
      </p>
      <button
        type="button"
        disabled={users.length > 0}
        onclick={() =>
          oncommand({ type: "remove-equipment-type", typeId: selected!.id })}
        >この機器種別を削除</button
      >
    {/if}
  {/key}
</section>

<style>
  section {
    display: grid;
    gap: 8px;
    font-size: 12px;
  }
  label {
    display: grid;
    gap: 4px;
  }
  input,
  select,
  button {
    max-width: 100%;
    box-sizing: border-box;
    font: inherit;
    width: 100%;
    min-width: 0;
    color: var(--banto-text);
    border: 1px solid var(--banto-border);
    border-radius: 4px;
    padding: 6px;
    background: var(--banto-bg);
  }
  button {
    cursor: pointer;
    text-align: left;
    background: var(--banto-surface);
  }
  button:disabled,
  select:disabled {
    opacity: 0.5;
    cursor: default;
  }
  button:focus-visible,
  input:focus-visible,
  select:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
  .slot {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 84px;
    gap: 6px;
    border-top: 1px solid var(--banto-border);
    padding: 8px 0;
  }
  .slot > span,
  .slot > button,
  .slot > small {
    grid-column: 1 / -1;
  }
  p,
  h4 {
    margin: 0;
  }
  p,
  small {
    color: var(--banto-text-muted);
  }
  form {
    display: grid;
    gap: 8px;
  }
</style>
