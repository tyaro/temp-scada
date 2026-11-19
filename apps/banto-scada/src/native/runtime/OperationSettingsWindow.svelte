<script lang="ts">
  import { untrack } from "svelte";
  import { Modal } from "@banto/ui";
  import {
    changedAtText,
    changeDoneText,
    keyPairing,
    normalizeSecret,
    operationSettingsReasonText,
    settingsErrorCode,
    writeStateText,
    type OperationKeyStatus,
    type OperationSettingsHost,
  } from "./operation-settings";

  /**
   * 書込みの端末設定の窓（段階3の操作 設計 §7、O2c-4a）。書き用キーの
   * 登録・削除と「書込みを再開」。権限（運用では Admin）は host が毎回
   * 確かめ、断られたら理由を出す。秘密は入力欄から host へ送るだけで、
   * 窓を閉じたら入力を消す。host からは返らない。
   */
  let {
    open,
    host,
    onclose,
    onchanged,
    focusFallback,
  }: {
    open: boolean;
    host: OperationSettingsHost;
    onclose: () => void;
    /** 状態が変わった・読めたとき（上端の札を合わせる）。 */
    onchanged: (
      view: { status: OperationKeyStatus } | { error: string },
    ) => void;
    focusFallback?: () => HTMLElement | null | undefined;
  } = $props();

  let status = $state.raw<OperationKeyStatus | null>(null);
  let loadIssue = $state<string | null>(null);
  let secret = $state("");
  let busy = $state(false);
  let issue = $state<string | null>(null);
  let done = $state<string | null>(null);
  let confirmingDelete = $state(false);

  const pairing = $derived(status ? keyPairing(status) : "none");

  /**
   * 読込みと変更の世代。変更を始めるたび・読むたびに進め、古い読込みの答え
   * では窓と上端の札を上書きしない。
   */
  let generation = 0;
  async function load() {
    const issued = ++generation;
    try {
      const next = await host.status();
      if (!open || issued !== generation) return;
      status = next;
      loadIssue = null;
      onchanged({ status: next });
    } catch (error) {
      if (!open || issued !== generation) return;
      const code = settingsErrorCode(error);
      loadIssue = operationSettingsReasonText(code);
      onchanged({ error: code });
    }
  }

  $effect(() => {
    if (!open) return;
    untrack(() => {
      status = null;
      loadIssue = issue = done = null;
      confirmingDelete = false;
      void load();
    });
    return () => {
      // 窓を閉じたら入力した秘密を残さない。
      secret = "";
    };
  });

  async function change(
    kind: "register" | "remove" | "resume",
    run: () => Promise<OperationKeyStatus>,
  ) {
    if (busy) return;
    busy = true;
    issue = done = null;
    generation++;
    try {
      const next = await run();
      status = next;
      done = changeDoneText(kind, next);
      if (kind === "register") secret = "";
      onchanged({ status: next });
    } catch (error) {
      const code = settingsErrorCode(error);
      issue = operationSettingsReasonText(code);
      // 拒否の後も今の状態を読み直す（ほかの窓・書込みで変わっていることがある）。
      // 読み終わるまで次の変更を受けない。
      await load();
    } finally {
      busy = false;
      confirmingDelete = false;
    }
  }

  function register(event: SubmitEvent) {
    event.preventDefault();
    const value = normalizeSecret(secret);
    if (!value) {
      issue = "書き用キーを入れてください。";
      done = null;
      return;
    }
    void change("register", () => host.register(value));
  }
</script>

