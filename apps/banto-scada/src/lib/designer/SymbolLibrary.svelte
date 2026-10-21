<script lang="ts">
  import { tick } from "svelte";
  import SymbolThumbnail from "./SymbolThumbnail.svelte";
  import SymbolUsages from "./SymbolUsages.svelte";
  import { symbolUsages, type SymbolUsage } from "../symbol-usages";
  import ContextActions, { type ContextAction } from "./ContextActions.svelte";
  import { symbolUsage, type EditCommand } from "../editor";
  import type { Project } from "../project";
  let {
    images,
    project,
    selectedId,
    screenId,
    editingDefinition,
    contextKey,
    workspaceKey,
    onopenusage,
    onchoose,
    onedit,
    ondelete,
    oncommand,
  }: {
    images?: ReadonlyMap<
      string,
      { url: string; width: number; height: number }
    >;
    project: Project;
    selectedId: string;
    screenId: string;
    editingDefinition: boolean;
    contextKey: string;
    workspaceKey: number;
    onopenusage: (usage: SymbolUsage) => void;
    onchoose: (id: string) => void;
    onedit: (id: string) => void;
    ondelete: (id: string) => void;
    oncommand: (command: EditCommand) => void;
  } = $props();
  const selected = $derived(
    project.symbols.find((d) => d.id === selectedId) ?? project.symbols[0],
  );
  let usageId = $state<string | null>(null);
  let usageList = $state<SymbolUsages>();
  let root: HTMLElement;
  const usageDefinition = $derived(
    project.symbols.find((d) => d.id === usageId),
  );
  $effect(() => {
    workspaceKey;
    usageId = null;
  });
  $effect(() => {
    if (usageId && !usageDefinition) usageId = null;
  });
  function showUsages(id: string) {
    usageId = id;
    void tick().then(() => usageList?.focus());
  }
  function closeUsages() {
    const id = usageId;
    usageId = null;
    void tick().then(() =>
      [...root.querySelectorAll<HTMLButtonElement>("[data-symbol-row]")]
        .find((button) => button.dataset.symbolRow === id)
        ?.focus(),
    );
  }
  function actions(id: string): ContextAction[] {
    return [
      { label: "使用先を確認", run: () => showUsages(id) },
      {
        label: "共有定義を編集（すべての参照配置に反映）",
        run: () => onedit(id),
      },
      {
        label: "共有定義を複製",
        disabled: project.symbols.length >= 100,
        run: () => oncommand({ type: "duplicate-symbol", symbolId: id }),
      },
      {
        label: "現在の画面へ配置",
        disabled: editingDefinition,
        run: () => oncommand({ type: "place-symbol", screenId, symbolId: id }),
      },
      {
        label: "共有定義を削除",
        disabled: symbolUsage(project, id) > 0,
        run: () => ondelete(id),
      },
    ];
  }
</script>

<section aria-label="Symbol ライブラリ" bind:this={root}>
  <h2>Symbol ライブラリ</h2>
  <button
    data-create-symbol
    disabled={project.symbols.length >= 100}
    onclick={() =>
      oncommand({
        type: "create-symbol",
        name: `Symbol ${project.symbols.length + 1}`,
        width: 100,
        height: 100,
      })}>Symbol 定義を作成</button
  >
  {#if selected}
    <p>定義を選んで操作します。編集はすべての参照配置に反映されます。</p>
    <nav aria-label="共有 Symbol 一覧">
      {#each project.symbols as definition (definition.id)}
        <ContextActions
          flat
          label={`共有定義：${definition.name}`}
          contextKey={`${contextKey}:${selected.id}:${editingDefinition}`}
          items={actions(definition.id)}
        >
          <button
            class="definition-row"
            data-symbol-row={definition.id}
            class:active={selected.id === definition.id}
            aria-label={`共有定義：${definition.name}`}
            aria-pressed={selected.id === definition.id}
            onclick={() => onchoose(definition.id)}
          >
            <SymbolThumbnail {images} {definition} compact /><span
              >{definition.name}</span
            ><small>{symbolUsage(project, definition.id)} 配置で共有</small>
          </button>
        </ContextActions>
      {/each}
    </nav>
    <p>{symbolUsage(project, selected.id)} 配置で共有</p>
    <div class="actions">
      <button onclick={() => showUsages(selected.id)}>使用先を確認</button>
      <button onclick={() => onedit(selected.id)}>定義を編集</button>
      <button
        disabled={project.symbols.length >= 100}
        onclick={() =>
          oncommand({ type: "duplicate-symbol", symbolId: selected.id })}
        >定義を複製</button
      >
      <button
        disabled={symbolUsage(project, selected.id) > 0}
        onclick={() => ondelete(selected.id)}>定義を削除</button
      >
      {#if !editingDefinition}<button
          onclick={() =>
            oncommand({
              type: "place-symbol",
              screenId,
              symbolId: selected.id,
            })}>画面に配置</button
        >{/if}
    </div>
  {/if}
  {#if usageDefinition}
    {#key usageDefinition.id}
      <SymbolUsages
        bind:this={usageList}
        definition={usageDefinition}
        usages={symbolUsages(project, usageDefinition.id)}
        onopen={onopenusage}
        onclose={closeUsages}
      />
    {/key}
  {/if}
</section>

<style>
  h2 {
    font-size: 15px;
    margin: 0;
  }
  p {
    font-size: 12px;
    color: var(--banto-text-muted);
  }
  button {
    font: inherit;
    font-size: 12px;
    color: var(--banto-text);
    background: var(--banto-surface);
    border: 1px solid var(--banto-border);
    border-radius: 6px;
    cursor: pointer;
    padding: 9px 8px;
    width: 100%;
    text-align: left;
    margin: 8px 0;
  }
  button:hover {
    border-color: var(--banto-primary);
  }
  button:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  nav {
    display: grid;
    gap: 0;
    max-height: 240px;
    overflow-y: auto;
    padding: 3px;
    margin: 0 -3px;
  }
  .definition-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 36px;
    border: 0;
    border-radius: 3px;
    background: transparent;
    margin: 0;
    padding: 7px 24px 7px 8px;
    overflow-wrap: anywhere;
  }
  .definition-row:hover {
    background: color-mix(in srgb, var(--banto-primary) 6%, transparent);
  }
  .definition-row.active {
    background: color-mix(in srgb, var(--banto-primary) 13%, transparent);
  }
  .definition-row > span {
    flex: 1;
    min-width: 0;
  }
  .definition-row small {
    max-width: 45%;
    font-size: 10px;
  }
  .definition-row:focus-visible {
    box-shadow: inset var(--banto-focus-ring);
  }
  small {
    font-size: 11px;
    color: var(--banto-text-muted);
  }
  .actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
  }
  .actions button {
    margin: 0;
  }
</style>
