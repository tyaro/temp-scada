<script lang="ts">
  import type { EquipmentUsage } from "../equipment";
  import type { EquipmentContext } from "../symbol-slots";
  import { equipmentReadDetails } from "../equipment-read-details";
  let {
    equipmentId,
    equipmentContext,
    usages = [],
    onopenusage,
  }: {
    equipmentId: string;
    equipmentContext: EquipmentContext;
    usages?: readonly EquipmentUsage[];
    onopenusage?: (usage: EquipmentUsage) => void;
  } = $props();
  const details = $derived(equipmentReadDetails(equipmentId, equipmentContext));
  let page = $state(0);
  let usagePage = $state(0);
  const PAGE_SIZE = 20;
  const lastPage = $derived(
    Math.max(0, Math.ceil((details?.rows.length ?? 0) / PAGE_SIZE) - 1),
  );
  const currentPage = $derived(Math.min(page, lastPage));
  const lastUsagePage = $derived(
    Math.max(0, Math.ceil(usages.length / PAGE_SIZE) - 1),
  );
  const currentUsagePage = $derived(Math.min(usagePage, lastUsagePage));
  $effect(() => {
    equipmentId;
    page = 0;
    usagePage = 0;
  });
</script>

<section aria-label="機器の読取詳細" class="equipment-read-details">
  {#if details}
    <p class="identity">
      <strong>{details.equipment.code} · {details.equipment.name}</strong><br
      />{details.type.name}
    </p>
    <p class="summary">
      採用slot {details.rows.length}件 · 取得不能 {details.unavailable}件 · SIM {details.simulated}件
    </p>
    <p class="note">読取専用 · この小窓の対象機器は選択変更に追従しません。</p>
    {#if !details.rows.length}<p>採用した読取slotはありません。</p>{/if}
    <ul>
      {#each details.rows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE) as row (row.name)}
        <li
          data-equipment-slot={row.name}
          data-slot-state={row.display.state}
          data-slot-simulated={row.simulated}
        >
          <div><strong>{row.name}</strong> <small>{row.type}</small></div>
          <div class="external">{row.externalName ?? "未割付"}</div>
          <div class="value">
            {row.display.text}{#if row.display.state === "good"}
              · {row.display.label}{/if}{#if row.display.reason}
              · {row.display.reason}{/if}
          </div>
          {#if row.display.provenance}
            {@const origin = row.display.provenance}
            <small class="origin"
              >source {origin.valueSource} · mode {origin.collectionMode} · catalog
              {origin.catalogRevision} · run {origin.runId ?? "none"} · t {origin.sourceTimestampMs}</small
            >
          {/if}
        </li>
      {/each}
    </ul>
    {#if details.rows.length > PAGE_SIZE}
      <nav aria-label="機器の読取詳細のページ">
        <button
          disabled={currentPage === 0}
          onclick={() => (page = currentPage - 1)}>前へ</button
        ><span>{currentPage + 1} / {lastPage + 1} ページ</span><button
          disabled={currentPage === lastPage}
          onclick={() => (page = currentPage + 1)}>次へ</button
        >
      </nav>
    {/if}
    {#if onopenusage}
      <div class="usages" aria-label="機器の図面使用先">
        <h4>図面の使用先 {usages.length}件</h4>
        {#if !usages.length}<p>
            この機器を参照するSymbol配置はありません。
          </p>{/if}
        {#each usages.slice(currentUsagePage * PAGE_SIZE, (currentUsagePage + 1) * PAGE_SIZE) as usage (usage.objectId)}
          <button
            type="button"
            data-equipment-usage={usage.objectId}
            title="編集画面でこの配置を確認"
            onclick={() => onopenusage?.(usage)}
            >{usage.screenName} · {usage.name ?? "Symbol配置"} · #{usage.order}{usage.visible ===
            false
              ? "（非表示）"
              : ""}</button
          >
        {/each}
        {#if usages.length > PAGE_SIZE}
          <nav aria-label="機器の図面使用先のページ">
            <button
              disabled={currentUsagePage === 0}
              onclick={() => (usagePage = currentUsagePage - 1)}
              >前の使用先</button
            ><span>{currentUsagePage + 1} / {lastUsagePage + 1}</span><button
              disabled={currentUsagePage === lastUsagePage}
              onclick={() => (usagePage = currentUsagePage + 1)}
              >次の使用先</button
            >
          </nav>
        {/if}
        <p class="note">
          配置を開くと編集画面へ切り替わり、小窓は閉じます。非表示・ロックは変更しません。
        </p>
      </div>
    {/if}
  {:else}<p>対象の機器が見つかりません。</p>{/if}
</section>

<style>
  section {
    padding: 12px;
    font-size: 12px;
  }
  p {
    margin: 0 0 8px;
  }
  .identity {
    font-size: 14px;
  }
  .note,
  small,
  .external {
    color: var(--banto-text-muted);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    border-top: 1px solid var(--banto-border);
    padding: 10px 0;
    overflow-wrap: anywhere;
  }
  .value {
    margin-top: 4px;
    font-variant-numeric: tabular-nums;
  }
  .origin {
    display: block;
    margin-top: 4px;
  }
  .usages {
    display: grid;
    gap: 6px;
    margin-top: 12px;
    border-top: 1px solid var(--banto-border);
    padding-top: 10px;
  }
  .usages h4 {
    margin: 0;
  }
  .usages > button {
    width: 100%;
    padding: 6px;
    border: 1px solid var(--banto-border);
    border-radius: 4px;
    background: var(--banto-surface);
    color: var(--banto-text);
    text-align: left;
    cursor: pointer;
    overflow-wrap: anywhere;
  }
  .usages button:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
  nav {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 8px;
  }
</style>
