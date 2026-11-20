<script lang="ts">
  // 左ペインの「プロジェクト」タブの中身。状態とコマンドは App が持ち、ここは値と callback を受けて描くだけにする（R7b）。
  import type { ComponentProps } from "svelte";
  import type { Project } from "../project";
  import type { EditCommand } from "../editor";
  import type { SymbolUsage } from "../symbol-usages";
  import type { WorkTabKind } from "./controllers/work-tabs.svelte";
  import ContextActions, { type ContextAction } from "./ContextActions.svelte";
  import TreeSection from "./TreeSection.svelte";
  import SymbolLibrary from "./SymbolLibrary.svelte";

  let {
    project,
    editing,
    editingDefinition,
    editBlocked,
    screenId,
    contextKey,
    referenceCount,
    images,
    libraryId,
    workspaceKey,
    screenContextItems,
    onopenscreen,
    onaddscreen,
    onopenreferences,
    onopenusage,
    onchooseSymbol,
    oneditSymbol,
    ondeleteSymbol,
    onsymbolCommand,
    onnewEquipment,
    onopenwork,
    onopenRecordingPlan,
  }: {
    project: Project;
    /** `mode === "edit"` */
    editing: boolean;
    /** Symbol 定義の編集中（`!!activeDefinition`） */
    editingDefinition: boolean;
    editBlocked: boolean;
    screenId: string;
    /** 画面一覧の ⋮ と SymbolLibrary で共有する文脈キー */
    contextKey: string;
    referenceCount: number;
    images: ComponentProps<typeof SymbolLibrary>["images"];
    libraryId: string;
    workspaceKey: number;
    screenContextItems: (id: string) => ContextAction[];
    onopenscreen: (id: string) => void;
    onaddscreen: () => void;
    onopenreferences: () => void;
    onopenusage: (usage: SymbolUsage) => void;
    onchooseSymbol: (id: string) => void;
    oneditSymbol: (id: string) => void;
    ondeleteSymbol: (id: string) => void;
    onsymbolCommand: (command: EditCommand) => void;
    onnewEquipment: () => void;
    onopenwork: (kind: WorkTabKind) => void;
    onopenRecordingPlan: () => void;
  } = $props();
</script>

<div class="project-root" title={project.manifest.name}>
  <span aria-hidden="true">▦</span>
  {project.manifest.name}
