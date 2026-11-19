<script lang="ts">
  import type { Project } from "../project";
  import { downloadBlob } from "../download";
  import {
    writeTagCsv,
    writeTagCsvFileName,
    writeTagList,
    writeTagText,
  } from "../write-tags";
  /**
   * The external names this Project may write (operation design §7), for the
   * Hub administrator who scopes the terminal's write key. Saved bindings only.
   */
  let { project }: { project: Project } = $props();
  const list = $derived(writeTagList(project));
  let message = $state("");
  let error = $state("");
  async function copy() {
    message = "";
    error = "";
    try {
      await navigator.clipboard.writeText(writeTagText(list));
      message = `${list.rows.length}件の外部名をコピーしました（1行に1件）。`;
    } catch {
      error =
        "コピーできませんでした。CSV を書き出すか、表から選んでコピーしてください。";
    }
  }
  function exportCsv() {
    message = "";
    error = "";
    downloadBlob(
      new Blob([writeTagCsv(list)], { type: "text/csv;charset=utf-8" }),
      writeTagCsvFileName(project.manifest.name),
    );
    message = `書込みタグの一覧を CSV に書き出しました（${list.rows.length}件）。`;
  }
</script>

<section class="write-tags" aria-label="書込みタグの一覧">
  <p>
    操作を定義した slot（機器種別の「操作」）に割り付けた外部名です。Hub
    の管理者は、端末の書き用キーの対象をこの一覧に合わせます。対象の外のタグは
    Hub が断ります。保存済みの割付から作ります。
  </p>
  <div class="actions">
    <button type="button" disabled={!list.rows.length} onclick={copy}
      >外部名をコピー</button
    >
    <button type="button" disabled={!list.rows.length} onclick={exportCsv}
      >CSV を書き出す</button
    >
    <span aria-live="polite">書込みタグ {list.rows.length}件</span>
  </div>
  {#if message}<p aria-live="polite">{message}</p>{/if}
  {#if error}<p role="alert" class="error">{error}</p>{/if}
  {#if list.unassigned.length}
    <p class="warn">
      操作を定義した slot のうち、外部名が未割付の{list.unassigned
        .length}件は書けないので一覧に入りません（{list.unassigned
        .slice(0, 5)
        .map((use) => `${use.equipmentCode} / ${use.slotName}`)
        .join("、")}{list.unassigned.length > 5 ? " ほか" : ""}）。
    </p>
  {/if}
  {#if list.rows.length}
    <div class="scroll">
      <table aria-label="書込みタグ">
        <thead
          ><tr
            ><th scope="col">外部名</th><th scope="col">機器番号</th><th
              scope="col">機器名</th
            ><th scope="col">slot</th><th scope="col">操作の見出し</th></tr
          ></thead
        >
        <tbody>
          {#each list.rows as row (row.externalName)}
            {#each row.uses as use, index (index)}
              <tr
                >{#if index === 0}<td rowspan={row.uses.length}
                    >{row.externalName}</td
                  >{/if}<td>{use.equipmentCode}</td><td>{use.equipmentName}</td
                ><td>{use.slotName}</td><td>{use.label}</td></tr
              >
            {/each}
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <p>書込みタグはありません。</p>
  {/if}
</section>

<style>
  /* Same look as the binding table dialog it sits in. */
  .write-tags {
    display: grid;
    gap: 6px;
    padding: 8px 0;
    border-top: 1px solid var(--banto-border);
    border-bottom: 1px solid var(--banto-border);
  }
  p {
    margin: 0;
    font-size: 12px;
    font-weight: normal;
    color: var(--banto-text-muted);
    overflow-wrap: anywhere;
  }
  .actions {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
    font-size: 12px;
  }
  button {
    font: inherit;
    font-size: 12px;
    color: var(--banto-text);
    background: var(--banto-surface);
    border: 1px solid var(--banto-border);
    border-radius: 4px;
    padding: 6px 12px;
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
  .scroll {
    max-height: 240px;
    overflow: auto;
  }
  table {
    border-collapse: collapse;
    font-size: 12px;
    width: 100%;
  }
  th,
  td {
    border-bottom: 1px solid var(--banto-border);
    padding: 4px 6px;
    text-align: left;
    vertical-align: top;
    white-space: nowrap;
  }
  .warn {
    color: var(--banto-warning);
  }
  .error {
    color: var(--banto-danger);
  }
</style>
