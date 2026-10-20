<script lang="ts">
  import { tick } from "svelte";
  import type { Project } from "../project";
  import { symbolEquipmentCheck } from "../symbol-equipment-check";
  let {
    project,
    symbolId,
    equipmentId,
    targetKey,
  }: {
    project: Project;
    symbolId: string;
    equipmentId: string;
    targetKey: string;
  } = $props();
  let candidate = $state({ symbolId: "", equipmentId: "" });
  let section = $state<HTMLElement>();
  let page = $state(0);
  const PAGE_SIZE = 20;
  const check = $derived(
    symbolEquipmentCheck(project, candidate.symbolId, candidate.equipmentId),
  );
  const lastPage = $derived(
    Math.max(0, Math.ceil(check.rows.length / PAGE_SIZE) - 1),
  );
  const currentPage = $derived(Math.min(page, lastPage));
  function readCandidate() {
    const form = section?.closest("form");
    if (!form?.isConnected) return;
    const symbol = form.elements.namedItem("symbolId"),
      equipment = form.elements.namedItem("equipmentId");
    if (
      !(symbol instanceof HTMLSelectElement) ||
      !(equipment instanceof HTMLSelectElement)
    )
      return;
    if (
      candidate.symbolId !== symbol.value ||
      candidate.equipmentId !== equipment.value
    )
      page = 0;
    candidate = { symbolId: symbol.value, equipmentId: equipment.value };
  }
  function observe(element: HTMLElement) {
    const form = element.closest("form");
    form?.addEventListener("change", readCandidate);
    form?.addEventListener("reset", readCandidate);
    return {
      destroy() {
        form?.removeEventListener("change", readCandidate);
        form?.removeEventListener("reset", readCandidate);
      },
    };
  }
  $effect(() => {
    project;
    symbolId;
    equipmentId;
    const element = section,
      form = element?.closest("form"),
      key = targetKey;
    let active = true;
    // The draft guard writes model baselines before this read; dirty select values stay intact.
    void tick().then(() => {
      if (
        active &&
        targetKey === key &&
        section === element &&
        form?.isConnected &&
        element?.closest("form") === form
      )
        readCandidate();
    });
    return () => {
      active = false;
    };
  });
</script>

<section bind:this={section} use:observe aria-label="関連付け候補の確認">
  <details>
    <summary
      >関連付け候補の確認 · {check.definition
        ? `使用slot ${check.rows.length}件 · 未完備 ${check.incomplete}件`
        : "対象の定義なし"}</summary
    >
    <p>
      定義: {check.definition?.name ?? "定義なし"}<br />機器: {check.equipment
        ? `${check.equipment.code} · ${check.equipment.name}`
        : "関連付けなし"}
    </p>
    <p>
      選択中の未適用候補を確認します。保存設定のみの確認で、実catalog・単位・接続の正常性は未確認です。
    </p>
    {#if !check.definition}<p>対象のSymbol定義が見つかりません。</p>
    {:else if !check.rows.length}<p>
        この定義にslotを参照するTextはありません。
      </p>{/if}
    <ul>
      {#each check.rows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE) as row (row.name)}
        <li
          data-equipment-check-slot={row.name}
          data-equipment-check-state={row.state}
        >
          <strong>{row.name} · {row.type}</strong><span>{row.label}</span>
        </li>
      {/each}
    </ul>
    {#if check.rows.length > PAGE_SIZE}
      <nav aria-label="関連付け候補の確認ページ">
        <button
          type="button"
          disabled={currentPage === 0}
          onclick={() => (page = currentPage - 1)}>前の確認</button
        >
        <span>{currentPage + 1} / {lastPage + 1}</span>
        <button
          type="button"
          disabled={currentPage === lastPage}
          onclick={() => (page = currentPage + 1)}>次の確認</button
        >
      </nav>
    {/if}
    <p>
      未使用の宣言slot {check.unused}件。非表示Textも使用slotに含めます。候補の自動変更や保存の拒否は行いません。
    </p>
  </details>
</section>

<style>
  section {
    border-top: 1px solid var(--banto-border);
    margin-top: 12px;
    padding-top: 10px;
    font-size: 12px;
  }
  summary {
    cursor: pointer;
    font-weight: 600;
  }
  p {
    color: var(--banto-text-muted);
    line-height: 1.6;
    overflow-wrap: anywhere;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    display: grid;
    gap: 4px;
    padding: 7px 0;
    border-top: 1px solid var(--banto-border);
    overflow-wrap: anywhere;
  }
  nav {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  button {
    font: inherit;
    padding: 5px;
    border: 1px solid var(--banto-border);
    border-radius: 3px;
    background: var(--banto-surface);
    color: var(--banto-text);
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  button:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
</style>
