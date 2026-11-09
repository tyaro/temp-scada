import { describe, expect, it } from "vitest";
import {
  AuthCommandError,
  createNativeAuthClient,
  describeError,
  type Role,
} from "./client";
import {
  AuthSession,
  canEditSettings,
  canManageUsers,
  canTransition,
} from "./session.svelte";

interface Account {
  id: number;
  username: string;
  password: string;
  displayName: string;
  role: Role;
}

/**
 * A host with the wire shapes of `scada_host::desktop_auth`: the phase, the
 * auth-disabled mode and one session slot whose `seq` advances on change.
 */
function fakeHost() {
  const host = {
    phase: "initializing" as "initializing" | "transitioning" | "operational",
    disabled: true,
    disabledRole: "admin" as Role,
    accounts: [] as Account[],
    signedIn: undefined as Account | undefined,
    seq: 1,
    unavailable: undefined as string | undefined,
    staleResolves: 0,
    refuseTransition: undefined as unknown,
    calls: [] as { cmd: string; args?: Record<string, unknown> }[],
  };
  const summary = (a: Account) => ({
    id: a.id,
    username: a.username,
    displayName: a.displayName,
    role: a.role,
    createdAt: "2026-11-09 00:00:00",
  });
  async function invoke(cmd: string, args?: Record<string, unknown>) {
    host.calls.push({ cmd, args });
    if (host.unavailable)
      throw { kind: "auth_unavailable", reason: host.unavailable };
    const a = args ?? {};
    switch (cmd) {
      case "auth_phase":
        return {
          phase: host.phase,
          authDisabled: host.disabled,
          hasAdmin: host.accounts.some((x) => x.role === "admin"),
        };
      case "auth_resolve": {
        if (host.staleResolves > 0) {
          host.staleResolves--;
          host.seq++;
          return {
            identity: null,
            kind: null,
            checked: host.seq - 1,
            current: host.seq,
            stale: true,
          };
        }
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
          (x) => x.username === a.username && x.password === a.password,
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
      case "auth_change_password":
        if (host.signedIn?.password !== a.currentPassword)
          throw {
            kind: "validation",
            field_errors: [
              {
                field: "currentPassword",
                message: "現在のパスワードが違います",
              },
            ],
          };
        host.signedIn!.password = a.newPassword as string;
        return { seq: ++host.seq };
      case "auth_transition_to_operational": {
        if (host.refuseTransition) throw host.refuseTransition;
        let admin = host.accounts.find((x) => x.role === "admin");
        if (!admin) {
          admin = {
            id: host.accounts.length + 1,
            username: a.username as string,
            password: a.password as string,
            displayName: a.displayName as string,
            role: "admin",
          };
          host.accounts.push(admin);
        } else if (admin.password !== a.password)
          throw { kind: "invalid_credentials" };
        host.disabled = false;
        host.phase = "operational";
        host.signedIn = admin;
        host.seq++;
        return { signedIn: true, seq: host.seq };
      }
      case "users_list":
        return host.accounts.map(summary);
      case "users_create": {
        const account = {
          id: host.accounts.length + 1,
          username: a.username as string,
          password: a.password as string,
          displayName: a.displayName as string,
          role: a.role as Role,
        };
        host.accounts.push(account);
        return summary(account);
      }
      case "users_update": {
        const account = host.accounts.find((x) => x.id === a.id);
        if (!account) throw { kind: "not_found", resource: "users", id: "x" };
        if (account === host.signedIn && a.role !== "admin")
          throw { kind: "busy" };
        account.displayName = a.displayName as string;
        account.role = a.role as Role;
        return summary(account);
      }
      case "users_reset_password": {
        const account = host.accounts.find((x) => x.id === a.id)!;
        account.password = a.newPassword as string;
        if (account === host.signedIn) {
          host.signedIn = undefined;
          host.seq++;
        }
        return null;
      }
      case "users_delete":
        host.accounts = host.accounts.filter((x) => x.id !== a.id);
        return null;
      case "auth_config_get":
        return {
          disabled: host.disabled,
          disabledRole: host.disabledRole,
          autologinEnabled: false,
          autologinUsername: null,
        };
      case "auth_config_apply":
        if (a.disabled !== host.disabled) throw { kind: "not_allowed" };
        host.disabledRole = a.disabledRole as Role;
        host.seq++;
        return {
          disabled: host.disabled,
          disabledRole: host.disabledRole,
          autologinEnabled: false,
          autologinUsername: null,
        };
    }
    throw new Error(`unexpected ${cmd}`);
  }
  const client = createNativeAuthClient(invoke);
  return { host, client, session: new AuthSession(client) };
}

describe("describeError", () => {
  it("turns every host refusal and Banto error into a message", () => {
    expect(describeError({ kind: "busy" }).message).toContain(
      "記録の変更作業が終わっていません",
    );
    expect(describeError({ kind: "not_allowed" }).kind).toBe("not_allowed");
    expect(describeError({ kind: "invalid_credentials" }).message).toBe(
      "ユーザー名またはパスワードが違います。",
    );
    expect(describeError({ kind: "not_admin" }).message).toContain("管理者");
    expect(
      describeError({ kind: "auth_unavailable", reason: "auth_db_missing" })
        .message,
    ).toContain("認証DBがありません");
    expect(
      describeError({ kind: "auth_unavailable", reason: "new_reason" }).message,
    ).toContain("new_reason");
    expect(
      describeError({
        kind: "validation",
        field_errors: [{ field: "username", message: "既に使用されています" }],
      }).message,
    ).toBe("既に使用されています");
    expect(describeError({ kind: "forbidden" }).message).toContain("権限");
    expect(
      describeError({ kind: "storage", message: "disk" }).message,
    ).toContain("disk");
    expect(describeError({ kind: "unknown_kind" }).message).toContain(
      "unknown_kind",
    );
    const lost = describeError(new Error("ipc"));
    expect(lost).toBeInstanceOf(AuthCommandError);
    expect(lost.kind).toBeUndefined();
  });
});

describe("AuthSession", () => {
  it("shows the auth-disabled session of the first start and allows the move", async () => {
    const { session } = fakeHost();
    await session.refresh();
    expect(session.view).toMatchObject({
      status: "ready",
      phase: { phase: "initializing", authDisabled: true, hasAdmin: false },
      session: { kind: "local", role: "admin" },
    });
    expect(canTransition(session.view)).toBe(true);
    expect(canManageUsers(session.view)).toBe(true);
    expect(canEditSettings(session.view)).toBe(true);
  });

  it("moves to operation with the first administrator and signs in", async () => {
    const { host, session } = fakeHost();
    await session.refresh();
    const result = await session.transitionToOperational(
      "admin",
      "secret-pass",
      "管理者",
    );
    expect(result.ok).toBe(true);
    expect(
      host.calls.find((c) => c.cmd === "auth_transition_to_operational")?.args,
    ).toEqual({
      username: "admin",
      password: "secret-pass",
      displayName: "管理者",
    });
    expect(session.view).toMatchObject({
      status: "ready",
      phase: { phase: "operational", authDisabled: false, hasAdmin: true },
      session: {
        kind: "account",
        role: "admin",
        identity: { id: "admin", name: "管理者" },
      },
    });
    expect(canTransition(session.view)).toBe(false);
  });

  it("keeps the phase and shows why when the move is refused", async () => {
    const { host, session } = fakeHost();
    await session.refresh();
    host.refuseTransition = { kind: "busy" };
    const busy = await session.transitionToOperational("admin", "pw", "");
    expect(busy.ok).toBe(false);
    expect(busy.message).toContain("作業を破棄するか");
    expect(session.view).toMatchObject({ phase: { phase: "initializing" } });

    // A save failure after step 1 leaves `transitioning`: the re-run is
    // offered whatever the session (design §6).
    host.refuseTransition = { kind: "save" };
    host.phase = "transitioning";
    await session.transitionToOperational("admin", "pw", "");
    expect(session.view).toMatchObject({ phase: { phase: "transitioning" } });
    expect(canTransition(session.view)).toBe(true);
    host.refuseTransition = undefined;
    expect((await session.transitionToOperational("admin", "pw", "")).ok).toBe(
      true,
    );
    expect(session.view).toMatchObject({ phase: { phase: "operational" } });
  });

  it("logs in, changes the password and logs out in operation", async () => {
    const { host, session } = fakeHost();
    host.phase = "operational";
    host.disabled = false;
    host.accounts.push({
      id: 1,
      username: "op",
      password: "pw-1",
      displayName: "運転員",
      role: "viewer",
    });
    await session.refresh();
    expect(session.view).toMatchObject({ status: "ready", session: null });

    const wrong = await session.login("op", "nope");
    expect(wrong).toEqual({
      ok: false,
      message: "ユーザー名またはパスワードが違います",
    });
    expect((await session.login("op", "pw-1")).ok).toBe(true);
    expect(session.view).toMatchObject({
      session: { kind: "account", role: "viewer" },
    });
    expect(canManageUsers(session.view)).toBe(false);
    expect(canEditSettings(session.view)).toBe(false);

    const refused = await session.changePassword("bad", "pw-2");
    expect(refused).toEqual({
      ok: false,
      message: "現在のパスワードが違います",
    });
    expect((await session.changePassword("pw-1", "pw-2")).ok).toBe(true);
    expect(host.accounts[0].password).toBe("pw-2");

    await session.logout();
    expect(session.view).toMatchObject({ status: "ready", session: null });
  });

  it("re-reads on a stale resolve and reports a failed start", async () => {
    const { host, session } = fakeHost();
    host.staleResolves = 2;
    await session.refresh();
    expect(session.view).toMatchObject({
      status: "ready",
      session: { kind: "local" },
    });

    host.unavailable = "in_use";
    await session.refresh();
    expect(session.view).toEqual({
      status: "unavailable",
      message:
        "認証は別のアプリが使用中です。もう一つの起動を終了してください。",
    });
  });

  it("offers the settings but not the move once the synthetic role is lowered", async () => {
    const { host, session, client } = fakeHost();
    await session.refresh();
    expect(await client.authConfigApply(true, "viewer")).toEqual({
      disabled: true,
      disabledRole: "viewer",
    });
    await session.refresh();
    expect(canTransition(session.view)).toBe(false);
    expect(canManageUsers(session.view)).toBe(false);
    expect(canEditSettings(session.view)).toBe(true);
    await expect(client.authConfigApply(false, "admin")).rejects.toMatchObject({
      kind: "not_allowed",
    });
    expect(host.disabledRole).toBe("viewer");
  });

  it("re-reads the session when the credential changes elsewhere", async () => {
    const { host, session, client } = fakeHost();
    host.phase = "operational";
    host.disabled = false;
    host.accounts.push({
      id: 1,
      username: "admin",
      password: "pw",
      displayName: "管理者",
      role: "admin",
    });
    const stop = session.start();
    await expect.poll(() => session.view.status).toBe("ready");
    await client.provider.login({ username: "admin", password: "pw" });
    await expect
      .poll(() => session.view.status === "ready" && session.view.session?.kind)
      .toBe("account");
    stop();
  });
});

describe("user management commands", () => {
  it("sends Banto's arguments and reads the summaries", async () => {
    const { host, client } = fakeHost();
    await client.usersCreate("op", "pw", "運転員", "viewer");
    expect(host.calls.at(-1)).toEqual({
      cmd: "users_create",
      args: {
        username: "op",
        password: "pw",
        displayName: "運転員",
        role: "viewer",
      },
    });
    expect(await client.usersList()).toEqual([
      {
        id: 1,
        username: "op",
        displayName: "運転員",
        role: "viewer",
        createdAt: "2026-11-09 00:00:00",
      },
    ]);
    await client.usersUpdate(1, "運転員A", "editor");
    expect(host.calls.at(-1)?.args).toEqual({
      id: 1,
      displayName: "運転員A",
      role: "editor",
    });
    await client.usersResetPassword(1, "pw-2");
    expect(host.calls.at(-1)?.args).toEqual({ id: 1, newPassword: "pw-2" });
    await client.usersDelete(1);
    expect(host.calls.at(-1)?.args).toEqual({ id: 1 });
    await expect(client.usersUpdate(9, "x", "viewer")).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  it("ends the own session on a reset of the own password", async () => {
    const { host, session, client } = fakeHost();
    host.phase = "operational";
    host.disabled = false;
    host.accounts.push({
      id: 1,
      username: "admin",
      password: "pw",
      displayName: "管理者",
      role: "admin",
    });
    await session.login("admin", "pw");
    await client.usersResetPassword(1, "pw-2");
    await session.refresh();
    expect(session.view).toMatchObject({ status: "ready", session: null });
  });
});
