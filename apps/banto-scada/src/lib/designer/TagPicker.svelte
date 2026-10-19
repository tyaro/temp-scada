<script lang="ts">
  import { Modal } from "@banto/ui";
  import { tick, untrack } from "svelte";
  import {
    catalogNodes,
    numericTag,
    selectedCatalogTag,
    type TagCatalog,
    type CatalogNode,
    type CatalogTag,
  } from "./tag-catalog";
  let {
    open,
    catalog,
    targetLabel,
    onclose,
    onchoose,
  }: {
    open: boolean;
    catalog: TagCatalog;
    targetLabel: string;
    onclose: () => void;
    onchoose: (tag: CatalogTag, revision: string) => void;
  } = $props();
  let query = $state(""),
    compatibleOnly = $state(true),
    focused = $state<string | null>(null),
    selected = $state<string | null>(null);
  let expanded = $state(new Set<string>()),
    revision = $state("");
  let body: HTMLDivElement;
  let searchInput: HTMLInputElement;
  $effect(() => {
    if (!open) return;
    const protect = (event: InputEvent) => {
      if (
        !["historyUndo", "historyRedo"].includes(event.inputType) ||
        (event.target instanceof Node && body?.contains(event.target))
      )
        return;
      // Chromium may route native Undo to the previously edited background field.
      event.preventDefault();
      void tick().then(() => {
        if (open) searchInput?.focus();
      });
    };
    window.addEventListener("beforeinput", protect, true);
    return () => window.removeEventListener("beforeinput", protect, true);
  });
  let tree: HTMLElement;
  let opened: TagCatalog | null = null;
  $effect(() => {
    const active = open,
      current = catalog,
      version = current.revision;
    if (!active) {
      opened = null;
      return;
    }
    if (!opened) {
      opened = current;
      untrack(() => {
        query = "";
        compatibleOnly = true;
        focused = null;
        selected = null;
        expanded = new Set(current.groups.map((g) => g.id));
        revision = version;
      });
    } else if (opened !== current || untrack(() => revision) !== version)
      onclose();
  });
  const nodes = $derived(
    catalogNodes(catalog, query, compatibleOnly, expanded),
  );
  const detail = $derived(nodes.find((n) => n.id === selected)?.tag);
  const candidate = $derived(
    selectedCatalogTag(catalog, revision, nodes, selected),
  );
  const tabstop = $derived(
    nodes.some((n) => n.id === focused) ? focused : nodes[0]?.id,
  );
  function toggle(node: CatalogNode) {
    if (node.tag) {
      selected = node.id;
      return;
    }
    if (query.trim()) {
      selected = null;
      return;
    }
    const id = node.id.slice(6),
      next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expanded = next;
    selected = null;
  }
  function choose(id = selected) {
    if (!open || opened !== catalog) return;
    const tag = selectedCatalogTag(catalog, revision, nodes, id);
    if (tag) onchoose(tag, revision);
  }
  async function focus(id: string | undefined) {
    if (!id) return;
    focused = id;
    await tick();
    tree
      ?.querySelector<HTMLButtonElement>(`[data-node-id="${CSS.escape(id)}"]`)
      ?.focus();
  }
  function key(event: KeyboardEvent, node: CatalogNode) {
    if (event.isComposing) {
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const index = nodes.findIndex((n) => n.id === node.id);
    let next: string | undefined;
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (node.tag) choose(node.id);
      else toggle(node);
      return;
    }
    if (event.key === "ArrowDown")
      next = nodes[Math.min(nodes.length - 1, index + 1)]?.id;
    else if (event.key === "ArrowUp") next = nodes[Math.max(0, index - 1)]?.id;
    else if (event.key === "Home") next = nodes[0]?.id;
    else if (event.key === "End") next = nodes.at(-1)?.id;
    else if (event.key === "ArrowRight" && !node.tag) {
      if (!node.expanded) toggle(node);
      else next = nodes[index + 1]?.id;
    } else if (event.key === "ArrowLeft") {
      if (node.expanded && !query.trim()) toggle(node);
      else next = node.parentId;
    } else return;
    event.preventDefault();
    event.stopPropagation();
    void focus(next);
  }
  function shortcuts(event: KeyboardEvent) {
    if (event.isComposing && event.key === "Escape") {
      event.stopPropagation();
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      const key = event.key.toLowerCase();
      const input =
        event.target instanceof Element &&
        event.target.closest(
          'input:not([type="checkbox"]),textarea,[contenteditable]',
        );
      if (key === "s" || (!input && ["z", "y"].includes(key)))
        event.preventDefault();
      event.stopPropagation();
    }
  }
</script>

<Modal
  {open}
  title="タグを選択"
  width="850px"
  {onclose}
  focusFallback={() =>
    document.querySelector<HTMLElement>("[data-permanent-menu]")}