<Modal {open} title="書込みの端末設定" width="600px" {onclose} {focusFallback}>
  <div class="operation-settings" data-operation-settings>
    <p class="lead">
      この端末だけの設定です（Project には保存しません）。書き用キーは Hub
      の管理者が発行します。
    </p>
    {#if loadIssue}<p class="notice" role="alert">{loadIssue}</p>{/if}

    <section aria-label="書き用キー">
      <h3>書き用キー</h3>
      {#if !status}
        <p role="status">{loadIssue ? "" : "読込み中…"}</p>
      {:else}
        <dl>
          <dt>Hub の接続先</dt>
          <dd data-operation-hub-endpoint>
            {status.hubEndpoint ??
              "（保存されていません。Editor で Hub に接続してください）"}
          </dd>
          <dt>キー</dt>
          <dd data-operation-key>
            {#if pairing === "none"}
              登録されていません
            {:else}
              登録済み（{status.keyEndpoint}）
            {/if}
          </dd>
        </dl>
        {#if pairing === "mismatch"}
          <p class="notice" role="status" data-operation-key-mismatch>
            登録したときの接続先と今の Hub
            の接続先が違うため、書込みしません。登録し直してください。
          </p>
        {/if}
      {/if}

      <form class="register" onsubmit={register} data-operation-key-form>
        <label for="operation-write-key"
          >{pairing === "none"
            ? "書き用キーを登録する"
            : "書き用キーを登録し直す"}</label
        >
        <div class="row">
          <input
            id="operation-write-key"
            type="password"
            autocomplete="off"
            spellcheck="false"
            bind:value={secret}
            oninput={() => (issue = done = null)}
            disabled={busy || !status}
          />
          <button type="submit" disabled={busy || !status}>登録</button>
        </div>
        <small
          >キーの値は画面に戻りません。登録し直すと、前のキーはこの端末から消えます。</small
        >
      </form>

      {#if status && pairing !== "none"}
        <div class="delete">
          {#if confirmingDelete}
            <span role="status"
              >削除すると、この端末からは書込みしません。削除しますか？</span
            >
            <button
              type="button"
              class="danger"
              disabled={busy}
              onclick={() => void change("remove", host.remove)}
              >削除する</button
            >
            <button
              type="button"
              disabled={busy}
              onclick={() => (confirmingDelete = false)}>取消</button
            >
          {:else}
            <button
              type="button"
              disabled={busy}
              onclick={() => {
                issue = done = null;
                confirmingDelete = true;
              }}>キーを削除</button
            >
          {/if}
        </div>
      {/if}
    </section>

    {#if status}
      <section aria-label="書込みの状態">
        <h3>書込みの状態</h3>
        <p data-operation-write-state={status.write.state}>
          {writeStateText(status.write.state)}
        </p>
        {#if status.write.changedAtMs !== null}
          <p class="hint">
            変わった時刻: {changedAtText(status.write.changedAtMs)}
          </p>
        {/if}
        {#if status.write.state === "stopped"}
          <button
            type="button"
            disabled={busy}
            onclick={() => void change("resume", host.resume)}
            >書込みを再開</button
          >
        {/if}
      </section>
    {/if}

    {#if issue}<p class="notice" role="alert" data-operation-settings-issue>
        {issue}
      </p>{/if}
    {#if done}<p role="status" data-operation-settings-done>{done}</p>{/if}
  </div>
</Modal>

<style>
  .operation-settings {
    display: flex;
    flex-direction: column;
    gap: 12px;
    font-size: 13px;
  }
  .lead,
  .hint,
  small {
    color: var(--banto-text-muted);
  }
  .lead,
  p {
    margin: 0;
  }
  h3 {
    margin: 0 0 6px;
    font-size: 13px;
  }
  section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  section > button {
    align-self: flex-start;
  }
  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 12px;
    margin: 0;
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .register {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .row {
    display: flex;
    gap: 8px;
  }
  .row input {
    flex: 1;
    min-width: 0;
  }
  .delete {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .notice {
    color: var(--banto-danger, #b42318);
  }
  input,
  button {
    padding: 4px 10px;
    border: 1px solid var(--banto-border);
    border-radius: 4px;
    background: var(--banto-bg);
    color: var(--banto-text);
    font: inherit;
  }
  button.danger {
    border-color: var(--banto-danger, #b42318);
    color: var(--banto-danger, #b42318);
  }
  button:disabled,
  input:disabled {
    opacity: 0.6;
  }
</style>
