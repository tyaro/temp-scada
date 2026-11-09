import { expect, test, type Page } from "@playwright/test";

/**
 * A desktop host with the wire shapes of `scada_host::desktop_auth`
 * (host-gate design §6, §9 step 4-3-3-2): the phase, the auth-disabled mode,
 * the accounts and one session slot.
 */
async function mockAuthHost(
  page: Page,
  initial: { phase?: string; disabled?: boolean; unavailable?: string } = {},
) {
  await page.addInitScript((initial) => {
    type Role = "admin" | "editor" | "viewer";
    interface Account {
      id: number;
      username: string;
      password: string;
      displayName: string;
      role: Role;
    }
    let nextId = 0;
    const host = {
      phase: initial.phase ?? "initializing",
      disabled: initial.disabled ?? true,
      disabledRole: "admin" as Role,
      unavailable: initial.unavailable as string | undefined,
      accounts: [] as Account[],
      signedIn: undefined as Account | undefined,
      seq: 1,
      refuseTransition: undefined as unknown,
      calls: [] as string[],
    };
    Object.assign(window, { __authHost: host });
    const summary = (a: Account) => ({
      id: a.id,
      username: a.username,
      displayName: a.displayName,
      role: a.role,
      createdAt: "2026-11-09 00:00:00",
    });
    const settings = () => ({
      disabled: host.disabled,
      disabledRole: host.disabledRole,
      autologinEnabled: false,
      autologinUsername: null,
    });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {
        transformCallback() {
          return ++nextId;
        },
        async invoke(command: string, args: Record<string, any> = {}) {
          host.calls.push(command);
          if (command === "plugin:event|listen") return ++nextId;
          if (command === "plugin:event|unlisten") return null;
          if (command === "hub_saved_endpoint") return null;
          if (command === "hub_connect")
            return { state: "connected", tagCount: 0 };
          if (command === "hub_read_start" || command === "hub_read_stop")
            return null;
          if (command === "hub_catalog") throw Error("catalog_failed");
          if (host.unavailable)
            throw { kind: "auth_unavailable", reason: host.unavailable };
          switch (command) {
            case "auth_phase":
              return {
                phase: host.phase,
                authDisabled: host.disabled,
                hasAdmin: host.accounts.some((a) => a.role === "admin"),
              };
            case "auth_resolve": {
              const identity = host.disabled
                ? { id: "local", name: "ローカル", role: host.disabledRole }
                : host.signedIn && {
                    id: host.signedIn.username,
                    name: host.signedIn.displayName,
                    role: host.signedIn.role,
                  };
              return {
                identity: identity || null,
                kind: host.disabled ? "local" : identity ? "account" : null,
                checked: host.seq,
                current: host.seq,
                stale: false,
              };
            }
            case "auth_login": {
              const account = host.accounts.find(
                (a) =>
                  a.username === args.username && a.password === args.password,
              );
              if (!account || host.disabled)
                return {
                  success: false,
                  error: "ユーザー名またはパスワードが違います",
                  superseded: false,
                  seq: host.seq,
                };
              host.signedIn = account;
              return {
                success: true,
                error: null,
                superseded: false,
                seq: ++host.seq,
              };
            }
            case "auth_logout":
              host.signedIn = undefined;
              return { seq: ++host.seq };
            case "auth_transition_to_operational": {
              if (host.refuseTransition) throw host.refuseTransition;
              let admin = host.accounts.find((a) => a.role === "admin");
              if (!admin) {
                admin = {
                  id: host.accounts.length + 1,
                  username: args.username,
                  password: args.password,
                  displayName: args.displayName,
                  role: "admin",
                };
                host.accounts.push(admin);
              } else if (admin.password !== args.password)
                throw { kind: "invalid_credentials" };
              host.disabled = false;
              host.phase = "operational";
              host.signedIn = admin;
              return { signedIn: true, seq: ++host.seq };
            }
            case "users_list":
              return host.accounts.map(summary);
            case "users_create": {
              if (host.accounts.some((a) => a.username === args.username))
                throw {
                  kind: "validation",
                  field_errors: [
                    {
                      field: "username",
                      message: "このユーザー名は既に使用されています",
                    },
                  ],
                };
              const account = {
                id: host.accounts.length + 1,
                username: args.username,
                password: args.password,
                displayName: args.displayName,
                role: args.role,
              };
              host.accounts.push(account);
              return summary(account);
            }
            case "users_update": {
              const account = host.accounts.find((a) => a.id === args.id)!;
              account.displayName = args.displayName;
              account.role = args.role;
              return summary(account);
            }
            case "users_reset_password": {
              const account = host.accounts.find((a) => a.id === args.id)!;
              account.password = args.newPassword;
              return null;
            }
            case "users_delete":
              host.accounts = host.accounts.filter((a) => a.id !== args.id);
              return null;
            case "auth_config_get":
              return settings();
            case "auth_config_apply":
              if (args.disabled !== host.disabled)
                throw { kind: "not_allowed" };
              host.disabledRole = args.disabledRole;
              host.seq++;
              return settings();
          }
          throw Error(`Unexpected native command: ${command}`);
        },
      },
    });
  }, initial);
}

