<script lang="ts">
  import { onMount } from "svelte";
  import { NO_ADMIN_ACCOUNT_MESSAGE, roleLabel } from "./client";
  import {
    canEditSettings,
    canManageUsers,
    canTransition,
    needsAdminAccount,
    type ActionResult,
    type AuthSession,
  } from "./session.svelte";
  import UserAdminDialog from "./UserAdminDialog.svelte";
  import AuthSettingsDialog from "./AuthSettingsDialog.svelte";

  // `align="end"` opens the popover leftward from the control's right edge,
  // for a control placed at the right of a bar (Runtime's top bar).
  // `runtime` hides the Editor-only operations (Runtime mode design §5,
  // §10-2): the move to operation and the authentication settings, whose
  // commands the Runtime capability rejects. Accounts are made in user
  // management (Banto v8.0.0 has no first-run setup).
  let {
    session,
    align = "start",
    runtime = false,
  }: {
    session: AuthSession;
    align?: "start" | "end";
    runtime?: boolean;
  } = $props();

  let details: HTMLDetailsElement;
  let busy = $state(false);
  let result = $state<ActionResult | undefined>();
  let usersOpen = $state(false);
  let settingsOpen = $state(false);
  let transitionOpen = $state(false);
  let passwordOpen = $state(false);

  let username = $state("");
  let password = $state("");
  let currentPassword = $state("");
  let nextPassword = $state("");

  const view = $derived(session.view);
  const ready = $derived(view.status === "ready" ? view : undefined);
  const account = $derived(
    ready?.session?.kind === "account" ? ready.session : undefined,
  );
  /** No administrator account yet: the move cannot be pressed. */
  const noAdmin = $derived(needsAdminAccount(view));
  const showTransition = $derived(
    !runtime &&
      !noAdmin &&
      (ready?.phase.phase === "transitioning" ||
        (transitionOpen && canTransition(view))),
  );

  const summary = $derived.by(() => {
    if (view.status === "loading") return "確認中";
    if (view.status === "unavailable") return "利用不可";
    if (view.phase.phase === "transitioning") return "移行途中";
    if (view.session?.kind === "local") return "認証無効";
    if (view.session) return view.session.identity.name;
    return "未ログイン";
  });

  function clearForms() {
    username = "";
    password = "";
    currentPassword = "";
    nextPassword = "";
  }

  async function run(action: () => Promise<ActionResult>) {
    if (busy) return;
    busy = true;
    try {
      result = await action();
      if (result.ok) {
        clearForms();
        transitionOpen = false;
        passwordOpen = false;
      }
    } finally {
      busy = false;
    }
  }

  function login(event: SubmitEvent) {
    event.preventDefault();
    void run(() => session.login(username.trim(), password));
  }

  function transition(event: SubmitEvent) {
    event.preventDefault();
    void run(() => session.transitionToOperational(username.trim(), password));
  }

  function changePassword(event: SubmitEvent) {
    event.preventDefault();
    void run(() => session.changePassword(currentPassword, nextPassword));
  }

  function openDialog(which: "users" | "settings") {
    details.open = false;
    if (which === "users") usersOpen = true;
    else settingsOpen = true;
  }

  onMount(() => {
    const stop = session.start();
    const outside = (event: PointerEvent) => {
      if (details?.open && !details.contains(event.target as Node))
        details.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !details?.open) return;
      details.open = false;
      details.querySelector("summary")?.focus();
      event.stopPropagation();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      stop();
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  });
</script>

