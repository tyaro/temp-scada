<script lang="ts">
  import { symbolUsage, type EditCommand } from "../editor";
  import type { Project } from "../project";
  let {
    project,
    selectedId,
    screenId,
    editingDefinition,
    onchoose,
    onedit,
    ondelete,
    oncommand,
  }: {
    project: Project;
    selectedId: string;
    screenId: string;
    editingDefinition: boolean;
    onchoose: (id: string) => void;
    onedit: (id: string) => void;
    ondelete: (id: string) => void;
    oncommand: (command: EditCommand) => void;
  } = $props();
  const selected = $derived(
    project.symbols.find((d) => d.id === selectedId) ?? project.symbols[0],
  );
</script>

<section aria-label="Symbol ライブラリ">
  <h2>Symbol ライブラリ</h2>
  <button
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
    <label
      >Symbol 定義<select
        aria-label="Symbol 定義"
        value={selected.id}
        onchange={(e) => onchoose(e.currentTarget.value)}
      >
        {#each project.symbols as definition (definition.id)}<option
            value={definition.id}>{definition.name}</option
          >{/each}
      </select></label
    >
    <p>{symbolUsage(project, selected.id)} 配置で共有</p>
    <div class="actions">
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
</section>

<style>
  h2 {
    font-size: 15px;
    margin: 0;
  }
  label {
    display: grid;
    gap: 8px;
    font-size: 12px;
  }
  p {
    font-size: 12px;
    color: var(--banto-text-muted);
  }
  select {
    width: 100%;
    padding: 8px;
    color: var(--banto-text);
    background: var(--banto-surface);
    border: 1px solid var(--banto-border);
    border-radius: 4px;
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
  button:focus-visible,
  select:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
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
