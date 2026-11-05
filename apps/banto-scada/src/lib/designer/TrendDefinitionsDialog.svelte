<script lang="ts">
  import { Modal } from "@banto/ui";
  import { untrack } from "svelte";
  import type { Project } from "../project";
  import { newId } from "../editor";
  import {
    validateTrendDefinitions,
    type TrendDefinition,
  } from "../trend-definitions";
  type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
  let {
    project,
    initialId,
    error = "",
    onsave,
    onremove,
    onclose,
  }: {
    project: Project;
    initialId?: string;
    error?: string;
    onsave: (
      definition: TrendDefinition,
      create: boolean,
      place: boolean,
    ) => void;
    onremove: (id: string) => void;
    onclose: () => void;
  } = $props();
  const fresh = (): Mutable<TrendDefinition> => ({
    id: newId(),
    name: "",
    historianNamespace: "",
    pens: [{ id: newId(), seriesId: "", color: "#008f76" }],
    windowMs: 3600000,
    mode: "raw",
    maxPointsPerSeries: 100,
  });
  const owner = untrack(() => ({ project, initialId }));
  let selected = $state(owner.initialId ?? "");
  const initial = owner.project.trends?.find(
    (row) => row.id === owner.initialId,
  );
  let draft = $state<Mutable<TrendDefinition>>(
    initial ? JSON.parse(JSON.stringify(initial)) : fresh(),
  );
  let baseline = $state(untrack(() => JSON.stringify(draft)));
  let localError = $state("");
  const dirty = $derived(JSON.stringify(draft) !== baseline);
  const data = $derived(JSON.parse(JSON.stringify(draft)) as TrendDefinition);
  const definitions = $derived(
    selected
      ? (project.trends ?? []).map((row) => (row.id === selected ? data : row))
      : [...(project.trends ?? []), data],
  );
  const valid = $derived(
    validateTrendDefinitions({
      version: 1,
      kind: "trendDefinitions",
      definitions,
    }),
  );
  const uses = $derived(
    project.screens.reduce(
      (sum, screen) =>
        sum +
        screen.objects.filter(
          (o) => o.shape.type === "trend" && o.shape.trendId === selected,
        ).length,
      0,
    ),
  );
  function choose(id: string) {
    const row = project.trends?.find((row) => row.id === id);
    selected = id;
    draft = row ? JSON.parse(JSON.stringify(row)) : fresh();
    baseline = JSON.stringify(draft);
    localError = "";
  }
  function move(index: number, delta: number) {
    const pens = [...draft.pens];
    const to = index + delta;
    if (to < 0 || to >= pens.length) return;
    [pens[index], pens[to]] = [pens[to], pens[index]];
    draft.pens = pens;
  }
</script>

<Modal
  open
  title="トレンド定義・配置"
  width="900px"
  {dirty}
  onBlockedClose={() =>
    (localError =
      "未保存の入力があります。保存するか「閉じる」で破棄してください。")}
  {onclose}
