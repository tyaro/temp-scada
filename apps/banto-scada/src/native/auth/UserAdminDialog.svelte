<script lang="ts">
  import { untrack } from "svelte";
  import { Modal } from "@banto/ui";
  import {
    describeError,
    roleLabel,
    ROLES,
    type Role,
    type UserSummary,
  } from "./client";
  import type { AuthSession } from "./session.svelte";

  let {
    open,
    session,
    onclose,
  }: { open: boolean; session: AuthSession; onclose: () => void } = $props();

  interface Row {
    user: UserSummary;
    displayName: string;
    role: Role;
    resetPassword: string;
    confirmDelete: boolean;
  }

  let rows = $state<Row[]>([]);
  let loading = $state(false);
  let busy = $state(false);
  let message = $state("");
  let failed = $state(false);
  let newUsername = $state("");
  let newDisplayName = $state("");
  let newPassword = $state("");
  let newRole = $state<Role>("viewer");

  const me = $derived(
    session.view.status === "ready" && session.view.session?.kind === "account"
      ? session.view.session.identity.id
      : undefined,
  );

  async function load() {
    loading = true;
    try {
      const users = await session.client.usersList();
      rows = users.map((user) => ({
        user,
        displayName: user.displayName,
        role: user.role,
        resetPassword: "",
        confirmDelete: false,
      }));
    } catch (error) {
      rows = [];
      failed = true;
      message = describeError(error).message;
    } finally {
      loading = false;
    }
  }

  /** Run one change, then re-read the list and the own session. */
  async function change(action: () => Promise<void>, done: string) {
    if (busy) return;
    busy = true;
    try {
      await action();
      failed = false;
      message = done;
    } catch (error) {
      failed = true;
      message = describeError(error).message;
    }
    await Promise.all([load(), session.refresh()]);
    busy = false;
  }

  $effect(() => {
    if (!open) return;
    untrack(() => {
      message = "";
      failed = false;
      void load();
    });
  });

  function create(event: SubmitEvent) {
    event.preventDefault();
    const username = newUsername.trim();
    const displayName = newDisplayName.trim() || username;
    void change(async () => {
      await session.client.usersCreate(
        username,
        newPassword,
        displayName,
        newRole,
      );
      newUsername = "";
      newDisplayName = "";
      newPassword = "";
      newRole = "viewer";
    }, `利用者「${username}」を作成しました。`);
  }

  function save(row: Row) {
    void change(
      () =>
        session.client.usersUpdate(
          row.user.id,
          row.displayName.trim() || row.user.username,
          row.role,
        ),
      `利用者「${row.user.username}」を更新しました。`,
    );
  }

  function reset(row: Row) {
    void change(
      () => session.client.usersResetPassword(row.user.id, row.resetPassword),
      `利用者「${row.user.username}」のパスワードを再設定しました。この利用者のログインは終了しました。`,
    );
  }

  function remove(row: Row) {
    if (!row.confirmDelete) {
      row.confirmDelete = true;
      return;
    }
    void change(
      () => session.client.usersDelete(row.user.id),
      `利用者「${row.user.username}」を削除しました。`,
    );
  }
</script>

