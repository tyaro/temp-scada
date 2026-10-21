<script lang="ts">
  import { tick } from "svelte";
  import type { Project } from "../project";
  import type { EditCommand } from "../editor";
  import {
    previewBindingReplacement,
    type BindingReplacementPreview,
  } from "../binding-replacement";
  import type { createDraftGuard } from "./drafts.svelte";
  let {
    project,
    from,
    scope,
    editable,
    drafts,
    onedit,
    oncancel,
  }: {
    project: Project;
    from: string;
    scope: string;
    editable: boolean;
    drafts: ReturnType<typeof createDraftGuard>;
    onedit: (
      command: EditCommand,
      form: HTMLFormElement,
      onerror: (message: string) => void,
    ) => boolean;
    oncancel: () => void;
  } = $props();
  let form: HTMLFormElement;
  let input: HTMLInputElement;
  let to = $state("");
  let error = $state("");
  let composing = $state(false);
  let preview = $state<BindingReplacementPreview | null>(null);
  let capturedProject = $state.raw<Project | null>(null);
  let capturedScope = $state("");
  let invalidated = $state(false);
  const stale = $derived(
    invalidated ||
      (preview !== null &&
        (project !== capturedProject || scope !== capturedScope)),
  );
  $effect(() => {
    if (preview && (project !== capturedProject || scope !== capturedScope))
      invalidated = true;
  });
  $effect(() => {
    void tick().then(() => input?.focus());
  });
  function reset() {
    to = "";
    preview = null;
    error = "";
    invalidated = false;
  }
  function inspect(event: SubmitEvent) {
    event.preventDefault();
    if (composing || !editable || !drafts.beforeSubmit(form)) return;
    preview = null;
    try {
      preview = previewBindingReplacement(project, from, to);
      capturedProject = project;
      capturedScope = scope;
      invalidated = false;
      error = "";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  function apply() {
    if (
      composing ||
      !editable ||
      !preview ||
      stale ||
      !preview.changed ||
      preview.blocked.length
    )
      return;
    if (
      onedit(
        {
          type: "replace-binding-reference",
          from: preview.from,
          to: preview.to,
          expectedProject: preview.expectedProject,
        },
        form,
        (message) => (error = message),
      )
    )
      oncancel();
  }
</script>

<form
  bind:this={form}
  use:drafts.track
  data-editor-form="binding-replacement"
  aria-label="タグ参照名の一括置換"
  onsubmit={inspect}
  onreset={reset}
  oncompositionstart={() => (composing = true)}
  oncompositionend={() => (composing = false)}
>
  <h3>タグ参照名の一括置換</h3>
  <p>
    全画面の直接数値Textを完全一致で置換します。検索条件に関係なく非表示配置も対象です。Hubのタグ名は変更しません。
  </p>
  <div class="fields">
    <label>置換元<input value={from} readonly /></label>
    <label
      >置換先<input
        bind:this={input}
        onkeydown={(event) => {
          if (
            event.key === "Enter" &&
            (event.isComposing || event.keyCode === 229 || composing)
          )
            event.preventDefault();
        }}
        name="replacementName"
        bind:value={to}
        required
        oninput={() => {
          preview = null;
          error = "";
        }}
      /></label
    >
    <button type="submit" disabled={!editable || composing}>差分を確認</button>
    <button
      type="button"
      onclick={() => {
        drafts.submitted(form);
        oncancel();
      }}>置換を取消</button
    >
  </div>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if preview}
    <section aria-label="置換の差分">
      <p role="status">
        対象 {preview.usages.length} 配置 · 既存の置換先 {preview
          .existingDestinationUsages.length} 配置
      </p>
      <p>旧: {preview.from} → 新: {preview.to}</p>
      {#if !preview.changed}<p>同じ参照名のため変更はありません。</p>{/if}
      {#if stale}<p role="alert">
          Projectまたは編集対象が変わりました。差分を再確認してください。
        </p>{/if}
      <ul>
        {#each preview.usages as usage (usage.objectId)}
          <li>
            {usage.screenName} / {usage.name ?? `Text ${usage.order}`} · {usage.objectId}{usage.visible ===
            false
              ? "（非表示）"
              : ""}
          </li>
        {/each}
      </ul>
      {#if preview.existingDestinationUsages.length}
        <p>次の既存使用先と同じ参照名になります。</p>
        <ul>
          {#each preview.existingDestinationUsages as usage (usage.objectId)}<li
            >
              {usage.screenName} / {usage.name ?? `Text ${usage.order}`} · {usage.objectId}
            </li>{/each}
        </ul>
      {/if}
      {#if preview.blocked.length}<p role="alert">
          変更できない配置があるため、全件を置換できません。
        </p>
        <ul>
          {#each preview.blocked as item}<li>
              {item.screenId} / {item.objectId}: {item.reason}
            </li>{/each}
        </ul>
      {/if}
      <button
        type="button"
        disabled={!editable ||
          composing ||
          stale ||
          !preview.changed ||
          preview.blocked.length > 0}
        onclick={apply}>全{preview.usages.length}配置を置換</button
      >
    </section>
  {/if}
</form>

<style>
  form {
    border-top: 1px solid var(--banto-border);
    padding: 12px 0;
  }
  h3 {
    margin: 0 0 8px;
    font-size: 13px;
  }
  p,
  li {
    font-size: 12px;
    overflow-wrap: anywhere;
    line-height: 1.7;
  }
  p {
    color: var(--banto-text-muted);
  }
  [role="alert"] {
    color: var(--banto-text);
  }
  .fields {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: 8px;
  }
  label {
    display: grid;
    gap: 4px;
    flex: 1 1 220px;
    min-width: 0;
    font-size: 12px;
  }
  input,
  button {
    font: inherit;
    font-size: 12px;
    padding: 7px;
    border: 1px solid var(--banto-border);
    border-radius: 4px;
    color: var(--banto-text);
    background: var(--banto-bg);
  }
  input {
    width: 100%;
    min-width: 0;
  }
  button {
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  input:focus-visible,
  button:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
  ul {
    max-height: 150px;
    overflow: auto;
    padding-left: 22px;
  }
</style>
