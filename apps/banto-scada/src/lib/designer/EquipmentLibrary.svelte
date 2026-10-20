<script lang="ts">
  import EquipmentTypes from "./EquipmentTypes.svelte";
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
  let view = $state<"instances" | "types">("instances");
  let selectedId = $state("");
  let search = $state("");
  let page = $state(0);
  const PAGE_SIZE = 20;
  const normalize = (text: string) =>
    text.normalize("NFKC").toLocaleLowerCase();
  const typeNames = $derived(
    new Map(project.equipmentTypes?.map((type) => [type.id, type.name])),
  );
  const matching = $derived(
    (project.equipment ?? []).filter((item) =>
      normalize(
        `${item.code} ${item.name} ${typeNames.get(item.typeId) ?? ""}`,
      ).includes(normalize(search.trim())),
    ),
  );
  const lastPage = $derived(
    Math.max(0, Math.ceil(matching.length / PAGE_SIZE) - 1),
  );
  const currentPage = $derived(Math.min(page, lastPage));
  $effect(() => {
    search;
    page = 0;
  });
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
  <div class="actions views" role="group" aria-label="機器台帳の表示">
    <button
      class:active={view === "instances"}
      aria-pressed={view === "instances"}
      onclick={() => transition(() => (view = "instances"))}>機器一覧</button
    >
    <button
      class:active={view === "types"}
      aria-pressed={view === "types"}
      onclick={() => transition(() => (view = "types"))}>機器種別</button
    >
  </div>
  {#if view === "types"}
    <EquipmentTypes
      {project}
      {generation}
      {drafts}
      {transition}
      {oncommand}
      {onsubmit}
    />
  {:else}
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
    <input
      type="search"
      aria-label="機器を検索"
      placeholder="機器を検索"
      bind:value={search}
    />
    <p aria-live="polite">
      {matching.length}件 / 全{project.equipment?.length ?? 0}件
    </p>
    <nav aria-label="登録機器">
      {#each matching.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE) as item (item.id)}
        <button
          data-equipment-choice={item.id}
          class:active={selected?.id === item.id}
          aria-pressed={selected?.id === item.id}
          onclick={() => transition(() => (selectedId = item.id))}
          >{item.code} · {item.name}</button
        >
      {/each}
      {#if !matching.length}<p>一致する機器はありません。</p>{/if}
      {#if matching.length > PAGE_SIZE}
        <div class="pages" role="group" aria-label="登録機器のページ">
          <button
            type="button"
            disabled={currentPage === 0}
            onclick={() => (page = currentPage - 1)}>前の機器</button
          >
          <span>{currentPage + 1} / {lastPage + 1}</span>
          <button
            type="button"
            disabled={currentPage === lastPage}
            onclick={() => (page = currentPage + 1)}>次の機器</button
          >
        </div>
      {/if}
      <button
        disabled={!project.equipmentTypes?.length}
        onclick={() => transition(() => (selectedId = ""))}
        >機器を新規登録</button
      >
    </nav>
    {#if selected && !matching.some((item) => item.id === selected.id)}<p>
        編集中: {selected.code}（検索結果外）
      </p>{/if}
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
              oncommand({
                type: "remove-equipment",
                equipmentId: selected!.id,
              })}>この機器を削除</button
          >{/if}
      {/key}
    {/if}
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
  .pages {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    gap: 4px;
    align-items: center;
  }
  .pages button {
    padding: 5px 2px;
    text-align: center;
  }
  .views {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .slot {
    border-top: 1px solid var(--banto-border);
    padding-top: 8px;
  }
  strong {
    font-size: 12px;
  }
</style>
