<script lang="ts">
  import { Modal } from "@banto/ui";
  import type { Project } from "../project";
  import { screenViewOptions } from "../screen-references";
  let {
    project,
    ownerId,
    onapply,
    onclose,
  }: {
    project: Project;
    ownerId: string;
    onapply: (id: string) => void;
    onclose: () => void;
  } = $props();
  let selected = $state("");
  let search = $state("");
  const options = $derived(screenViewOptions(project, ownerId));
  const visible = $derived(
    options.filter((o) =>
      o.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
    ),
  );
  const candidate = $derived(options.find((o) => o.id === selected));
</script>

<Modal open title="画面を埋め込む" {onclose}>
  <p>
    同じProjectの画面を、背景ごと読み取り表示します。元画面の編集はすべての使用先へ反映されます。
  </p>
  <label
    >画面を検索<input
      bind:value={search}
      type="search"
      aria-label="埋込画面を検索"
    /></label
  >
  <div class="sources" role="group" aria-label="埋め込む画面">
    {#each visible as option (option.id)}
      <label class:unavailable={!!option.reason}
        ><input
          type="radio"
          name="screen-view-source"
          value={option.id}
          bind:group={selected}
          disabled={!!option.reason}
        /><span
          >{option.name}{#if option.reason}<small>{option.reason}</small
            >{/if}</span
        ></label
      >
    {/each}
    {#if !visible.length}<p>一致する画面がありません。</p>{/if}
  </div>
  <p class="note">
    参照画面・共有定義・画像原本を含めたコピーに対応しています。機器の関連付けを含むコピー、入れ子、埋込画面内の操作は未対応です。
  </p>
  <div class="actions">
    <button onclick={onclose}>キャンセル</button><button
      disabled={!candidate || !!candidate.reason}
      onclick={() => candidate && !candidate.reason && onapply(candidate.id)}
      >埋込配置を追加</button
    >
  </div>
</Modal>

<style>
  .sources {
    max-height: 40vh;
    overflow: auto;
    margin: 1rem 0;
  }
  .sources label {
    display: flex;
    gap: 0.6rem;
    padding: 0.5rem 0;
    align-items: start;
  }
  .sources input {
    margin-top: 0.3rem;
  }
  small {
    display: block;
    color: var(--banto-text-muted);
    font-size: 0.8rem;
  }
  .unavailable {
    color: var(--banto-text-muted);
  }
  .note {
    font-size: 0.85rem;
    color: var(--banto-text-muted);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  input[type="search"] {
    width: 100%;
  }
</style>
