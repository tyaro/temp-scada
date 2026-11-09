<script lang="ts">
  import { untrack } from "svelte";
  import { Modal } from "@banto/ui";
  import {
    describeError,
    roleLabel,
    ROLES,
    type AuthSettings,
    type Role,
  } from "./client";
  import type { AuthSession } from "./session.svelte";

  let {
    open,
    session,
    onclose,
  }: { open: boolean; session: AuthSession; onclose: () => void } = $props();

  let settings = $state<AuthSettings | undefined>();
  let role = $state<Role>("admin");
  let busy = $state(false);
  let message = $state("");
  let failed = $state(false);

  async function load() {
    busy = true;
    try {
      settings = await session.client.authConfigGet();
      role = settings.disabledRole;
    } catch (error) {
      settings = undefined;
      failed = true;
      message = describeError(error).message;
    } finally {
      busy = false;
    }
  }

  $effect(() => {
    if (!open) return;
    untrack(() => {
      message = "";
      failed = false;
      void load();
    });
  });

  async function apply(event: SubmitEvent) {
    event.preventDefault();
    if (!settings || busy) return;
    busy = true;
    try {
      // The mode itself is switched only by the move to operation (design §6).
      settings = await session.client.authConfigApply(settings.disabled, role);
      role = settings.disabledRole;
      failed = false;
      message = "認証設定を保存しました。";
    } catch (error) {
      failed = true;
      message = describeError(error).message;
    }
    await session.refresh();
    busy = false;
  }
</script>

<Modal {open} title="認証設定" width="480px" {onclose}>
  <form class="auth-settings" onsubmit={apply}>
    {#if settings}
      <p>
        認証無効モード: <strong>{settings.disabled ? "オン" : "オフ"}</strong>
      </p>
      <p class="note">
        モードは運用への移行でだけオフになります。運用中にオンへ戻すことはできません。
      </p>
      {#if settings.disabled}
        <label class="banto-field banto-field--stacked">
          <span class="banto-field-label">認証無効モードの権限</span>
          <select class="banto-field-control" bind:value={role} disabled={busy}>
            {#each ROLES as value (value)}
              <option {value}>{roleLabel(value)}</option>
            {/each}
          </select>
        </label>
        {#if role !== "admin"}
          <p class="note">
            管理者より下げると、記録の変更と運用への移行はできなくなります。移行する前に管理者へ戻してください。
          </p>
        {/if}
        <div class="actions">
          <button
            type="submit"
            disabled={busy || role === settings.disabledRole}>保存</button
          >
        </div>
      {/if}
    {:else if busy}
      <p role="status">読込中…</p>
    {/if}
    {#if message}<p role="status" class:failed>{message}</p>{/if}
  </form>
</Modal>

<style>
  .auth-settings {
    display: grid;
    gap: 10px;
    font-size: 13px;
  }
  .note {
    color: var(--banto-text-muted);
  }
  .failed {
    color: var(--banto-danger, #b42318);
  }
  p {
    margin: 0;
    overflow-wrap: anywhere;
  }
  button {
    padding: 4px 10px;
    border: 1px solid var(--banto-border);
    border-radius: 4px;
    background: var(--banto-bg);
    color: var(--banto-text);
    font: inherit;
  }
</style>
