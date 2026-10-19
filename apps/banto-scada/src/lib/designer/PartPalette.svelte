<script lang="ts">
  import FavoriteButton from "./FavoriteButton.svelte";
  import { Modal } from "@banto/ui";
  import ContextActions from "./ContextActions.svelte";
  import type { AddKind } from "../editor";
  import type { SymbolDefinition } from "../project";
  import builtins from "../symbol-library.json";
  import SymbolThumbnail from "./SymbolThumbnail.svelte";
  import { PALETTE_MIME, type PalettePart } from "./palette-drag";
  import {
    getPaletteView,
    setPaletteView,
    type PaletteView,
  } from "../banto/setup";
  let {
    definitions,
    allowSymbols = true,
    onadd,
    onbuiltin,
    onplace,
    onstartdrag,
    onenddrag,
    contextKey,
    onedit,
    onduplicate,
    isFavorite,
    ontoggleFavorite,
  }: {
    definitions: SymbolDefinition[];
    allowSymbols?: boolean;
    onadd: (kind: AddKind) => void;
    onbuiltin: (template: "pump" | "valve") => void;
    onplace: (id: string) => void;
    onstartdrag: (part: PalettePart) => string | null;
    onenddrag: () => void;
    contextKey: string;
    onedit: (id: string) => void;
    onduplicate: (id: string) => void;
    isFavorite: (part: PalettePart) => boolean;
    ontoggleFavorite: (part: PalettePart) => void;
  } = $props();
  let search = $state("");
  let info = $state<{
    name: string;
    category: string;
    description: string;
    definition?: SymbolDefinition;
  } | null>(null);
  $effect(() => {
    contextKey;
    info = null;
  });

  let view = $state(getPaletteView());
  const menuKey = $derived(`${contextKey}:${allowSymbols}:${search}:${view}`);
  function changeView(next: PaletteView) {
    view = next;
    void setPaletteView(next);
  }
  function startDrag(event: DragEvent, part: PalettePart) {
    const token = onstartdrag(part);
    if (!event.dataTransfer || !token) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(PALETTE_MIME, token);
  }
  type Category = "basic" | "symbols" | "objects";
  let expanded = $state<Record<Category, boolean>>({
    basic: true,
    symbols: true,
    objects: true,
  });
  const searching = $derived(search.trim().length > 0);
  const categories = [
    { id: "basic", label: "基本図形" },
    { id: "symbols", label: "シンボル" },
    { id: "objects", label: "オブジェクト（監視部品）" },
  ] as const;
  const basics: {
    kind: AddKind;
    label: string;
    keywords: string;
    description: string;
  }[] = [
    {
      kind: "rectangle",
      label: "Rectangle を追加",
      keywords: "矩形 四角 rectangle",
      description:
        "矩形を描画します。位置・サイズ・色をプロパティで設定できます。",
    },
    {
      kind: "ellipse",
      label: "Ellipse を追加",
      keywords: "楕円 円 ellipse",
      description:
        "円や楕円を描画します。位置・サイズ・色をプロパティで設定できます。",
    },
    {
      kind: "text",
      label: "Text を追加",
      keywords: "文字 テキスト text",
      description:
        "文字を表示します。画面上の Text は読み取り専用の数値タグの割り当てにも使えます。",
    },
    {
      kind: "line",
      label: "線を追加",
      keywords: "線 line",
      description: "線を描画します。頂点・線幅・色・終点の矢印を設定できます。",
    },
    {
      kind: "pipe",
      label: "配管を追加",
      keywords: "配管 pipe",
      description:
        "配管を配置します。折れ線の頂点を編集して経路を変更できます。",
    },
  ];
  const equipment = [
    {
      template: "pump" as const,
      label: "ポンプを追加",
      keywords: "ポンプ pump",
    },
    {
      template: "valve" as const,
      label: "バルブを追加",
      keywords: "バルブ 弁 valve",
    },
  ];
  function matches(value: string) {
    return value
      .normalize("NFKC")
      .toLocaleLowerCase()
      .includes(search.trim().normalize("NFKC").toLocaleLowerCase());
  }
  const basicResults = $derived(
    basics.filter((p) => matches(p.label + " " + p.keywords)),
  );
  const builtinResults = $derived(
    allowSymbols
      ? equipment.filter((p) => matches(p.label + " " + p.keywords))
      : [],
  );
  const definitionResults = $derived(
    allowSymbols ? definitions.filter((d) => matches(d.name)) : [],
  );
  const primitiveResults = $derived(
    basicResults.filter((part) => part.kind !== "text"),
  );
  const objectResults = $derived(
    basicResults.filter((part) => part.kind === "text"),
  );
  function categoryCount(category: Category): number {
    return category === "basic"
      ? primitiveResults.length
      : category === "symbols"
        ? builtinResults.length + definitionResults.length
        : objectResults.length;
  }
  const count = $derived(
    basicResults.length + builtinResults.length + definitionResults.length,
  );
