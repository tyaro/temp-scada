<script lang="ts">
  import type { AddKind } from "../editor";
  import type { SymbolDefinition } from "../project";
  import builtins from "../symbol-library.json";
  import SymbolThumbnail from "./SymbolThumbnail.svelte";
  let {
    definitions,
    allowSymbols = true,
    onadd,
    onbuiltin,
    onplace,
  }: {
    definitions: SymbolDefinition[];
    allowSymbols?: boolean;
    onadd: (kind: AddKind) => void;
    onbuiltin: (template: "pump" | "valve") => void;
    onplace: (id: string) => void;
  } = $props();
  let search = $state("");
  const basics: { kind: AddKind; label: string; keywords: string }[] = [
    {
      kind: "rectangle",
      label: "Rectangle を追加",
      keywords: "矩形 四角 rectangle",
    },
    { kind: "ellipse", label: "Ellipse を追加", keywords: "楕円 円 ellipse" },
    { kind: "text", label: "Text を追加", keywords: "文字 テキスト text" },
    { kind: "line", label: "線を追加", keywords: "線 line" },
    { kind: "pipe", label: "配管を追加", keywords: "配管 pipe" },
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
  const count = $derived(
    basicResults.length + builtinResults.length + definitionResults.length,
  );
</script>

<section aria-label="部品パレット">
  <h2>部品を追加</h2>
  <label class="search"
    >部品を検索<input
      type="search"
      bind:value={search}
      placeholder="名前・種類で検索"
    /></label
  >
  <p class="results" role="status">
    {count} 件{!allowSymbols ? " · 定義内は基本図形のみ" : ""}
  </p>
  <div class="cards">
    {#each basicResults as part}
      <button onclick={() => onadd(part.kind)}>
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
        <span>{part.label}</span>
      </button>
    {/each}
    {#each builtinResults as part}
      <button onclick={() => onbuiltin(part.template)}>
        <SymbolThumbnail
          definition={builtins[part.template] as unknown as SymbolDefinition}
        />
        <span>{part.label}</span>
      </button>
    {/each}
  </div>
  {#if definitionResults.length}
    <h3>Project の共有定義</h3>
    <div class="cards">
      {#each definitionResults as definition (definition.id)}
        <button
          aria-label={`${definition.name} を配置`}
          title={definition.name}
          onclick={() => onplace(definition.id)}
        >
          <SymbolThumbnail {definition} /><span>{definition.name}</span><small
            >配置を追加</small
          >
        </button>
      {/each}
    </div>
  {/if}
  {#if count === 0}<p>
      一致する部品がありません。名前や種類を変えて検索してください。
    </p>{/if}
  {#if search}<button class="clear" onclick={() => (search = "")}
      >検索をクリア</button
    >{/if}
</section>

<style>
  h2 {
    font-size: 15px;
    margin: 0;
  }
  h3 {
    font-size: 12px;
    color: var(--banto-text-muted);
    margin: 16px 0 8px;
  }
  .search {
    display: grid;
    gap: 6px;
    margin-top: 12px;
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
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px;
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