<details class="auth-control" bind:this={details}>
  <summary aria-label={`認証: ${summary}。認証の操作を開く`} title={summary}>
    <span
      class="auth-dot"
      class:active={!!ready?.session}
      class:error={view.status === "unavailable" ||
        ready?.phase.phase === "transitioning"}
    ></span>
    <span>認証</span>
    <span class="auth-summary-state">{busy ? "処理中" : summary}</span>
  </summary>
  <div class="auth-popover" class:align-end={align === "end"}>
    {#if view.status === "loading"}
      <p role="status">認証の状態を確認しています…</p>
    {:else if view.status === "unavailable"}
      <p role="alert" class="failed">{view.message}</p>
      <p class="note">画面の編集と読取は使えます。記録の変更は使えません。</p>
      <div class="auth-actions">
        <button type="button" onclick={() => void session.refresh()}
          >再読込</button
        >
      </div>
    {:else}
      <p>
        フェーズ:
        <strong
          >{view.phase.phase === "initializing"
            ? "開発・初期設定"
            : view.phase.phase === "transitioning"
              ? "運用への移行の途中"
              : "運用"}</strong
        >
      </p>
      {#if view.session?.kind === "local"}
        <p>
          ログインなし（認証無効モード・{roleLabel(view.session.role)}）
        </p>
      {:else if view.session}
        <p>
          {view.session.identity.name}（{view.session.identity.id}・{roleLabel(
            view.session.role,
          )}）
        </p>
      {:else}
        <p>ログインしていません</p>
      {/if}

      {#if noAdmin && view.phase.phase !== "operational"}
        <div class="auth-no-admin" data-auth-no-admin>
          <p class="note" id="auth-no-admin">{NO_ADMIN_ACCOUNT_MESSAGE}</p>
          {#if canManageUsers(view)}
            <div class="auth-actions">
              <button
                type="button"
                disabled={busy}
                onclick={() => openDialog("users")}>利用者管理を開く…</button
              >
            </div>
          {/if}
        </div>
      {/if}

      {#if view.phase.phase === "transitioning"}
        <p role="alert" class="failed">
          {runtime
            ? "運用への移行が完了していません。Editor で管理者の資格情報を使って移行を再実行してください。完了するまで記録の変更と照会は使えません。"
            : "運用への移行が完了していません。管理者の資格情報で移行を再実行してください。完了するまで記録の変更と照会は使えません。"}
        </p>
      {:else if view.phase.phase === "initializing" && view.phase.authDisabled}
        {#if runtime}
          <p class="note" data-auth-editor-only>
            運用への移行は Editor
            で行ってください。管理者のアカウントは利用者管理で作ります。
          </p>
        {:else if canTransition(view)}
          {#if !transitionOpen || noAdmin}
            <div class="auth-actions">
              <button
                type="button"
                disabled={busy || noAdmin}
                aria-describedby={noAdmin ? "auth-no-admin" : undefined}
                onclick={() => {
                  result = undefined;
                  transitionOpen = true;
                }}>運用へ移行…</button
              >
            </div>
          {/if}
        {:else}
          <p class="note">
            運用へ移行するには、認証設定で認証無効モードの権限を管理者へ戻してください。
          </p>
        {/if}
      {/if}

      {#if showTransition}
        <form class="auth-form" aria-label="運用への移行" onsubmit={transition}>
          <p class="note">
            管理者の資格情報を確認し、認証無効モードをオフにします。
            移行後は認証無効モードへ戻せません。
          </p>
          {@render adminFields()}
          <div class="auth-actions">
            <button type="submit" disabled={busy}
              >{view.phase.phase === "transitioning"
                ? "移行を再実行"
                : "運用へ移行"}</button
            >
            {#if view.phase.phase !== "transitioning"}
              <button
                type="button"
                disabled={busy}
                onclick={() => {
                  transitionOpen = false;
                  clearForms();
                }}>取消</button
              >
            {/if}
          </div>
        </form>
      {:else if view.phase.phase === "operational" && !view.session}
        <form class="auth-form" aria-label="ログイン" onsubmit={login}>
          <label class="banto-field banto-field--stacked">
            <span class="banto-field-label">ユーザー名</span>
            <input
              class="banto-field-control"
              autocomplete="username"
              bind:value={username}
              disabled={busy}
              required
            />
          </label>
          <label class="banto-field banto-field--stacked">
            <span class="banto-field-label">パスワード</span>
            <input
              class="banto-field-control"
              type="password"
              autocomplete="current-password"
              bind:value={password}
              disabled={busy}
              required
            />
          </label>
          <div class="auth-actions">
            <button type="submit" disabled={busy}>ログイン</button>
          </div>
        </form>
      {/if}

      {#if account}
        {#if passwordOpen}
          <form
            class="auth-form"
            aria-label="パスワード変更"
            onsubmit={changePassword}
          >
            <label class="banto-field banto-field--stacked">
              <span class="banto-field-label">現在のパスワード</span>
              <input
                class="banto-field-control"
                type="password"
                autocomplete="current-password"
                bind:value={currentPassword}
                disabled={busy}
                required
              />
            </label>
            <label class="banto-field banto-field--stacked">
              <span class="banto-field-label">新しいパスワード</span>
              <input
                class="banto-field-control"
                type="password"
                autocomplete="new-password"
                bind:value={nextPassword}
                disabled={busy}
                required
              />
            </label>
            <div class="auth-actions">
              <button type="submit" disabled={busy}>変更</button>
              <button
                type="button"
                disabled={busy}
                onclick={() => {
                  passwordOpen = false;
                  clearForms();
                }}>取消</button
              >
            </div>
          </form>
        {/if}
        <div class="auth-actions">
          {#if !passwordOpen}
            <button
              type="button"
              disabled={busy}
              onclick={() => {
                result = undefined;
                passwordOpen = true;
              }}>パスワード変更…</button
            >
          {/if}
          <button
            type="button"
            disabled={busy}
            onclick={() => void run(() => session.logout())}>ログアウト</button
          >
        </div>
      {/if}

      {#if canManageUsers(view) || (!runtime && canEditSettings(view))}
        <div class="auth-actions">
          {#if canManageUsers(view)}
            <button
              type="button"
              disabled={busy}
              onclick={() => openDialog("users")}>利用者管理…</button
            >
          {/if}
          {#if !runtime && canEditSettings(view)}
            <button
              type="button"
              disabled={busy}
              onclick={() => openDialog("settings")}>認証設定…</button
            >
          {/if}
        </div>
      {/if}
    {/if}
    {#if result?.message}
      <p role="status" class:failed={!result.ok}>{result.message}</p>
    {/if}
  </div>
</details>

<UserAdminDialog
  open={usersOpen}
  {session}
  onclose={() => (usersOpen = false)}
/>
{#if !runtime}
  <AuthSettingsDialog
    open={settingsOpen}
    {session}
    onclose={() => (settingsOpen = false)}
  />
{/if}

<!-- The administrator's credentials of the move to operation. -->
{#snippet adminFields()}
  <label class="banto-field banto-field--stacked">
    <span class="banto-field-label">管理者のユーザー名</span>
    <input
      class="banto-field-control"
      autocomplete="username"
      bind:value={username}
      disabled={busy}
      required
    />
  </label>
  <label class="banto-field banto-field--stacked">
    <span class="banto-field-label">パスワード</span>
    <input
      class="banto-field-control"
      type="password"
      autocomplete="current-password"
      bind:value={password}
      disabled={busy}
      required
    />
  </label>
{/snippet}

<style>
  .auth-control {
    position: relative;
    z-index: calc(var(--banto-z-header, 100) + 1);
    font-size: 12px;
  }
  .auth-control summary {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 28px;
    padding: 3px 7px;
    list-style: none;
    border: 1px solid var(--banto-border);
    border-radius: 4px;
    color: var(--banto-text);
    cursor: pointer;
    white-space: nowrap;
  }
  .auth-control summary::-webkit-details-marker {
    display: none;
  }
  .auth-control summary:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
  .auth-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--banto-text-muted);
  }
  .auth-dot.active {
    background: var(--banto-primary);
  }
  .auth-dot.error {
    background: var(--banto-danger, #b42318);
  }
  .auth-summary-state {
    max-width: 12em;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--banto-text-muted);
  }
  .auth-popover {
    position: absolute;
    top: calc(100% + 5px);
    left: 0;
    width: min(360px, calc(100vw - 24px));
    max-height: calc(100vh - 80px);
    overflow: auto;
    padding: 12px;
    border: 1px solid var(--banto-border);
    border-radius: 6px;
    background: var(--banto-surface);
    color: var(--banto-text);
    box-shadow: 0 10px 28px #0004;
  }
  .auth-form {
    display: grid;
    gap: 8px;
    margin-top: 10px;
  }
  .auth-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 10px;
  }
  .auth-actions button {
    padding: 4px 10px;
    border: 1px solid var(--banto-border);
    border-radius: 4px;
    background: var(--banto-bg);
    color: var(--banto-text);
    font: inherit;
  }
  .auth-popover.align-end {
    left: auto;
    right: 0;
  }
  .auth-popover p {
    margin: 8px 0 0;
    overflow-wrap: anywhere;
  }
  .auth-form p {
    margin: 0;
  }
  .note {
    color: var(--banto-text-muted);
  }
  .failed {
    color: var(--banto-danger, #b42318);
  }
</style>