</script>

<section aria-label="部品パレット" class:names={view === "names"}>
  <h2 class="sr-only">部品を追加</h2>
  <div class="search-tools">
    <label class="search"
      ><span class="sr-only">部品を検索</span><input
        type="search"
        bind:value={search}
        placeholder="部品を検索"
      /></label
    >
    <div class="view-toggle" role="group" aria-label="部品の表示形式">
      <button
        aria-label="アイコン一覧"
        title="アイコン一覧"
        aria-pressed={view === "icons"}
        onclick={() => changeView("icons")}
        ><span aria-hidden="true">▦</span></button
      >
      <button
        aria-label="名称一覧"
        title="名称一覧"
        aria-pressed={view === "names"}
        onclick={() => changeView("names")}
        ><span aria-hidden="true">☰</span></button
      >
    </div>
  </div>
  <p class="results sr-only" role="status">
    {count} 件{!allowSymbols ? " · 定義内は基本図形のみ" : ""}
  </p>
  {#each categories as category}
    {#if (category.id !== "symbols" || allowSymbols) && (!searching || categoryCount(category.id) > 0)}
      <section class="category" aria-label={category.label}>
        <ContextActions
          label={category.label}
          contextKey={menuKey}
          items={[
            {
              label: "この分類を展開",
              disabled: searching || expanded[category.id],
              run: () => (expanded[category.id] = true),
            },
            {
              label: "この分類を折りたたむ",
              disabled: searching || !expanded[category.id],
              run: () => (expanded[category.id] = false),
            },
            {
              label: "すべての分類を展開",
              disabled: searching,
              run: () =>
                (expanded = { basic: true, symbols: true, objects: true }),
            },
            {
              label: "すべての分類を折りたたむ",
              disabled: searching,
              run: () =>
                (expanded = { basic: false, symbols: false, objects: false }),
            },
          ]}
        >
          <h3>
            <button
              class="category-heading"
              aria-expanded={searching || expanded[category.id]}
              aria-controls={`palette-${category.id}`}
              disabled={searching}
              title={searching
                ? "検索中は一致する分類を展開します。検索解除で元の開閉状態に戻ります。"
                : undefined}
              onclick={() => (expanded[category.id] = !expanded[category.id])}
            >
              <span aria-hidden="true"
                >{searching || expanded[category.id] ? "▾" : "▸"}</span
              >
              <span>{category.label}</span><small
                >{categoryCount(category.id)} 件</small
              >
            </button>
          </h3>
        </ContextActions>
        <div
          id={`palette-${category.id}`}
          hidden={!searching && !expanded[category.id]}
        >
          {#if category.id === "symbols"}
            <div class="cards">
              {#each builtinResults as part}
                <ContextActions
                  label={`${part.template === "pump" ? "ポンプ" : "バルブ"}（組込）`}
                  contextKey={menuKey}
                  items={[
                    {
                      label: "現在の画面へ配置",
                      run: () => onbuiltin(part.template),
                    },
                    {
                      label: "部品情報",
                      run: () =>
                        (info = {
                          name: part.template === "pump" ? "ポンプ" : "バルブ",
                          category: "組込シンボル",
                          description:
                            "組込テンプレートから Project の共有定義と配置を追加します。テンプレート自体は変更しません。",
                          definition: builtins[
                            part.template
                          ] as unknown as SymbolDefinition,
                        }),
                    },
                  ]}
                >
                  <button
                    class="part"
                    aria-label={part.label}
                    title={part.label}
                    draggable="true"
                    ondragstart={(event) =>
                      startDrag(event, {
                        type: "builtin",
                        template: part.template,
                      })}
                    ondragend={onenddrag}
                    onclick={() => onbuiltin(part.template)}
                  >
                    <SymbolThumbnail
                      definition={builtins[
                        part.template
                      ] as unknown as SymbolDefinition}
                    />
                    <span class:sr-only={view === "icons"}>{part.label}</span>
                  </button>
                  <FavoriteButton
                    active={isFavorite({
                      type: "builtin",
                      template: part.template,
                    })}
                    label={part.template === "pump" ? "ポンプ" : "バルブ"}
                    ontoggle={() =>
                      ontoggleFavorite({
                        type: "builtin",
                        template: part.template,
                      })}
                  />
                </ContextActions>
              {/each}
            </div>
            {#if definitionResults.length}
              <h3>Project の共有定義</h3>
              <div class="cards">
                {#each definitionResults as definition (definition.id)}
                  <ContextActions
                    label={`${definition.name}（共有定義）`}
                    contextKey={menuKey}
                    items={[
                      {
                        label: "現在の画面へ配置",
                        run: () => onplace(definition.id),
                      },
                      {
                        label: "共有定義を編集（すべての参照配置に反映）",
                        run: () => onedit(definition.id),
                      },
                      {
                        label: "共有定義を複製",
                        disabled: definitions.length >= 100,
                        run: () => onduplicate(definition.id),
                      },
                      {
                        label: "部品情報",
                        run: () =>
                          (info = {
                            name: definition.name,
                            category: "Project の共有定義",
                            description:
                              "配置はこの定義を共有します。定義の複製では既存配置の参照先は変わりません。",
                            definition,
                          }),
                      },
                    ]}
                  >
                    <button
                      class="part"
                      aria-label={`${definition.name} を配置`}
                      title={definition.name}
                      draggable="true"
                      ondragstart={(event) =>
                        startDrag(event, {
                          type: "symbol",
                          symbolId: definition.id,
                        })}
                      ondragend={onenddrag}
                      onclick={() => onplace(definition.id)}
                    >
                      <SymbolThumbnail {definition} /><span
                        class:sr-only={view === "icons"}>{definition.name}</span
                      ><small class="sr-only">配置を追加</small>
                    </button>
                    <FavoriteButton
                      active={isFavorite({
                        type: "symbol",
                        symbolId: definition.id,
                      })}
                      label={`共有定義：${definition.name}`}
                      ontoggle={() =>
                        ontoggleFavorite({
                          type: "symbol",
                          symbolId: definition.id,
                        })}
                    />
                  </ContextActions>
                {/each}
              </div>
            {/if}
          {:else}
            <div class="cards">
              {#each category.id === "basic" ? primitiveResults : objectResults as part}
                <ContextActions
                  label={part.label.replace(/を追加$/, "").trim()}
                  contextKey={menuKey}
                  items={[
                    { label: "現在の画面へ配置", run: () => onadd(part.kind) },
                    {
                      label: "部品情報",
                      run: () =>
                        (info = {
                          name: part.label.replace(/を追加$/, "").trim(),
                          category: category.label,
                          description: part.description,
                        }),
                    },
                  ]}
                >
                  <button
                    class="part"
                    aria-label={part.label}
                    title={part.label}
                    draggable="true"
                    ondragstart={(event) =>
                      startDrag(event, { type: "basic", kind: part.kind })}
                    ondragend={onenddrag}
                    onclick={() => onadd(part.kind)}
                  >
                    <svg aria-hidden="true" viewBox="0 0 60 40">
                      {#if part.kind === "rectangle"}<rect
                          x="10"
                          y="6"
                          width="40"
                          height="28"
                          rx="2"
                        />
                      {:else if part.kind === "ellipse"}<ellipse
                          cx="30"
                          cy="20"
                          rx="22"
                          ry="14"
                        />
                      {:else if part.kind === "text"}<text
                          x="21"
                          y="31"
                          stroke="none"
                          fill="currentColor"
                          font-size="30">A</text
                        >
                      {:else if part.kind === "line"}<path d="M8 32L52 8" />
                      {:else}<path d="M8 8H30V32H52" stroke-width="5" />{/if}
                    </svg>
                    <span class:sr-only={view === "icons"}>{part.label}</span>
                  </button>
                  <FavoriteButton
                    active={isFavorite({ type: "basic", kind: part.kind })}
                    label={part.label.replace(/を追加$/, "").trim()}
                    ontoggle={() =>
                      ontoggleFavorite({ type: "basic", kind: part.kind })}
                  />
                </ContextActions>
              {/each}
            </div>
          {/if}
        </div>
      </section>
    {/if}
  {/each}
  {#if count === 0}<p>
      一致する部品がありません。名前や種類を変えて検索してください。
    </p>{/if}
  {#if search}<button class="clear" onclick={() => (search = "")}
      >検索をクリア</button
    >{/if}
</section>
<Modal open={info !== null} title="部品情報" onclose={() => (info = null)}>
  {#if info}
    <h2>{info.name}</h2>
    <p>{info.category}</p>
    <p>{info.description}</p>
    {#if info.definition}<p>
        定義サイズ: {info.definition.width} × {info.definition.height} · {info
          .definition.objects.length} 図形
      </p>{/if}
  {/if}
</Modal>

<style>
  .search-tools {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .search-tools .search {
    flex: 1;
    min-width: 0;
  }
  .view-toggle {
    display: flex;
    gap: 2px;
  }
  .view-toggle button {
    width: 28px;
    min-height: 30px;
    height: 30px;
    padding: 2px;
    font-size: 18px;
  }
  .view-toggle button[aria-pressed="true"] {
    color: var(--banto-primary);
    border-color: var(--banto-primary);
  }
  .names .cards {
    grid-template-columns: minmax(0, 1fr);
  }
  .names .part {
    height: auto;
    min-height: 36px;
    padding: 6px;
    flex-direction: row;
    justify-content: flex-start;
    text-align: left;
    padding-right: 20px;
  }
  .names .cards :global(svg) {
    width: 32px;
    height: 28px;
    flex-shrink: 0;
  }
  h2 {
    font-size: 15px;
    margin: 0;
  }
  .category {
    margin-top: 12px;
  }
  .category-heading {
    width: 100%;
    min-height: 34px;
    padding: 7px 4px;
    border: 0;
    border-bottom: 1px solid var(--banto-border);
    border-radius: 0;
    flex-direction: row;
    justify-content: flex-start;
    text-align: left;
    background: transparent;
    font-weight: 600;
  }
  .category-heading small {
    margin-left: auto;
    white-space: nowrap;
  }
  .category-heading:disabled {
    cursor: default;
  }
  .category h3 {
    margin: 0 0 8px;
  }
  [hidden] {
    display: none;
  }
  h3 {
    font-size: 12px;
    color: var(--banto-text-muted);
    margin: 16px 0 8px;
  }
  .search {
    display: grid;
    gap: 6px;
    margin-top: 0;
    font-size: 12px;
    color: var(--banto-text-muted);
  }
  input {
    width: 100%;
    min-width: 0;
    padding: 8px;
    border: 1px solid var(--banto-border);
    border-radius: 4px;
    background: var(--banto-bg);
    color: var(--banto-text);
    font: inherit;
  }
  .results,
  p {
    font-size: 12px;
    line-height: 1.6;
    color: var(--banto-text-muted);
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(40px, 1fr));
    gap: 4px;
  }
  .part {
    width: 100%;
    min-height: 44px;
    height: 44px;
    padding: 4px;
    border-color: transparent;
    border-radius: 3px;
    background: transparent;
    cursor: grab;
  }
  .part:hover {
    background: var(--banto-surface-hover);
  }
  .cards :global(svg) {
    width: 100%;
    height: 34px;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
  button {
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 10px 6px;
    min-height: 80px;
    font: inherit;
    font-size: 12px;
    color: var(--banto-text);
    background: var(--banto-surface);
    border: 1px solid var(--banto-border);
    border-radius: 6px;
    cursor: pointer;
  }
  button:hover {
    border-color: var(--banto-primary);
  }
  button:focus-visible,
  input:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
  span {
    max-width: 100%;
    overflow-wrap: anywhere;
  }
  small {
    color: var(--banto-text-muted);
    font-size: 10px;
  }
  svg {
    width: 48px;
    height: 40px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    pointer-events: none;
  }
  .clear {
    min-height: 32px;
    width: 100%;
    margin-top: 8px;
  }
</style>