>
  <p>
    履歴の表示条件を保存します。配置は静的なカードで、履歴表示は準備中です。記録設定は変更しません。
  </p>
  <label class="banto-field banto-field--stacked"
    ><span class="banto-field-label">編集するトレンド </span><select
      class="banto-field-control"
      aria-label="編集するトレンド"
      value={selected}
      disabled={dirty}
      onchange={(event) => choose(event.currentTarget.value)}
    >
      <option value="">新しい定義</option>
      {#each project.trends ?? [] as row}<option value={row.id}
          >{row.name} · {row.id}</option
        >{/each}
    </select></label
  >
  <form
    onsubmit={(event) => {
      event.preventDefault();
      if (valid) onsave(data, !selected, false);
    }}
  >
    <div class="fields">
      <label class="banto-field banto-field--stacked"
        ><span class="banto-field-label">トレンド名 </span><input
          class="banto-field-control"
          bind:value={draft.name}
          maxlength="1024"
        /></label
      >
      <label class="banto-field banto-field--stacked"
        ><span class="banto-field-label"
          >履歴データ集合ID（namespace）
        </span><input
          class="banto-field-control"
          bind:value={draft.historianNamespace}
          maxlength="64"
          spellcheck="false"
        /></label
      >
      <label class="banto-field banto-field--stacked"
        ><span class="banto-field-label">表示期間（ミリ秒） </span><input
          class="banto-field-control"
          type="number"
          min="1"
          max="3600000"
          step="1"
          bind:value={draft.windowMs}
        /></label
      >
      <label class="banto-field banto-field--stacked"
        ><span class="banto-field-label">取得モード </span><select
          class="banto-field-control"
          bind:value={draft.mode}
          ><option value="raw">raw（観測点）</option><option value="minmax"
            >minmax（最小・最大）</option
          ></select
        ></label
      >
      <label class="banto-field banto-field--stacked"
        ><span class="banto-field-label">系列ごとの点数上限 </span><input
          class="banto-field-control"
          type="number"
          min="1"
          max="2000"
          step="1"
          bind:value={draft.maxPointsPerSeries}
        /></label
      >
    </div>
    <p>
      割当済みのデータ集合ID・系列IDを入力してください。保存後の接続確認は後続工程です。期間は1時間以内、各系列2000点・合計8000点までです。
    </p>
    <div class="pens" role="group" aria-label="トレンドのペン">
      {#each draft.pens as pen, index (pen.id)}
        <fieldset>
          <legend>ペン {index + 1}</legend>
          <div class="fields">
            <label class="banto-field banto-field--stacked"
              ><span class="banto-field-label">系列ID {index + 1}</span><input
                class="banto-field-control"
                bind:value={pen.seriesId}
                maxlength="64"
                spellcheck="false"
              /></label
            >
            <label class="banto-field banto-field--stacked"
              ><span class="banto-field-label">凡例の別名 {index + 1}</span
              ><input
                class="banto-field-control"
                value={pen.label ?? ""}
                maxlength="1024"
                oninput={(event) => {
                  const value = event.currentTarget.value;
                  if (value) pen.label = value;
                  else delete pen.label;
                }}
              /></label
            >
            <label class="banto-field banto-field--stacked"
              ><span class="banto-field-label">ペン色 {index + 1}</span><input
                class="banto-field-control"
                bind:value={pen.color}
                maxlength="7"
                placeholder="#008f76"
                spellcheck="false"
              /></label
            >
          </div>
          <div class="actions">
            <button
              type="button"
              disabled={index === 0}
              onclick={() => move(index, -1)}>ペン{index + 1}を上へ</button
            >
            <button
              type="button"
              disabled={index === draft.pens.length - 1}
              onclick={() => move(index, 1)}>ペン{index + 1}を下へ</button
            >
            <button
              type="button"
              disabled={draft.pens.length === 1}
              onclick={() =>
                (draft.pens = draft.pens.filter((row) => row.id !== pen.id))}
              >ペン{index + 1}を削除</button
            >
          </div>
        </fieldset>
      {/each}
    </div>
    <button
      type="button"
      disabled={draft.pens.length >= 8}
      onclick={() =>
        (draft.pens = [
          ...draft.pens,
          { id: newId(), seriesId: "", color: "#008f76" },
        ])}>ペンを追加</button
    >
    {#if !valid}<p role="status">
        名前・ID・ペンの重複・色・期間・点数・定義全体の上限を確認してください。
      </p>{/if}
    {#if error || localError}<p role="alert">{error || localError}</p>{/if}
    <p>
      参照配置 {uses}件。未保存の入力は「入力を戻す」で取り消せます。「閉じる」は未保存の入力を破棄します。
    </p>
    <div class="actions">
      <button type="submit" disabled={!valid}>定義を保存</button>
      <button
        type="button"
        disabled={!valid}
        onclick={() => onsave(data, !selected, true)}>保存して配置</button
      >
      <button type="button" disabled={!dirty} onclick={() => choose(selected)}
        >入力を戻す</button
      >
      <button
        type="button"
        disabled={!selected || uses > 0 || dirty}
        onclick={() => onremove(selected)}>未使用定義を削除</button
      >
      <button type="button" onclick={onclose}>閉じる</button>
    </div>
  </form>
</Modal>

<style>
  p {
    font-size: 0.85rem;
    color: var(--banto-text-muted);
    margin: 0.75rem 0;
  }
  label {
    display: grid;
    gap: 0.3rem;
  }
  input,
  select {
    min-width: 0;
    width: 100%;
    color: var(--banto-text);
    background: var(--banto-surface);
    border: 1px solid var(--banto-border);
    padding: 0.4rem;
    border-radius: 4px;
  }
  .fields {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.75rem;
    margin: 0.75rem 0;
  }
  fieldset {
    border: 1px solid var(--banto-border);
    border-radius: 4px;
    margin: 0.75rem 0;
    padding: 0.75rem;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 0.5rem 0;
  }
  @media (max-width: 600px) {
    .fields {
      grid-template-columns: 1fr;
    }
  }
</style>
