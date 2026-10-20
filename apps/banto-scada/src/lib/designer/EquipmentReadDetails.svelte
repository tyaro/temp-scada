<script lang="ts">
  import type { EquipmentContext } from "../symbol-slots";
  import { equipmentReadDetails } from "../equipment-read-details";
  let {
    equipmentId,
    equipmentContext,
  }: { equipmentId: string; equipmentContext: EquipmentContext } = $props();
  const details = $derived(equipmentReadDetails(equipmentId, equipmentContext));
  let page = $state(0);
  const PAGE_SIZE = 20;
  const lastPage = $derived(
    Math.max(0, Math.ceil((details?.rows.length ?? 0) / PAGE_SIZE) - 1),
  );
  const currentPage = $derived(Math.min(page, lastPage));
  $effect(() => {
    equipmentId;
    page = 0;
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
  nav {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 8px;
  }
</style>
