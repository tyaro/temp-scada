<script lang="ts">
  import type { Screen, SymbolDefinition } from "../project";
  import type { EquipmentContext } from "../symbol-slots";
  import { slotStatusRows, slotStatusCounts } from "../slot-status-summary";
  let {
    screen,
    screens,
    symbols,
    equipmentContext,
    compact = false,
  }: {
    screen: Screen | SymbolDefinition;
    screens: Screen[];
    symbols: SymbolDefinition[];
    equipmentContext?: EquipmentContext;
    compact?: boolean;
  } = $props();
  const rows = $derived(
    slotStatusRows(screen, screens, symbols, equipmentContext),
  );
  const counts = $derived(slotStatusCounts(rows));
  const PAGE_SIZE = 20;
  let open = $state(false);
  let page = $state(0);
  let toggle = $state<HTMLElement>();
  const lastPage = $derived(
    Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1),
  );
  const currentPage = $derived(Math.min(page, lastPage));
  const visibleRows = $derived(
    open
      ? rows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
      : [],
  );
  const ownerId = $derived(screen.id);
  $effect(() => {
    ownerId;
    page = 0;
    open = false;
  });
</script>

{#if counts.total > 0}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions (Esc belongs to this native disclosure before an enclosing Popup handles it.) -->
  <details
    class="slot-read-status"
    class:compact
    bind:open
    aria-label={`読取状態：${screen.name}`}
    onkeydown={(event) => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !event.isComposing &&
        event.keyCode !== 229 &&
        open
      ) {
        event.preventDefault();
        event.stopPropagation();
        open = false;
        toggle?.focus();
      }
    }}
  >
    <summary bind:this={toggle}>
      表示参照 {counts.total}件
      <span>取得不能 {counts.unavailable}件 · SIM {counts.simulated}件</span>
    </summary>
    {#if open}
      <div class="description">
        図面内の表示参照を集計します。取得不能とSIMは重複することがあります。
      </div>
      <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users need a focusable scroll region for the read-only list.) -->
      <div
        class="rows"
        tabindex="0"
        role="region"
        aria-label="slotの読取状態一覧"
      >
        <ul>
          {#each visibleRows as row (row.key)}
            <li
              data-slot-status-key={row.key}
              data-slot-state={row.display.state}
              data-slot-simulated={row.simulated}
            >
              <div class="identity">{row.path.join(" › ")}</div>
              <div>
                <strong>{row.equipment}</strong> · <code>{row.slotName}</code>
              </div>
              <div class="value">
                {row.display.text}
                {#if row.display.state === "good"}<span
                    >· {row.display.label}</span
                  >{/if}{#if row.display.reason}<span>
                    · {row.display.reason}</span
                  >{/if}
              </div>
              {#if row.display.provenance}
                {@const origin = row.display.provenance}
                <small
                  >source {origin.valueSource} · mode {origin.collectionMode} · catalog
                  {origin.catalogRevision} · run {origin.runId ?? "none"} · t {origin.sourceTimestampMs}</small
                >
              {/if}
            </li>
          {/each}
        </ul>
      </div>
      {#if rows.length > PAGE_SIZE}
        <nav aria-label="読取状態のページ">
          <button
            type="button"
            disabled={currentPage === 0}
            onclick={() => (page = currentPage - 1)}>前へ</button
          >
          <span>{currentPage + 1} / {lastPage + 1} ページ</span>
          <button
            type="button"
            disabled={currentPage === lastPage}
            onclick={() => (page = currentPage + 1)}>次へ</button
          >
        </nav>
      {/if}
    {/if}
  </details>
{/if}

<style>
  details {
    border-bottom: 1px solid var(--banto-border);
    padding: 3px 0;
    margin-bottom: 4px;
    font-size: 12px;
    color: var(--banto-text);
    min-width: 0;
    flex-shrink: 0;
  }
  summary {
    cursor: pointer;
    padding: 3px 6px;
    line-height: 1.5;
  }
  summary span {
    margin-left: 8px;
    color: var(--banto-text-muted);
  }
  .description {
    color: var(--banto-text-muted);
    padding: 4px 8px;
  }
  .rows {
    max-height: 180px;
    overflow: auto;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0 8px;
  }
  li {
    padding: 7px 0;
    border-top: 1px solid var(--banto-border);
    overflow-wrap: anywhere;
    line-height: 1.5;
  }
  .identity,
  small,
  .value span {
    color: var(--banto-text-muted);
  }
  strong {
    font-weight: 500;
  }
  .value {
    font-weight: 600;
  }
  small {
    font-size: 11px;
  }
  nav {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    padding: 4px 8px;
  }
  button {
    font: inherit;
    color: inherit;
    background: var(--banto-surface);
    border: 1px solid var(--banto-border);
    border-radius: 3px;
    padding: 3px 7px;
  }
  button:disabled {
    opacity: 0.5;
  }
  summary:focus-visible,
  button:focus-visible,
  .rows:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
  .compact .description {
    display: none;
  }
  .compact .rows {
    max-height: 72px;
  }
  .compact {
    margin-bottom: 0;
  }
</style>