</div>
<TreeSection label="画面" count={project.screens.length}>
  {#snippet action()}
    {#if editing}<button
        class="tree-add"
        aria-label="画面を追加（画面一覧）"
        title="画面を追加"
        disabled={project.screens.length >= 100}
        onclick={onaddscreen}>＋</button
      >{/if}
  {/snippet}
  <nav aria-label="画面一覧">
    {#each project.screens as item (item.id)}
      {#snippet row()}
        <button
          class="screen-row"
          data-screen-id={item.id}
          class:active={!editingDefinition && screenId === item.id}
          aria-pressed={!editingDefinition && screenId === item.id}
          onclick={() => onopenscreen(item.id)}
          ><svg
            class="screen-icon"
            aria-hidden="true"
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            ><path d="M5 3h9l5 5v13H5V3zm9 0v6h5M8 13h8M8 17h8" /></svg
          >{item.name}</button
        >
      {/snippet}
      {#if editing}
        <ContextActions
          flat
          label={`画面：${item.name}`}
          {contextKey}
          items={screenContextItems(item.id)}>{@render row()}</ContextActions
        >
      {:else}{@render row()}{/if}
    {/each}
  </nav>
</TreeSection>
{#if editing}
  <TreeSection label="タグ参照" count={referenceCount}>
    <button
      class="reference-link"
      disabled={!referenceCount}
      onclick={onopenreferences}>タグ参照一覧を開く</button
    >
    <p class="hint">
      {referenceCount
        ? "Project 内の割り当てと使用先を確認します。"
        : "表示タグの割り当てはありません。"}
    </p>
  </TreeSection>
  <TreeSection label="シンボル" count={project.symbols.length}>
    <SymbolLibrary
      {images}
      {project}
      selectedId={libraryId}
      {workspaceKey}
      {onopenusage}
      {screenId}
      {editingDefinition}
      {contextKey}
      onchoose={onchooseSymbol}
      onedit={oneditSymbol}
      ondelete={ondeleteSymbol}
      oncommand={onsymbolCommand}
    />
  </TreeSection>
  <TreeSection label="機器" count={project.equipment?.length ?? 0}>
    {#snippet action()}
      <button
        class="tree-add"
        aria-label="機器を新規登録（機器台帳）"
        title="機器を新規登録"
        disabled={editBlocked ||
          editingDefinition ||
          !project.equipmentTypes?.length}
        onclick={onnewEquipment}>＋</button
      >
    {/snippet}
    <div class="settings-rows">
      <button
        disabled={editBlocked || editingDefinition}
        onclick={() => onopenwork("equipment")}>機器台帳を開く</button
      >
    </div>
    {#if editingDefinition}
      <p class="hint">Symbol 定義の編集中は使えません。</p>
    {/if}
  </TreeSection>
  <TreeSection label="設定">
    <div class="settings-rows">
      <button
        disabled={editBlocked || editingDefinition}
        onclick={() => onopenwork("project-settings")}>プロジェクト設定</button
      >
      <button
        disabled={editBlocked || editingDefinition}
        onclick={() => onopenwork("alarm-definitions")}>警報の定義</button
      >
      <button
        disabled={editBlocked || editingDefinition}
        onclick={onopenRecordingPlan}>記録希望設定</button
      >
    </div>
    {#if editingDefinition}
      <p class="hint">Symbol 定義の編集中は使えません。</p>
    {/if}
  </TreeSection>
{/if}

<style>
  /* App の要素向けの基本（button・p・.active・.hint）を、このパネルの要素にも同じ値で当てる。 */
  p {
    font-size: 13px;
    line-height: 1.8;
    color: var(--banto-text-muted);
  }
  button {
    display: block;
    width: 100%;
    text-align: left;
    padding: 9px 10px;
    margin: 8px 0;
    border: 1px solid var(--banto-border);
    background: var(--banto-surface);
    color: var(--banto-text);
    border-radius: 6px;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  button:hover {
    border-color: var(--banto-primary);
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  button:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
  .hint {
    margin-top: 12px;
  }
  .tree-add {
    width: 24px;
    height: 24px;
    padding: 0;
    border: 0;
    border-radius: 3px;
    background: transparent;
    color: var(--banto-primary);
    font-size: 14px;
    cursor: pointer;
  }
  .tree-add:hover {
    background: color-mix(in srgb, var(--banto-primary) 8%, transparent);
  }
  .tree-add:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .project-root {
    padding: 6px 4px 4px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .project-root > span {
    color: var(--banto-primary);
    margin-right: 6px;
  }
  .screen-icon {
    color: var(--banto-text-muted);
    margin-right: 8px;
    vertical-align: middle;
  }
  .screen-row {
    width: 100%;
    padding-right: 24px;
    overflow-wrap: anywhere;
  }
  .screen-row {
    margin: 0;
    padding: 4px 22px 4px 6px;
    min-height: 28px;
    border: 0;
    border-radius: 3px;
    background: transparent;
    color: var(--banto-text);
  }
  .screen-row:hover {
    background: color-mix(in srgb, var(--banto-primary) 6%, transparent);
  }
  .screen-row.active {
    background: color-mix(in srgb, var(--banto-primary) 13%, transparent);
    color: var(--banto-text);
  }
  .screen-row:focus-visible {
    box-shadow: inset var(--banto-focus-ring);
  }
  .reference-link {
    margin: 0;
    border: 0;
    background: transparent;
    padding: 7px 8px;
    font-size: 12px;
    color: var(--banto-text-muted);
  }
  .reference-link:enabled:hover {
    color: var(--banto-primary);
    background: color-mix(in srgb, var(--banto-primary) 6%, transparent);
  }
  /* App と同じ順に、行の規則の後へ置く。 */
  .active {
    border-color: var(--banto-primary);
    color: var(--banto-primary);
  }
</style>
