<script lang="ts">
  import { equipmentUsages, type EquipmentUsage } from "../equipment";
  import { tick } from "svelte";
  import type { Project } from "../project";
  import type { EditCommand } from "../editor";
  import type { createDraftGuard } from "./drafts.svelte";
  let {
    project,
    generation,
    drafts,
    transition,
    oncommand,
    onsubmit,
    onopenusage,
  }: {
    project: Project;
    generation: number;
    drafts: ReturnType<typeof createDraftGuard>;
    transition: (action: () => void) => void;
    oncommand: (command: EditCommand) => unknown;
    onsubmit: (event: SubmitEvent) => void;
    onopenusage: (usage: EquipmentUsage) => void;
  } = $props();
  function hasPreset(name: string) {
    return project.equipmentTypes?.some(
      (type) =>
        type.name === name &&
        (name === "送風機"
          ? type.slots.length === 2 &&
            type.slots.some(
              (slot) => slot.name === "running" && slot.type === "bool",
            ) &&
            type.slots.some(
              (slot) => slot.name === "current" && slot.type === "number",
            )
          : type.slots.length === 1 &&
            type.slots[0].name === "value" &&
            type.slots[0].type === "number"),
    );
  }
  let selectedId = $state("");
  let composing = false;
  function inputKey(event: KeyboardEvent) {
    if (
      event.key === "Enter" &&
      (composing || event.isComposing || event.keyCode === 229)
    )
      event.preventDefault();
  }
  const selected = $derived(
    project.equipment?.find((item) => item.id === selectedId),
  );
  const usages = $derived(
    selected ? equipmentUsages(project, selected.id) : [],
  );
  const kind = $derived(
    project.equipmentTypes?.find((type) => type.id === selected?.typeId),
  );
  const values = $derived.by(() => {
    const values: Record<string, string> = {
      code: selected?.code ?? "",
      name: selected?.name ?? "",
      typeId: project.equipmentTypes?.[0]?.id ?? "",
    };
    for (const slot of kind?.slots ?? []) {
      const binding = selected?.bindings.find(
        (binding) => binding.slotName === slot.name,
      );
      values[`state:${slot.name}`] = !binding
        ? "unadopted"
        : binding.externalName === null
          ? "unassigned"
          : "assigned";
      values[`tag:${slot.name}`] = binding?.externalName ?? "";
    }
    return values;
  });
</script>

<section aria-label="機器台帳">
  <p>
    読取機器の登録と割付。図面のSymbolへ関連付けできます。実Hub接続は後続です。
  </p>
  <div class="actions">
    <button
      disabled={hasPreset("送風機")}
      onclick={() =>
        oncommand({
          type: "create-equipment-type",
          name: "送風機",
          slots: [
            { name: "running", type: "bool", direction: "read" },
            { name: "current", type: "number", direction: "read" },
          ],
        })}>送風機種別を追加</button
    >
    <button
      disabled={hasPreset("計器")}
      onclick={() =>
        oncommand({
          type: "create-equipment-type",
          name: "計器",
          slots: [{ name: "value", type: "number", direction: "read" }],
        })}>計器種別を追加</button
    >
  </div>
  <nav aria-label="登録機器">
    {#each project.equipment ?? [] as item (item.id)}
      <button
        class:active={selected?.id === item.id}
        aria-pressed={selected?.id === item.id}
        onclick={() => transition(() => (selectedId = item.id))}
        >{item.code} · {item.name}</button
      >
    {/each}
    <button
      disabled={!project.equipmentTypes?.length}
      onclick={() => transition(() => (selectedId = ""))}>機器を新規登録</button
    >
  </nav>
  {#if project.equipmentTypes?.length}
    {#key `${generation}:${selected?.id ?? "new"}`}
      <form
        use:drafts.track={values}
        data-editor-form="equipment"
        data-equipment-id={selected?.id ?? ""}
        data-target-key={`${generation}:${project.manifest.projectId}`}
        aria-label={selected ? "機器情報と割付" : "機器を登録"}
        oncompositionstart={() => (composing = true)}
        oncompositionend={() => (composing = false)}
        onsubmit={(event) => {
          if (composing) event.preventDefault();
          else {
            const before = new Set(project.equipment?.map((item) => item.id));
            const owner = generation;
            onsubmit(event);
            if (!selected)
              void tick().then(() => {
                if (owner !== generation) return;
                const created = project.equipment?.find(
                  (item) => !before.has(item.id),
                );
                if (created) transition(() => (selectedId = created.id));
              });
          }
        }}
      >
        {#if selected}<p>種別: {kind?.name}</p>
        {:else}<label
            >機器種別<select name="typeId"
              >{#each project.equipmentTypes as type}<option value={type.id}
                  >{type.name}</option
                >{/each}</select
            ></label
          >{/if}
        <label
          >機器番号<input
            onkeydown={inputKey}
            name="code"
            required
            maxlength="64"
            placeholder="FAN-101"
          /></label
        >
        <label
          >機器名<input
            onkeydown={inputKey}
            name="name"
            required
            maxlength="200"
          /></label
        >
        {#each kind?.slots ?? [] as slot}
          <div class="slot">
            <strong>{slot.name} · {slot.type} / read</strong>
            <label
              >採用・割付状態<select name={`state:${slot.name}`}
                ><option value="unadopted">未採用</option><option
                  value="unassigned">採用・未割付</option
                ><option value="assigned">外部名を割付</option></select
              ></label
            >
            <label
              >外部名（割付時のみ使用）<input
                onkeydown={inputKey}
                name={`tag:${slot.name}`}
                maxlength="512"
                placeholder="PLC01.Fast.Fan01.Run"
              /></label
            >
          </div>
        {/each}
        <p>割付名は保存のみ。型・単位・接続状態は実catalog未確認です。</p>
        <button type="submit"
          >{selected ? "機器情報と割付を適用" : "機器を登録"}</button
        >
      </form>
      {#if selected}
        <section aria-label="機器の使用先">
          <strong>図面の使用先 {usages.length} 件</strong>
          {#each usages as usage (usage.objectId)}
            <button
              title={`配置ID: ${usage.objectId}`}
              onclick={() => onopenusage(usage)}
              >{usage.screenName} · {usage.name ?? "Symbol 配置"} · #{usage.order}
              ({usage.x}, {usage.y}){usage.visible === false
                ? "（非表示）"
                : ""}</button
            >
          {/each}
        </section>
        <button
          disabled={usages.length > 0}
          onclick={() =>
            oncommand({ type: "remove-equipment", equipmentId: selected!.id })}
          >この機器を削除</button
        >{/if}
    {/key}
  {/if}
</section>

<style>
  section,
  form,
  .slot {
    display: grid;
    gap: 8px;
  }
  section {
    padding: 8px 12px;
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
  button.active {
    background: var(--banto-primary-tint);
    border-color: var(--banto-primary);
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
  nav,
  .actions {
    display: grid;
    gap: 4px;
  }
  .slot {
    border-top: 1px solid var(--banto-border);
    padding-top: 8px;
  }
  strong {
    font-size: 12px;
  }
</style>