<Modal {open} title="利用者管理" width="860px" {onclose}>
  <div class="user-admin">
    {#if message}<p role="status" class:failed>{message}</p>{/if}
    {#if loading && rows.length === 0}
      <p role="status">読込中…</p>
    {:else}
      <table aria-label="利用者一覧">
        <thead>
          <tr>
            <th scope="col">ユーザー名</th>
            <th scope="col">表示名</th>
            <th scope="col">権限</th>
            <th scope="col">パスワード再設定</th>
            <th scope="col">操作</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row (row.user.id)}
            <tr>
              <td
                >{row.user.username}{#if row.user.username === me}<span
                    class="me">（自分）</span
                  >{/if}</td
              >
              <td>
                <input
                  class="banto-field-control"
                  aria-label={`${row.user.username} の表示名`}
                  bind:value={row.displayName}
                  disabled={busy}
                />
              </td>
              <td>
                <select
                  class="banto-field-control"
                  aria-label={`${row.user.username} の権限`}
                  bind:value={row.role}
                  disabled={busy}
                >
                  {#each ROLES as role (role)}
                    <option value={role}>{roleLabel(role)}</option>
                  {/each}
                </select>
              </td>
              <td class="reset">
                <input
                  class="banto-field-control"
                  type="password"
                  autocomplete="new-password"
                  aria-label={`${row.user.username} の新しいパスワード`}
                  bind:value={row.resetPassword}
                  disabled={busy}
                />
                <button
                  type="button"
                  disabled={busy || !row.resetPassword}
                  onclick={() => reset(row)}>再設定</button
                >
              </td>
              <td class="actions">
                <button
                  type="button"
                  disabled={busy ||
                    (row.displayName === row.user.displayName &&
                      row.role === row.user.role)}
                  onclick={() => save(row)}>保存</button
                >
                <button
                  type="button"
                  class:danger={row.confirmDelete}
                  disabled={busy}
                  onclick={() => remove(row)}
                  >{row.confirmDelete ? "削除を確定" : "削除"}</button
                >
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
    <form class="create" aria-label="利用者の作成" onsubmit={create}>
      <h3>利用者の作成</h3>
      <label class="banto-field banto-field--stacked">
        <span class="banto-field-label">ユーザー名</span>
        <input
          class="banto-field-control"
          autocomplete="off"
          bind:value={newUsername}
          disabled={busy}
          required
        />
      </label>
      <label class="banto-field banto-field--stacked">
        <span class="banto-field-label">表示名</span>
        <input
          class="banto-field-control"
          autocomplete="off"
          bind:value={newDisplayName}
          disabled={busy}
        />
      </label>
      <label class="banto-field banto-field--stacked">
        <span class="banto-field-label">パスワード</span>
        <input
          class="banto-field-control"
          type="password"
          autocomplete="new-password"
          bind:value={newPassword}
          disabled={busy}
          required
        />
      </label>
      <label class="banto-field banto-field--stacked">
        <span class="banto-field-label">権限</span>
        <select
          class="banto-field-control"
          bind:value={newRole}
          disabled={busy}
        >
          {#each ROLES as role (role)}
            <option value={role}>{roleLabel(role)}</option>
          {/each}
        </select>
      </label>
      <button type="submit" disabled={busy || !newUsername.trim()}>作成</button>
    </form>
    <p class="note">
      記録の変更は管理者だけが行えます。記録の変更作業が終わっていない管理者は、降格・削除できません。
    </p>
  </div>
</Modal>

<style>
  .user-admin {
    display: grid;
    gap: 12px;
    font-size: 13px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  th,
  td {
    padding: 4px 6px;
    border-bottom: 1px solid var(--banto-border);
    text-align: left;
    vertical-align: middle;
  }
  td input,
  td select {
    box-sizing: border-box;
    min-height: 26px;
    padding: 2px 6px;
    border: 1px solid var(--banto-border);
    border-radius: 4px;
    background: var(--banto-bg);
    color: var(--banto-text);
    font: inherit;
  }
  td input:focus-visible,
  td select:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
  .reset,
  .actions {
    white-space: nowrap;
  }
  .reset input {
    width: 9em;
  }
  .me {
    color: var(--banto-text-muted);
  }
  .create {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr)) auto;
    align-items: end;
    gap: 8px;
  }
  .create h3 {
    grid-column: 1 / -1;
    margin: 0;
    font-size: 13px;
  }
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
  .failed {
    color: var(--banto-danger, #b42318);
  }
  .note {
    margin: 0;
    color: var(--banto-text-muted);
  }
  p {
    margin: 0;
    overflow-wrap: anywhere;
  }
</style>