>
  <!-- svelte-ignore a11y_no_static_element_interactions (dialog内のアプリ共通ショートカットとの境界) -->
  <div class="tag-picker" bind:this={body} onkeydown={shortcuts}>
    <p class="target">割付先：{targetLabel} ／ 数値Text</p>
    <p class="sample-note">
      サンプル候補・Hub未接続。実在や接続成功は未確認です。型の互換性はサンプル定義による判定です。
    </p>
    <div class="search-row">
      <input
        bind:this={searchInput}
        aria-label="タグ候補を検索"
        placeholder="名称・外部名・型で検索"
        bind:value={query}
        onkeydown={(event) => {
          if (event.key === "Enter" && !event.isComposing)
            event.preventDefault();
        }}
      />
      <label
        ><input
          type="checkbox"
          bind:checked={compatibleOnly}
        />互換タグのみ</label
      >
    </div>
    {#if query.trim()}<p class="hint">
        検索中は一致する階層を展開しています。
      </p>{/if}
    <div class="columns">
      <div class="tree-scroll">
        <div bind:this={tree} role="tree" aria-label="タグ候補">
          {#each nodes as node (node.id)}
            <button
              type="button"
              role="treeitem"
              data-node-id={node.id}
              aria-level={node.depth}
              aria-expanded={node.tag ? undefined : node.expanded}
              aria-selected={node.tag ? selected === node.id : undefined}
              tabindex={tabstop === node.id ? 0 : -1}
              class:selected={selected === node.id}
              class:incompatible={node.tag && !numericTag(node.tag)}
              style:padding-left={`${(node.depth - 1) * 18 + 8}px`}
              onfocus={() => {
                focused = node.id;
                selected = node.tag ? node.id : null;
              }}
              onclick={(event) => {
                if (node.tag || event.detail < 2) toggle(node);
              }}
              ondblclick={() => {
                if (node.tag) choose(node.id);
              }}
              onkeydown={(event) => key(event, node)}
            >
              <span aria-hidden="true"
                >{node.tag ? "◇" : node.expanded ? "▾" : "▸"}</span
              ><span>{node.label}</span>{#if node.tag}<small
                  >{node.tag.type}</small
                >{/if}
            </button>
          {/each}
        </div>
        {#if !nodes.length}<p role="status">
            一致するタグ候補はありません。
          </p>{/if}
      </div>
      <section aria-label="タグの詳細">
        {#if detail}
          <h3>{detail.name}</h3>
          <dl>
            <dt>外部名</dt>
            <dd>{detail.externalName}</dd>
            <dt>型</dt>
            <dd>{detail.type}</dd>
            <dt>単位</dt>
            <dd>{detail.unit ?? "—"}</dd>
            <dt>説明</dt>
            <dd>{detail.description}</dd>
          </dl>
          <p>
            {numericTag(detail)
              ? "数値Textに互換（サンプル定義）"
              : "型が不適合です。数値Textにはbit／stringを割り付けできません。"}
          </p>
          <p class="sample-note">現在値は取得していません。</p>
        {:else}<p>タグを選ぶと詳細を確認できます。</p>{/if}
      </section>
    </div>
    <p class="hint">
      選択は未適用の入力へ返します。確定後、プロパティの「変更を適用」とJSON保存が必要です。
    </p>
    <div class="actions">
      <button type="button" onclick={onclose}>キャンセル</button><button
        type="button"
        disabled={!candidate}
        onclick={() => choose()}>選択して入力</button
      >
    </div>
  </div>
</Modal>

<style>
  .tag-picker {
    color: var(--banto-text);
    font-size: 13px;
  }
  p {
    margin: 0 0 10px;
    line-height: 1.6;
  }
  .target {
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .sample-note,
  .hint {
    color: var(--banto-text-muted);
    font-size: 12px;
  }
  .search-row {
    display: flex;
    gap: 12px;
    align-items: center;
    margin-bottom: 12px;
  }
  .search-row > input {
    flex: 1;
    min-width: 0;
  }
  .search-row label {
    display: flex;
    align-items: center;
    white-space: nowrap;
    gap: 5px;
  }
  input,
  button {
    font: inherit;
    color: var(--banto-text);
  }
  input:not([type="checkbox"]) {
    background: var(--banto-bg);
    border: 1px solid var(--banto-border);
    border-radius: 4px;
    padding: 8px;
  }
  .columns {
    display: grid;
    grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
    border-block: 1px solid var(--banto-border);
    min-height: 280px;
    height: min(42dvh, 400px);
    margin-bottom: 12px;
  }
  .tree-scroll {
    overflow: auto;
    border-right: 1px solid var(--banto-border);
    padding: 6px 0;
  }
  [role="treeitem"] {
    width: 100%;
    text-align: left;
    display: flex;
    gap: 7px;
    align-items: center;
    border: 0;
    border-radius: 0;
    background: transparent;
    padding: 7px 8px;
    cursor: pointer;
  }
  [role="treeitem"]:hover {
    background: var(--banto-surface-hover);
  }
  [role="treeitem"].selected {
    background: color-mix(in srgb, var(--banto-primary) 15%, transparent);
  }
  [role="treeitem"]:focus-visible {
    outline: 2px solid var(--banto-primary);
    outline-offset: -2px;
  }
  [role="treeitem"].incompatible {
    color: var(--banto-text-muted);
  }
  small {
    margin-left: auto;
    font:
      11px ui-monospace,
      monospace;
  }
  section {
    overflow: auto;
    padding: 12px;
  }
  h3 {
    font-size: 14px;
    margin: 0 0 12px;
  }
  dl {
    margin: 0 0 12px;
  }
  dt {
    font-size: 11px;
    color: var(--banto-text-muted);
    margin-top: 8px;
  }
  dd {
    margin: 3px 0;
    overflow-wrap: anywhere;
  }
  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
  .actions button {
    background: var(--banto-surface);
    padding: 7px 12px;
    border: 1px solid var(--banto-border);
    border-radius: 4px;
    cursor: pointer;
  }
  .actions button:last-child {
    border-color: var(--banto-primary);
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  @media (max-width: 600px) {
    .columns {
      grid-template-columns: 1fr;
      height: 45dvh;
    }
    .tree-scroll {
      border-right: 0;
      border-bottom: 1px solid var(--banto-border);
    }
    .search-row {
      flex-wrap: wrap;
    }
    .search-row > input {
      width: 100%;
      flex-basis: 100%;
    }
  }
</style>