const authHost = (page: Page) =>
  page.evaluate(() => (window as any).__authHost);

async function openAuth(page: Page) {
  const summary = page.locator(".auth-control summary");
  await expect(summary).toBeVisible();
  if (!(await page.locator(".auth-control").getAttribute("open")))
    await summary.click();
  return page.locator(".auth-popover");
}

test("the first start moves to operation and manages users from the header", async ({
  page,
}) => {
  await mockAuthHost(page);
  await page.goto("/");
  const popover = await openAuth(page);
  await expect(popover).toContainText("開発・初期設定");
  await expect(popover).toContainText("ログインなし（認証無効モード・管理者）");

  await popover.getByRole("button", { name: "運用へ移行…" }).click();
  const form = popover.getByRole("form", { name: "運用への移行" });
  await form.getByLabel("管理者のユーザー名").fill("admin");
  await form.getByLabel("表示名").fill("管理者A");
  await form.getByLabel("パスワード", { exact: true }).fill("secret-pass");
  await form.getByLabel("パスワード（確認）").fill("other");
  await form.getByRole("button", { name: "運用へ移行" }).click();
  await expect(popover).toContainText("確認用のパスワードが一致しません。");
  expect((await authHost(page)).calls).not.toContain(
    "auth_transition_to_operational",
  );

  await form.getByLabel("パスワード（確認）").fill("secret-pass");
  await form.getByRole("button", { name: "運用へ移行" }).click();
  await expect(popover).toContainText(
    "運用へ移行しました。管理者としてログインしています。",
  );
  await expect(popover).toContainText("管理者A（admin・管理者）");
  await expect(page.locator(".auth-summary-state")).toHaveText("管理者A");

  await popover.getByRole("button", { name: "利用者管理…" }).click();
  const dialog = page.getByRole("dialog", { name: "利用者管理" });
  await expect(
    dialog.getByRole("cell", { name: "admin（自分）" }),
  ).toBeVisible();
  const create = dialog.getByRole("form", { name: "利用者の作成" });
  await create.getByLabel("ユーザー名").fill("op");
  await create.getByLabel("表示名").fill("運転員");
  await create.getByLabel("パスワード").fill("op-pass-1");
  await create.getByRole("button", { name: "作成" }).click();
  await expect(dialog).toContainText("利用者「op」を作成しました。");
  await create.getByLabel("ユーザー名").fill("op");
  await create.getByLabel("パスワード").fill("op-pass-1");
  await create.getByRole("button", { name: "作成" }).click();
  await expect(dialog).toContainText("このユーザー名は既に使用されています");

  await dialog.getByLabel("op の権限").selectOption("editor");
  await dialog
    .getByRole("row", { name: /op/ })
    .getByRole("button", { name: "保存" })
    .click();
  await expect(dialog).toContainText("利用者「op」を更新しました。");
  await dialog.getByLabel("op の新しいパスワード").fill("op-pass-2");
  await dialog.getByRole("button", { name: "再設定" }).nth(1).click();
  await expect(dialog).toContainText("パスワードを再設定しました");
  const host = await authHost(page);
  expect(host.accounts[1]).toMatchObject({
    role: "editor",
    password: "op-pass-2",
  });

  const opRow = dialog.getByRole("row", { name: /op/ });
  await opRow.getByRole("button", { name: "削除" }).click();
  await opRow.getByRole("button", { name: "削除を確定" }).click();
  await expect(dialog).toContainText("利用者「op」を削除しました。");
  await expect(dialog.getByLabel("op の権限")).toHaveCount(0);
});

