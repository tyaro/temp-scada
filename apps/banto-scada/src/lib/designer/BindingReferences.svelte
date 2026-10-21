<script lang="ts">
  import BindingReplacement from "./BindingReplacement.svelte";
  import type { Project } from "../project";
  import type { EditCommand } from "../editor";
  import type { createDraftGuard } from "./drafts.svelte";
  import { StatusBadge } from "@banto/ui";
  import {
    searchReferences,
    type BindingReference,
    type BindingUsage,
  } from "../binding-references";
  let {
    project,
    scope,
    editable,
    drafts,
    onedit,
    references,
    onopen,
    onclose,
    expanded = $bindable(false),
    sized = false,
    onbeforetoggle,
    onaftertoggle,
  }: {
    project: Project;
    scope: string;
    editable: boolean;
    drafts: ReturnType<typeof createDraftGuard>;
    onedit: (
      command: EditCommand,
      form: HTMLFormElement,
      onerror: (message: string) => void,
    ) => boolean;
    references: BindingReference[];
    onopen: (usage: BindingUsage) => void;
    onclose: () => void;
    expanded?: boolean;
    sized?: boolean;
    onbeforetoggle?: () => void;
    onaftertoggle?: () => void;
  } = $props();
  let replacing = $state<string | null>(null);
  function beginReplacement(from: string) {
    const start = () => {
      replacing = from;
    };
    if (drafts.allow(start)) start();
  }
  let togglePending = false;
  let search = $state("");
  const filtered = $derived(searchReferences(references, search));
  const usageCount = $derived(
    references.reduce((count, reference) => count + reference.usages.length, 0),
  );
</script>

{#if references.length}
  <details
    class="references"
    class:sized
    bind:open={expanded}
    ontoggle={(event) => {
      // Native details toggles are queued separately from the summary click.
      expanded = event.currentTarget.open;
      if (togglePending) {
        togglePending = false;
        onaftertoggle?.();
      }
    }}
  >
    <summary
      onclick={() => {
        togglePending = true;
        onbeforetoggle?.();
      }}
      >Project のタグ参照 · {references.length} タグ / {usageCount} 配置</summary
    >
    <section aria-label="Project のタグ参照">
      <button class="close" onclick={onclose}>タグ参照一覧を隠す</button>
      <p>
        Project 内の割り当てから算出した一覧です。Hub
        のタグ一覧ではありません。使用箇所から編集できます。
      </p>
      <div class="search">
        <label
          >タグ参照を検索<input
            type="search"
            bind:value={search}
            placeholder="外部名・配置名・画面名・静的テキスト"
          /></label
        >
        {#if search}<button onclick={() => (search = "")}>検索をクリア</button
          >{/if}
      </div>
      {#if replacing !== null}
        {#key replacing}<BindingReplacement
            {project}
            from={replacing}
            {scope}
            {editable}
            {drafts}
            {onedit}
            oncancel={() => (replacing = null)}
          />{/key}
      {/if}
      <p role="status">{filtered.length} / {references.length} タグを表示</p>
      {#if filtered.length}
        <div class="scroll">
          <table>
            <thead
              ><tr
                ><th scope="col">外部名</th><th scope="col">使用箇所</th><th
                  scope="col">接続状態</th
                ></tr
              ></thead
            >
            <tbody>
              {#each filtered as reference (reference.externalName)}
                <tr data-tag-reference={reference.externalName}>
                  <th scope="row"
                    >{reference.externalName}
                    <button
                      class="replace"
                      disabled={!editable}
                      aria-label={`${reference.externalName} を一括置換`}
                      onclick={() => beginReplacement(reference.externalName)}
                      >一括置換</button
                    >
                  </th>
                  <td
                    ><div class="usages">
                      {#each reference.usages as usage (usage.objectId)}
                        <button
                          aria-label={`${usage.screenName} の ${usage.name ? `${usage.name}（Text ${usage.order}）` : `Text ${usage.order}`} を編集`}
                          title={usage.name}
                          onclick={() => onopen(usage)}
                          >{usage.screenName} / {usage.name ??
                            `Text ${usage.order}`}{usage.visible === false
                            ? "（非表示）"
                            : ""}</button
                        >
                      {/each}
                    </div></td
                  >
                  <td><StatusBadge variant="neutral" label="未接続" /></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}<p>一致するタグ参照がありません。</p>{/if}
    </section>
  </details>
{/if}

<style>
  .replace {
    display: block;
    margin-top: 6px;
  }
  .close {
    float: right;
  }
  .references {
    margin-top: 16px;
    border: 1px solid var(--banto-border);
    border-radius: 6px;
    background: var(--banto-surface);
  }
  .references.sized {
    margin-top: 0;
    height: 100%;
    overflow: auto;
  }
  .sized .scroll {
    max-height: none;
    overflow: visible;
  }
  summary {
    padding: 12px;
    font-size: 13px;
    cursor: pointer;
  }
  section {
    padding: 0 12px 12px;
    min-width: 0;
  }
  p {
    color: var(--banto-text-muted);
    font-size: 12px;
    line-height: 1.7;
    margin: 8px 0;
  }
  .search {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: end;
  }
  label {
    display: grid;
    gap: 5px;
    font-size: 12px;
    color: var(--banto-text-muted);
    flex: 1 1 220px;
    min-width: 0;
  }
  input,
  button {
    font: inherit;
    font-size: 12px;
    color: var(--banto-text);
    background: var(--banto-bg);
    border: 1px solid var(--banto-border);
    border-radius: 4px;
    padding: 7px;
  }
  input {
    width: 100%;
    min-width: 0;
  }
  button {
    cursor: pointer;
    text-align: left;
    overflow-wrap: anywhere;
  }
  button:hover {
    border-color: var(--banto-primary);
  }
  button:focus-visible,
  input:focus-visible,
  summary:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
  .scroll {
    max-height: 240px;
    overflow: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
    font-size: 12px;
  }
  th,
  td {
    padding: 8px;
    border-top: 1px solid var(--banto-border);
    text-align: left;
    vertical-align: top;
    overflow-wrap: anywhere;
  }
  thead th {
    color: var(--banto-text-muted);
    font-weight: normal;
  }
  th:first-child {
    width: 40%;
  }
  th:last-child {
    width: 90px;
  }
  .usages {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  @media (max-width: 500px) {
    th,
    td {
      padding: 6px 4px;
    }
    th:last-child {
      width: 72px;
    }
  }
</style>
