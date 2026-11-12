<script lang="ts">
  import { untrack } from "svelte";
  import {
    revisionText,
    type ExpectedRevisions,
  } from "../recording-management/expected";
  import { inspectedAtLabel } from "../recording-management/summary";
  // The expected revisions of a new change (UX review 2026-11-11 P1-7). They
  // are filled from the last recording management inspection of the same
  // target; the fields stay editable under "details". An edit stops the
  // filling until the dialog is opened for another target (the parent remounts
  // this component then).
  let {
    expected,
    applied = $bindable(),
    mapping = $bindable(),
    retention = $bindable(),
    disabled,
    unbound,
    error,
  }: {
    /** Already matched against the operations target. */
    expected?: ExpectedRevisions;
    applied: string;
    mapping: string;
    retention: string;
    disabled: boolean;
    /** The plan is disabled: no mapping and retention revisions. */
    unbound: boolean;
    error: boolean;
  } = $props();
  let edited = $state(false);
  $effect(() => {
    const next = expected;
    untrack(() => {
      if (!next || edited) return;
      applied = revisionText(next.applied);
      mapping = revisionText(next.mapping);
      retention = revisionText(next.retention);
    });
  });
  const filled = $derived(
    !!expected &&
      !edited &&
      applied === revisionText(expected.applied) &&
      mapping === revisionText(expected.mapping) &&
      retention === revisionText(expected.retention),
  );
  const shown = (text: string) => (text === "" ? "なし" : text);
  const edit = () => (edited = true);
</script>

<section aria-label="新しい変更の期待版">
  <h3>新しい変更の期待版</h3>
  {#if filled && expected}
    <p role="status" data-expected-source="inspection">
      記録管理状態の照会（{inspectedAtLabel(
        expected.inspectedAt,
      )}）の版を入れました: 適用版 {shown(applied)}{unbound
        ? ""
        : ` · mapping版 ${shown(mapping)} · 保持適用版 ${shown(retention)}`}
    </p>
  {:else if expected}
    <p data-expected-source="edited">
      照会結果の版から変更しています。空欄は「版なし」を意味します。
    </p>
  {:else}
    <p data-expected-source="manual">
      記録管理状態で照会すると、その版が自動で入ります。照会していない場合は下の欄に入力してください。空欄は「版なし」を意味します。
    </p>
  {/if}
  <details open={!expected || error}>
    <summary>期待版を手で直す</summary>
    <label class="banto-field banto-field--stacked"
      ><span class="banto-field-label">適用版</span><input
        class="banto-field-control"
        aria-label="期待適用版"
        inputmode="numeric"
        bind:value={applied}
        oninput={edit}
        {disabled}
      /></label
    >
    <label class="banto-field banto-field--stacked"
      ><span class="banto-field-label">mapping版</span><input
        class="banto-field-control"
        aria-label="期待mapping版"
        inputmode="numeric"
        bind:value={mapping}
        oninput={edit}
        disabled={disabled || unbound}
      /></label
    >
    <label class="banto-field banto-field--stacked"
      ><span class="banto-field-label">保持適用版</span><input
        class="banto-field-control"
        aria-label="期待保持適用版"
        inputmode="numeric"
        bind:value={retention}
        oninput={edit}
        disabled={disabled || unbound}
      /></label
    >
  </details>
  {#if error}<p role="alert">
      期待版を確認してください。有効な希望設定にはmapping版・保持適用版が必要です。
    </p>{/if}
</section>

<style>
  section {
    border: 1px solid var(--banto-border);
    border-radius: 0.4rem;
    padding: 0.8rem;
    overflow-wrap: anywhere;
  }
  h3 {
    margin: 0 0 0.5rem;
    font-size: 1rem;
  }
  p {
    margin: 0.4rem 0;
    white-space: pre-wrap;
  }
  summary {
    cursor: pointer;
    margin: 0.4rem 0;
  }
  label {
    display: grid;
    gap: 0.3rem;
    margin: 0.4rem 0;
    max-width: 14rem;
    text-align: left;
  }
  input {
    min-width: 0;
    width: 100%;
    color: var(--banto-text);
    background: var(--banto-surface);
    border: 1px solid var(--banto-border);
    padding: 0.4rem;
    border-radius: 4px;
  }
  input:disabled {
    opacity: 0.6;
  }
</style>
