<script lang="ts">
  import { Modal } from "@banto/ui";
  import { SvelteMap } from "svelte/reactivity";
  import type { Project } from "../project";
  import { sampleSelection, type CatalogSelection } from "../catalog-session";
  import {
    bindingCell,
    bindingTableChanges,
    cellKey,
    cellMatch,
    cellProblem,
    cellText,
    catalogIndex,
    draftCell,
    isGridPaste,
    parsePasteGrid,
    pasteIntoTable,
    prefixFill,
    PREFIX_COLUMN,
    type BindingCell,
    type BindingDraft,
    type BindingTableChange,
  } from "../equipment-binding-table";
  import { downloadBlob } from "../download";
  import {
    hubTagCsv,
    hubTagCsvFileName,
    type HubTagCsvSkip,
  } from "../hub-tag-csv";
  import {
    decodeIoCsv,
    guessIoCsvColumns,
    importIoCsv,
    MAX_IO_CSV_BYTES,
    parseIoCsv,
    type IoCsvColumns,
    type IoCsvSkip,
  } from "../equipment-io-csv";
  let {
    open,
    project,
    catalogSelection,
    onapply,
    onclose,
    dirty = $bindable(false),
  }: {
    /** Kept mounted and toggled so the overlay returns focus to its opener. */
    open: boolean;
    project: Project;
    catalogSelection: CatalogSelection;
    /** Returns an error message, or null when the edit was applied. */
    onapply: (changes: BindingTableChange[]) => string | null;
    onclose: () => void;
    /** Unapplied cells; the App adds this to its page-unload protection. */
    dirty?: boolean;
  } = $props();
  const types = $derived(
    (project.equipmentTypes ?? []).filter((type) =>
      project.equipment?.some((item) => item.typeId === type.id),
    ),
  );
  let typeId = $state("");
  const kind = $derived(
    types.find((type) => type.id === typeId) ?? types[0] ?? null,
  );
  const rows = $derived(
    (project.equipment ?? []).filter((item) => item.typeId === kind?.id),
  );
  const drafts = new SvelteMap<string, BindingDraft>();
  /** Per-equipment prefix for the fill; only an input of this table, never saved. */
  const prefixes = new SvelteMap<string, string>();
  let step = $state<"edit" | "review" | "discard">("edit");
  let message = $state("");
  let error = $state("");
  const changes = $derived(bindingTableChanges(project, drafts));
  $effect.pre(() => {
    dirty = changes.length > 0;
  });
  const checking = $derived(
    catalogSelection.available && catalogSelection.isCurrent(),
  );
  const index = $derived(catalogIndex(catalogSelection.catalog));
  function text(equipmentId: string, slotName: string, saved: BindingCell) {
    return drafts.get(cellKey(equipmentId, slotName))?.text ?? cellText(saved);
  }
  const cells = $derived(
    rows.flatMap((item) =>
      (kind?.slots ?? []).map((slot) => {
        const saved = bindingCell(item, slot.name),
          value = text(item.id, slot.name, saved);
        return {
          key: cellKey(item.id, slot.name),
          value,
          problem: cellProblem(value),
          match: checking ? cellMatch(value, slot.type, index) : null,
        };
      }),
    ),
  );
  const cellByKey = $derived(new Map(cells.map((cell) => [cell.key, cell])));
  const changedKeys = $derived(
    new Set(changes.map((row) => cellKey(row.equipmentId, row.slotName))),
  );
  const problems = $derived(
    [...drafts.values()].filter((draft) => cellProblem(draft.text)).length,
  );
  const missing = $derived(
    cells.filter((cell) => cell.match === "missing").length,
  );
  const incompatible = $derived(
    cells.filter((cell) => cell.match === "incompatible").length,
  );
  const reviewMissing = $derived(
    checking
      ? changes.filter((change) => {
          const item = project.equipment?.find(
            (row) => row.id === change.equipmentId,
          );
          const slot = project.equipmentTypes
            ?.find((type) => type.id === item?.typeId)
            ?.slots.find((row) => row.name === change.slotName);
          return (
            !!slot &&
            !!change.after?.externalName &&
            cellMatch(change.after.externalName, slot.type, index) !== "found"
          );
        }).length
      : 0,
  );
  function label(cell: BindingCell) {
    return cell === null ? "未採用" : (cell.externalName ?? "未割付");
  }
  function equipmentOf(id: string) {
    return project.equipment?.find((item) => item.id === id);
  }
  function setCell(key: string, value: string, saved: BindingCell) {
    drafts.set(key, draftCell(drafts, key, saved, value));
    message = "";
    error = "";
  }
  /** `column` 0 is the prefix column; slot columns follow it. */
  function paste(event: ClipboardEvent, row: number, column: number) {
    const data = event.clipboardData?.getData("text/plain") ?? "";
    if (!isGridPaste(data) || !kind) return;
    event.preventDefault();
    const { cells: pasted, dropped } = pasteIntoTable(
      parsePasteGrid(data),
      rows.map((item) => item.id),
      [PREFIX_COLUMN, ...kind.slots.map((slot) => slot.name)],
      row,
      column,
    );
    const saved = new Map(
      rows.flatMap((item) =>
        kind.slots.map((slot) => [
          cellKey(item.id, slot.name),
          bindingCell(item, slot.name),
        ]),
      ),
    );
    for (const [key, value] of pasted) {
      const [equipmentId, column] = key.split("\u0000");
      if (column === PREFIX_COLUMN) prefixes.set(equipmentId, value);
      else
        drafts.set(key, draftCell(drafts, key, saved.get(key) ?? null, value));
    }
    error = "";
    message = `${pasted.size}セルを貼り付けました。${
      dropped ? `表の外の${dropped}セルは入れていません。` : ""
    }`;
  }
  function fill() {
    if (!kind) return;
    error = "";
    if (!kind.slots.some((slot) => slot.tagSuffix !== undefined)) {
      message =
        "タグ名の末尾を持つslotがありません。機器種別の編集でslotに末尾を設定してください。";
      return;
    }
    const result = prefixFill(
      kind.slots,
      rows.map((item) => item.id),
      prefixes,
      checking ? index : null,
    );
    if (!result.cells.size) {
      message = "接頭辞が入っている行がありません。";
      return;
    }
    const saved = new Map(
      rows.flatMap((item) =>
        kind.slots.map((slot) => [
          cellKey(item.id, slot.name),
          bindingCell(item, slot.name),
        ]),
      ),
    );
    // A blanked cell is a missing name of an allowUnassigned slot: adopt it unassigned.
    for (const [key, value] of result.cells)
      drafts.set(
        key,
        draftCell(drafts, key, saved.get(key) ?? null, value, value === ""),
      );
    message = `${result.filled}件を入れました。${
      result.blanked
        ? `未割付を許すslotで見つからない${result.blanked}件は空欄にしました。`
        : ""
    }`;
  }
  /** Names left out of the last Hub CSV because they cannot be split. */
  let skipped = $state<HubTagCsvSkip[]>([]);
  /** Exports saved bindings only, so unapplied cells must be applied first. */
  function exportHubCsv() {
    error = "";
    if (changes.length) {
      skipped = [];
      message = "";
      error = `未適用の変更が${changes.length}件あります。Hub 登録用 CSV は保存済みの割付から作るため、先に適用するか変更を取り消してください。`;
      return;
    }
    // Sample candidates are not the Hub's tag list: leave nothing out by them.
    const hubChecked = checking && catalogSelection !== sampleSelection;
    const result = hubTagCsv(project, hubChecked ? index : null);
    skipped = result.invalid;
    ioSkipped = [];
    const notes = [
      result.checked
        ? `Hub のタグ一覧に既にある${result.registered}件を除きました。`
        : checking
          ? "サンプル候補は Hub のタグ一覧ではないため照合せず、割付済みの名前をすべて入れました。"
          : "タグ一覧を使えないため照合せず、割付済みの名前をすべて入れました。",
      result.invalid.length
        ? `接続.グループ.タグに分けられない${result.invalid.length}件を除きました（下の一覧）。`
        : "",
    ].join("");
    if (!result.rows) {
      message = `書き出す名前がありません。${notes}`;
      return;
    }
    downloadBlob(
      new Blob([result.csv], { type: "text/csv;charset=utf-8" }),
      hubTagCsvFileName(project.manifest.name),
    );
    const fill = result.untyped
      ? `address 列と、dataType 列が空の${result.untyped}件（数値など）は dataType 列も埋めてから`
      : "address 列を埋めてから";
    message = `Hub 登録用 CSV に${result.rows}件を書き出しました。${notes}${fill} Hub で取り込んでください。`;
  }
  let ioInput = $state<HTMLInputElement>();
  /** A read vendor I/O list waiting for its columns to be chosen. */
  let ioCsv = $state<{
    fileName: string;
    encoding: string;
    header: string[];
    records: { line: number; fields: string[] }[];
    columns: Partial<IoCsvColumns>;
  } | null>(null);
  /** Rows of the last imported I/O list that were not put into the table. */
  let ioSkipped = $state<IoCsvSkip[]>([]);
  const ioReady = $derived(
    !!ioCsv &&
      ioCsv.columns.code !== undefined &&
      ioCsv.columns.slot !== undefined &&
      ioCsv.columns.tag !== undefined &&
      new Set([ioCsv.columns.code, ioCsv.columns.slot, ioCsv.columns.tag])
        .size === 3,
  );
  function headerLabel(name: string, i: number) {
    return name.trim() ? name : `${i + 1}列目`;
  }
  async function readIoCsv(file: File) {
    error = "";
    message = "";
    ioCsv = null;
    if (file.size > MAX_IO_CSV_BYTES) {
      error = `CSV が大きすぎます（${MAX_IO_CSV_BYTES / 1024 / 1024}MB まで）。`;
      return;
    }
    try {
      const { text, encoding } = decodeIoCsv(
        new Uint8Array(await file.arrayBuffer()),
      );
      const [header, ...records] = parseIoCsv(text);
      if (!header || !records.length) {
        error =
          "CSV に見出し行とデータ行がありません。1行目を見出しにしてください。";
        return;
      }
      ioCsv = {
        fileName: file.name,
        encoding,
        header: header.fields,
        records,
        columns: guessIoCsvColumns(header.fields),
      };
    } catch (cause) {
      error = `CSV を読めません: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }
  function importIo() {
    if (!ioCsv || !ioReady) return;
    const result = importIoCsv(
      project,
      ioCsv.records,
      ioCsv.columns as IoCsvColumns,
    );
    for (const [key, cell] of result.cells)
      drafts.set(key, draftCell(drafts, key, cell.saved, cell.text));
    ioSkipped = result.skipped;
    skipped = [];
    const others = [...result.typeIds].filter((id) => id !== kind?.id).length;
    message = `CSV の${result.cells.size}件を入れました。${
      others
        ? `ほかの機器種別${others}種にも入れています（差分の確認で見えます）。`
        : ""
    }${
      result.skipped.length
        ? `取り込まなかった${result.skipped.length}行は下の一覧です。`
        : ""
    }`;
    ioCsv = null;
  }
  function close() {
    drafts.clear();
    prefixes.clear();
    skipped = [];
    ioCsv = null;
    ioSkipped = [];
    step = "edit";
    message = "";
    error = "";
    onclose();
  }
  function apply() {
    const result = onapply(changes);
    if (result === null) close();
    else error = result;
  }
  function requestClose() {
    if (!changes.length) return true;
    step = "discard";
    return false;
  }
</script>

<Modal
  {open}
  title="割付の一覧表"
  width="1100px"
  dirty={changes.length > 0}
  onRequestClose={requestClose}
  onBlockedClose={() => (step = "discard")}
  onclose={close}
>
  {#if step === "discard"}
    <p role="alert">
      未適用の変更が{changes.length}件あります。破棄して閉じますか。
    </p>
    <div class="actions">
      <button type="button" onclick={() => (step = "edit")}>表へ戻る</button>
      <button type="button" class="danger" onclick={close}
        >破棄して閉じる</button
      >
    </div>
  {:else if step === "review"}
    <p>
      次の{changes.length}件の割付を変更します。適用すると1回の編集として元に戻せます。
    </p>
    {#if reviewMissing}<p class="warn">
        タグ一覧にない名前・型が合わない名前が{reviewMissing}件あります。このまま適用することもできます。
      </p>{/if}
    <div class="scroll">
      <table aria-label="割付の変更点">
        <thead
          ><tr
            ><th scope="col">機器番号</th><th scope="col">機器名</th><th
              scope="col">slot</th
            ><th scope="col">変更前</th><th scope="col">変更後</th></tr
          ></thead
        >
        <tbody>
          {#each changes as change (cellKey(change.equipmentId, change.slotName))}
            {@const item = equipmentOf(change.equipmentId)}
            <tr
              ><td>{item?.code}</td><td>{item?.name}</td><td
                >{change.slotName}</td
              ><td>{label(change.before)}</td><td>{label(change.after)}</td></tr
            >
          {/each}
        </tbody>
      </table>
    </div>
    {#if error}<p role="alert" class="error">{error}</p>{/if}
    <div class="actions">
      <button type="button" onclick={() => (step = "edit")}>表へ戻る</button>
      <button type="button" class="primary" onclick={apply}
        >{changes.length}件を適用</button
      >
    </div>
  {:else}
    <p>
      行が機器、列がslotです。表計算ソフトの範囲（タブ区切り）を貼り付けると、選んだセルから右下へ入ります。1行1信号のI/O一覧はCSVで取り込めます。空にしたセルは採用・未割付になります。未採用への切替は機器ごとの割付で行います。
    </p>
    <p>
      接頭辞は保存しません。「接頭辞から入れる」で、接頭辞のある行の「タグ名の末尾」を持つslotに「接頭辞＋末尾」を入れます（区切り文字は接頭辞に含めます）。
    </p>
    {#if !types.length}
      <p>機器が登録されていません。</p>
    {:else}
      <div class="toolbar">
        <label class="kind"
          ><span>機器種別</span><select
            class="banto-field-control"
            value={kind?.id}
            onchange={(event) => {
              typeId = event.currentTarget.value;
              message = "";
            }}
            >{#each types as type (type.id)}<option value={type.id}
                >{type.name}</option
              >{/each}</select
          ></label
        >
        <button type="button" onclick={fill}>接頭辞から入れる</button>
        <button type="button" onclick={() => ioInput?.click()}
          >I/O 一覧の CSV を取り込む</button
        >
        <input
          bind:this={ioInput}
          class="file"
          type="file"
          accept=".csv,text/csv"
          aria-label="I/O 一覧の CSV"
          onchange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void readIoCsv(file);
          }}
        />
        <button type="button" onclick={exportHubCsv}
          >Hub 登録用 CSV を書き出す</button
        >
        <p aria-live="polite">
          変更 {changes.length}件{checking
            ? ` · 未解決 ${missing}件 · 型が合わない ${incompatible}件`
            : ""}{problems ? ` · 入力の問題 ${problems}件` : ""}
        </p>
      </div>
      <p>
        {checking
          ? `タグ一覧と照合しています。${catalogSelection.notice}`
          : "タグ一覧を使えないため、照合していません。"}
      </p>
      {#if message}<p aria-live="polite">{message}</p>{/if}
      {#if error}<p role="alert" class="error">{error}</p>{/if}
      {#if ioCsv}
        <section class="io" aria-label="I/O 一覧の列">
          <p>
            {ioCsv.fileName}（{ioCsv.encoding}、{ioCsv.records
              .length}行）。1行が1信号です。機器番号・slot・タグ名の列を選んでください。ほかの列は使いません。機器番号とslotは前後の空白を除いて照合し、タグ名はそのまま入れます。既にある値は上書きします。
          </p>
          <div class="io-columns">
            {#each [["code", "機器番号の列"], ["slot", "slotの列"], ["tag", "タグ名の列"]] as const as [role, name] (role)}
              <label class="kind"
                ><span>{name}</span><select
                  class="banto-field-control"
                  value={ioCsv.columns[role] ?? ""}
                  onchange={(event) => {
                    if (!ioCsv) return;
                    const value = event.currentTarget.value;
                    ioCsv.columns = {
                      ...ioCsv.columns,
                      [role]: value === "" ? undefined : Number(value),
                    };
                  }}
                  ><option value="">選んでください</option
                  >{#each ioCsv.header as column, i (i)}<option value={i}
                      >{headerLabel(column, i)}</option
                    >{/each}</select
                ></label
              >
            {/each}
          </div>
          {#if !ioReady}<p class="warn">
              3つの列を、それぞれ別の列で選んでください。
            </p>{/if}
          <div class="actions">
            <button type="button" onclick={() => (ioCsv = null)}>やめる</button>
            <button
              type="button"
              class="primary"
              disabled={!ioReady}
              onclick={importIo}>表へ入れる</button
            >
          </div>
        </section>
      {/if}
      {#if ioSkipped.length}
        <div class="scroll skipped">
          <table aria-label="取り込まなかった行">
            <thead
              ><tr
                ><th scope="col">行</th><th scope="col">機器番号</th><th
                  scope="col">slot</th
                ><th scope="col">タグ名</th><th scope="col">理由</th></tr
              ></thead
            >
            <tbody>
              {#each ioSkipped as row, i (i)}
                <tr
                  ><td>{row.line}</td><td>{row.code}</td><td>{row.slot}</td><td
                    >{row.tag}</td
                  ><td>{row.reason}</td></tr
                >
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
      {#if skipped.length}
        <div class="scroll skipped">
          <table aria-label="書き出さなかった名前">
            <thead
              ><tr
                ><th scope="col">機器番号</th><th scope="col">slot</th><th
                  scope="col">外部名</th
                ><th scope="col">理由</th></tr
              ></thead
            >
            <tbody>
              {#each skipped as row, i (i)}
                <tr
                  ><td>{row.equipmentCode}</td><td>{row.slotName}</td><td
                    >{row.externalName}</td
                  ><td>{row.reason}</td></tr
                >
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
      <div class="scroll">
        <table aria-label={`${kind?.name}の割付`}>
          <thead>
            <tr>
              <th scope="col">機器番号</th>
              <th scope="col">機器名</th>
              <th scope="col">接頭辞<small>保存しない</small></th>
              {#each kind?.slots ?? [] as slot (slot.name)}
                <th scope="col">{slot.name}<small>{slot.type}</small></th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each rows as item, r (item.id)}
              <tr>
                <th scope="row">{item.code}</th>
                <td>{item.name}</td>
                <td>
                  <input
                    aria-label={`${item.code}の接頭辞`}
                    maxlength="1024"
                    value={prefixes.get(item.id) ?? ""}
                    oninput={(event) => {
                      prefixes.set(item.id, event.currentTarget.value);
                      message = "";
                    }}
                    onpaste={(event) => paste(event, r, 0)}
                  />
                </td>
                {#each kind?.slots ?? [] as slot, c (slot.name)}
                  {@const key = cellKey(item.id, slot.name)}
                  {@const cell = cellByKey.get(key)}
                  {@const saved = bindingCell(item, slot.name)}
                  <td class:changed={changedKeys.has(key)}>
                    <input
                      aria-label={`${item.code}の${slot.name}`}
                      aria-invalid={cell?.problem ? "true" : undefined}
                      maxlength="1024"
                      placeholder={saved === null && !drafts.get(key)?.unassign
                        ? "未採用"
                        : "未割付"}
                      value={cell?.value ?? ""}
                      oninput={(event) =>
                        setCell(key, event.currentTarget.value, saved)}
                      onpaste={(event) => paste(event, r, c + 1)}
                    />
                    {#if cell?.problem}<small class="error"
                        >{cell.problem}</small
                      >{:else if cell?.match === "missing"}<small class="warn"
                        >未解決</small
                      >{:else if cell?.match === "incompatible"}<small
                        class="warn">型が合わない・無効</small
                      >{/if}
                  </td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
    <div class="actions">
      <button
        type="button"
        disabled={!changes.length}
        onclick={() => {
          drafts.clear();
          message = "";
        }}>変更を取り消す</button
      >
      <button
        type="button"
        class="primary"
        disabled={!changes.length || problems > 0}
        onclick={() => {
          error = "";
          step = "review";
        }}>差分を確認（{changes.length}件）</button
      >
    </div>
  {/if}
</Modal>

<style>
  p {
    margin: 0 0 8px;
    font-size: 12px;
    color: var(--banto-text-muted);
    overflow-wrap: anywhere;
  }
  .toolbar {
    display: flex;
    gap: 12px;
    align-items: center;
    flex-wrap: wrap;
    margin-bottom: 8px;
  }
  .kind {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 12px;
    white-space: nowrap;
  }
  .toolbar p {
    margin: 0;
  }
  .scroll {
    max-height: 55vh;
    overflow: auto;
    border: 1px solid var(--banto-border);
    border-radius: 4px;
  }
  .file {
    display: none;
  }
  .io {
    border: 1px solid var(--banto-border);
    border-radius: 4px;
    padding: 8px;
    margin-bottom: 8px;
  }
  .io-columns {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
  }
  .io .actions {
    margin-top: 8px;
  }
  .skipped {
    max-height: 20vh;
    margin-bottom: 8px;
  }
  table {
    border-collapse: collapse;
    font-size: 12px;
    width: max-content;
    min-width: 100%;
  }
  th,
  td {
    border-bottom: 1px solid var(--banto-border);
    padding: 4px 6px;
    text-align: left;
    vertical-align: top;
    white-space: nowrap;
  }
  thead th {
    position: sticky;
    top: 0;
    background: var(--banto-surface);
    z-index: 1;
  }
  th small {
    display: block;
    font-weight: normal;
    color: var(--banto-text-muted);
  }
  td small {
    display: block;
    font-size: 11px;
  }
  td.changed {
    background: var(--banto-primary-tint);
    box-shadow: inset 3px 0 var(--banto-primary);
  }
  input {
    width: 220px;
    box-sizing: border-box;
    font: inherit;
    color: var(--banto-text);
    background: var(--banto-bg);
    border: 1px solid var(--banto-border);
    border-radius: 4px;
    padding: 4px 6px;
  }
  input[aria-invalid="true"] {
    border-color: var(--banto-danger);
  }
  input:focus-visible,
  button:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
  .warn {
    color: var(--banto-warning);
  }
  .error {
    color: var(--banto-danger);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 12px;
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
  button.primary {
    background: var(--banto-primary-solid);
    border-color: var(--banto-primary-solid);
    color: var(--banto-on-solid);
  }
  button.danger {
    color: var(--banto-danger);
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
