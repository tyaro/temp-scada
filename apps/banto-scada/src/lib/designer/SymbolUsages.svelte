<script lang="ts">
  import type { SymbolDefinition } from "../project";
  import type { SymbolUsage } from "../symbol-usages";
  let {
    definition,
    usages,
    onopen,
    onclose,
  }: {
    definition: SymbolDefinition;
    usages: SymbolUsage[];
    onopen: (usage: SymbolUsage) => void;
    onclose: () => void;
  } = $props();
  let query = $state("");
  let search = $state<HTMLInputElement>();
  let panel = $state<HTMLElement>();
  const normalized = (text: string) =>
    text.normalize("NFKC").toLocaleLowerCase();
  const shown = $derived(
    usages.filter((usage) =>
      normalized(
        `${usage.name ?? ""} ${usage.screenName} ${usage.screenId} ${usage.objectId} ${usage.order}`,
      ).includes(normalized(query.trim())),
    ),
  );
  export function focus() {
    (search ?? panel)?.focus();
  }
</script>

<section aria-label="共有定義の使用先" tabindex="-1" bind:this={panel}>
  <div class="heading">
    <h3>{definition.name} の使用先</h3>
    <button class="close" aria-label="使用先一覧を閉じる" onclick={onclose}
      >×</button
    >
  </div>
  <p>
    {usages.length} 配置 / {new Set(usages.map((u) => u.screenId)).size} 画面
  </p>
  {#if usages.length}
    <input
      bind:this={search}
      type="search"
      aria-label="共有定義の使用先を検索"
      placeholder="配置名・画面名・配置 ID で検索"
      bind:value={query}
    />
    <p>配置を選ぶと該当画面を表示します。</p>
    <div class="usages">
      {#each shown as usage (usage.objectId)}
        <button
          aria-label={`${usage.screenName} の ${usage.name ? `${usage.name}（Symbol ${usage.order}）` : `Symbol ${usage.order}`} を表示`}
          title={`${usage.name ?? ""}\n画面 ID: ${usage.screenId}\n配置 ID: ${usage.objectId}`}
          onclick={() => onopen(usage)}
        >
          <span>{usage.screenName}</span><small
            >{usage.name ?? `配置 ${usage.order}`}{usage.visible === false
              ? "（非表示）"
              : ""} · X {usage.x} / Y {usage.y}</small
          >
        </button>
      {/each}
    </div>
    {#if !shown.length}<p role="status">一致する使用先がありません。</p>{/if}
  {:else}<p role="status">この共有定義を使用している配置はありません。</p>{/if}
</section>

<style>
  section {
    border: 1px solid var(--banto-border);
    border-radius: 6px;
    background: var(--banto-surface);
    padding: 10px;
    margin-top: 12px;
    min-width: 0;
  }
  .heading {
    display: flex;
    gap: 6px;
    align-items: start;
  }
  h3 {
    font-size: 13px;
    margin: 0;
    flex: 1;
    overflow-wrap: anywhere;
  }
  p,
  small {
    font-size: 11px;
    color: var(--banto-text-muted);
    line-height: 1.6;
  }
  input,
  button {
    font: inherit;
    font-size: 12px;
    color: var(--banto-text);
    background: var(--banto-surface);
    border: 1px solid var(--banto-border);
    border-radius: 4px;
    padding: 7px;
  }
  input {
    width: 100%;
    box-sizing: border-box;
    min-width: 0;
  }
  button {
    cursor: pointer;
  }
  .close {
    flex-shrink: 0;
    padding: 0 6px;
  }
  .usages {
    display: grid;
    gap: 4px;
    max-height: 240px;
    overflow-y: auto;
    padding: 3px;
    margin: 0 -3px;
  }
  .usages small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .usages button {
    display: grid;
    gap: 3px;
    text-align: left;
    overflow-wrap: anywhere;
  }
  button:hover {
    border-color: var(--banto-primary);
  }
  button:focus-visible,
  input:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
</style>
