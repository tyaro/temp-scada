<script lang="ts">
  import type { Snippet } from "svelte";
  import {
    nextOperationStep,
    operationStepDone,
    type OperationStep,
    type OperationStepInput,
  } from "./steps";
  // The numbered steps of a recording change (UX review 2026-11-11 P1-7).
  // The buttons keep their names; the step titles say what each one does.
  let {
    input,
    disabled,
    onpreflight,
    onpause,
    onapply,
    onopenmanagement,
    inspect,
  }: {
    input: OperationStepInput;
    /** Blocks every step (another target, a conflict, a closed dialog). */
    disabled: boolean;
    onpreflight: () => void;
    onpause: () => void;
    onapply: () => void;
    /** Closes this dialog and opens the recording management dialog. */
    onopenmanagement?: () => void;
    /** The expected revisions, shown in step 1. */
    inspect: Snippet;
  } = $props();
  const next = $derived(disabled ? undefined : nextOperationStep(input));
  const state = (step: OperationStep) =>
    next === step
      ? "current"
      : operationStepDone(step, input)
        ? "done"
        : "pending";
  const marks = { current: "次の操作", done: "済み", pending: "" };
</script>

{#snippet head(step: OperationStep, title: string, detail: string)}
  <h3>
    <span class="number" aria-hidden="true">{step}</span>{title}
    {#if marks[state(step)]}<span class="mark">（{marks[state(step)]}）</span
      >{/if}
  </h3>
  <p class="detail">{detail}</p>
{/snippet}

<ol class="steps" aria-label="変更の手順">
  <li data-operation-step="1" data-step-state={state(1)}>
    {@render head(
      1,
      "変更を検査する",
      "Projectの希望設定と期待版で変更候補を作り、記録したまま検査します。",
    )}
    {@render inspect()}
    <button
      type="button"
      class:primary={next === 1}
      disabled={disabled || !input.canPreflight}
      onclick={onpreflight}>新しい変更を検査</button
    >
  </li>
  <li data-operation-step="2" data-step-state={state(2)}>
    {@render head(
      2,
      "記録を一時停止する",
      "検査した元runを停止し、終了（join）を待ちます。ここから記録が止まります。",
    )}
    <button
      type="button"
      class:primary={next === 2}
      disabled={disabled || !input.canPause}
      onclick={onpause}>この元runを停止してjoin</button
    >
  </li>
  <li data-operation-step="3" data-step-state={state(3)}>
    {@render head(
      3,
      "設定を適用する",
      "検査した同じ候補を記録DBへ適用します。記録は止まったままです。",
    )}
    <button
      type="button"
      class:primary={next === 3}
      disabled={disabled || !input.canApply}
      onclick={onapply}>同候補を適用</button
    >
  </li>
  <li data-operation-step="4" data-step-state={state(4)}>
    {@render head(
      4,
      "記録を再開する",
      "この画面では再開しません。記録管理状態の「記録を再開」で再開します。",
    )}
    {#if onopenmanagement}<button
        type="button"
        class:primary={next === 4}
        onclick={onopenmanagement}>記録管理状態を開く</button
      >{/if}
  </li>
</ol>

<style>
  .steps {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.5rem;
  }
  li {
    border: 1px solid var(--banto-border);
    border-radius: 0.4rem;
    padding: 0.6rem 0.8rem;
    overflow-wrap: anywhere;
  }
  li[data-step-state="current"] {
    border-color: var(--banto-primary-solid);
    box-shadow: inset 3px 0 0 var(--banto-primary-solid);
  }
  li[data-step-state="done"] h3 {
    color: var(--banto-text-muted, inherit);
  }
  h3 {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0 0 0.25rem;
    font-size: 1rem;
  }
  .number {
    display: inline-grid;
    place-items: center;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 50%;
    border: 1px solid var(--banto-border);
    font-size: 0.85rem;
  }
  li[data-step-state="current"] .number {
    background: var(--banto-primary-solid);
    border-color: var(--banto-primary-solid);
    color: #fff;
  }
  .mark {
    font-weight: normal;
    font-size: 0.85rem;
  }
  .detail {
    margin: 0 0 0.4rem;
  }
  button {
    padding: 0.4rem 0.75rem;
  }
  button.primary:not(:disabled) {
    border: 1px solid var(--banto-primary-solid);
    border-radius: 4px;
    background: var(--banto-primary-solid);
    color: #fff;
  }
</style>