test("operation asks for a login and a logout ends the session", async ({
  page,
}) => {
  await mockAuthHost(page, { phase: "operational", disabled: false });
  await page.addInitScript(() => {
    (window as any).__authHost.accounts.push({
      id: 1,
      username: "viewer",
      password: "view-pass",
      displayName: "閲覧者A",
      role: "viewer",
    });
  });
  await page.goto("/");
  const popover = await openAuth(page);
  await expect(popover).toContainText("ログインしていません");
  const login = popover.getByRole("form", { name: "ログイン" });
  await login.getByLabel("ユーザー名").fill("viewer");
  await login.getByLabel("パスワード").fill("bad");
  await login.getByRole("button", { name: "ログイン" }).click();
  await expect(popover).toContainText("ユーザー名またはパスワードが違います");

  await login.getByLabel("パスワード").fill("view-pass");
  await login.getByRole("button", { name: "ログイン" }).click();
  await expect(popover).toContainText("閲覧者A（viewer・閲覧者）");
  await expect(
    popover.getByRole("button", { name: "利用者管理…" }),
  ).toHaveCount(0);
  await expect(popover.getByRole("button", { name: "認証設定…" })).toHaveCount(
    0,
  );

  await popover.getByRole("button", { name: "ログアウト" }).click();
  await expect(popover).toContainText("ログインしていません");
  await expect(popover.getByRole("form", { name: "ログイン" })).toBeVisible();
});

test("a refused move and an unfinished move are shown with the re-run", async ({
  page,
}) => {
  await mockAuthHost(page);
  await page.addInitScript(() => {
    (window as any).__authHost.refuseTransition = { kind: "busy" };
  });
  await page.goto("/");
  const popover = await openAuth(page);
  await popover.getByRole("button", { name: "運用へ移行…" }).click();
  const form = popover.getByRole("form", { name: "運用への移行" });
  await form.getByLabel("管理者のユーザー名").fill("admin");
  await form.getByLabel("パスワード", { exact: true }).fill("pw");
  await form.getByLabel("パスワード（確認）").fill("pw");
  await form.getByRole("button", { name: "運用へ移行" }).click();
  await expect(popover).toContainText("作業を破棄するか");
  await expect(popover).toContainText("開発・初期設定");

  await page.evaluate(() => {
    const host = (window as any).__authHost;
    host.refuseTransition = { kind: "save" };
    host.phase = "transitioning";
  });
  await form.getByRole("button", { name: "運用へ移行" }).click();
  await expect(popover).toContainText("運用への移行が完了していません");
  await expect(page.locator(".auth-summary-state")).toHaveText("移行途中");
  await page.evaluate(() => {
    (window as any).__authHost.refuseTransition = undefined;
  });
  const rerun = popover.getByRole("form", { name: "運用への移行" });
  await rerun.getByLabel("管理者のユーザー名").fill("admin");
  await rerun.getByLabel("パスワード", { exact: true }).fill("pw");
  await rerun.getByLabel("パスワード（確認）").fill("pw");
  await rerun.getByRole("button", { name: "移行を再実行" }).click();
  await expect(popover).toContainText("運用へ移行しました。");
  await expect(popover).toContainText("フェーズ: 運用");
});

test("a lowered synthetic role keeps the settings and blocks the move", async ({
  page,
}) => {
  await mockAuthHost(page);
  await page.goto("/");
  const popover = await openAuth(page);
  await popover.getByRole("button", { name: "認証設定…" }).click();
  const dialog = page.getByRole("dialog", { name: "認証設定" });
  await expect(dialog).toContainText("認証無効モード: オン");
  await dialog.getByLabel("認証無効モードの権限").selectOption("viewer");
  await expect(dialog).toContainText("移行する前に管理者へ戻してください");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toContainText("認証設定を保存しました。");
  expect((await authHost(page)).disabledRole).toBe("viewer");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  const reopened = await openAuth(page);
  await expect(reopened).toContainText("認証無効モード・閲覧者");
  await expect(
    reopened.getByRole("button", { name: "運用へ移行…" }),
  ).toHaveCount(0);
  await expect(reopened).toContainText("権限を管理者へ戻してください");
  await expect(
    reopened.getByRole("button", { name: "利用者管理…" }),
  ).toHaveCount(0);
  await expect(
    reopened.getByRole("button", { name: "認証設定…" }),
  ).toBeVisible();
});

test("a failed auth start leaves the editor usable and says why", async ({
  page,
}) => {
  await mockAuthHost(page, { unavailable: "auth_db_missing" });
  await page.goto("/");
  await expect(page.locator(".auth-summary-state")).toHaveText("利用不可");
  const popover = await openAuth(page);
  await expect(popover).toContainText("認証DBがありません");
  await expect(popover).toContainText("画面の編集と読取は使えます");
});
