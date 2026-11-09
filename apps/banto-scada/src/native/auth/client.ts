/**
 * The desktop auth commands of this host (host-gate design §5, §6, §9 step
 * 4-3). Session changes (login, logout, password change, first-run setup)
 * go through Banto's `createTauriAuthProvider`, which tracks the credential
 * revision. The host's own commands (`auth_phase`, the move to operation)
 * and the user-management and auth-settings commands are called directly.
 *
 * Every error is turned into a Japanese message here, so the screens never
 * show a raw wire value.
 */
import {
  createTauriAuthProvider,
  isProviderError,
  type AuthProvider,
  type ErrorBody,
} from "@banto/admin-core";

export type Invoke = (
  cmd: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

export type Role = "admin" | "editor" | "viewer";
export const ROLES: readonly Role[] = ["admin", "editor", "viewer"];
const ROLE_LABELS: Record<Role, string> = {
  admin: "管理者",
  editor: "編集者",
  viewer: "閲覧者",
};

export function isRole(value: unknown): value is Role {
  return value === "admin" || value === "editor" || value === "viewer";
}

export function roleLabel(role: unknown): string {
  return isRole(role) ? ROLE_LABELS[role] : "不明な権限";
}

/** `auth_phase`: which screen to show (design §6). */
export interface AuthPhase {
  phase: "initializing" | "transitioning" | "operational";
  authDisabled: boolean;
  hasAdmin: boolean;
}

export interface UserSummary {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  createdAt: string;
}

export interface AuthSettings {
  disabled: boolean;
  disabledRole: Role;
}

export interface TransitionResult {
  signedIn: boolean;
}

/** A refusal or failure of a command, with the message to show. */
export class AuthCommandError extends Error {
  /** The wire `kind`, or `undefined` when the command did not answer. */
  readonly kind: string | undefined;
  constructor(kind: string | undefined, message: string) {
    super(message);
    this.name = "AuthCommandError";
    this.kind = kind;
  }
}

const STARTUP_REASONS: Record<string, string> = {
  in_use: "認証は別のアプリが使用中です。もう一つの起動を終了してください。",
  phase_unreadable: "認証フェーズの記録を読み取れません。",
  phase_corrupt: "認証フェーズの記録が壊れています。",
  phase_lost:
    "認証フェーズの記録がありません（認証DBだけがあります）。記録の変更は使えません。",
  auth_db_missing:
    "認証DBがありません。安全のため作り直しません。記録の変更は使えません。",
  save: "認証フェーズを保存できません。",
  auth_db: "認証DBを開けません。",
};

const HOST_REFUSALS: Record<string, string> = {
  not_allowed: "現在の状態ではこの操作はできません。",
  busy: "記録の変更作業が終わっていません。作業を破棄するか、完了を待ってから実行してください。",
  invalid_credentials: "ユーザー名またはパスワードが違います。",
  not_admin: "このアカウントは管理者ではありません。",
  save: "保存できませんでした。もう一度実行してください。",
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function describeBody(body: ErrorBody): string {
  switch (body.kind) {
    case "validation":
      return body.field_errors[0]?.message ?? "入力内容を確認してください。";
    case "unauthorized":
      return "ログインが必要です。セッションは終了しています。";
    case "forbidden":
      return "この操作を行う権限がありません。";
    case "not_found":
      return "対象が見つかりません。一覧を読み直してください。";
    case "bad_request":
      return `要求が不正です: ${body.message}`;
    case "storage":
      return `認証DBへ保存できません: ${body.message}`;
    case "other":
      return body.message;
  }
}

/** The message and `kind` of anything a command rejected with. */
export function describeError(raw: unknown): AuthCommandError {
  if (raw instanceof AuthCommandError) return raw;
  if (isProviderError(raw))
    return new AuthCommandError(raw.body.kind, describeBody(raw.body));
  if (isObject(raw) && typeof raw.kind === "string") {
    const kind = raw.kind;
    if (kind === "auth_unavailable") {
      const reason = typeof raw.reason === "string" ? raw.reason : "";
      return new AuthCommandError(
        kind,
        STARTUP_REASONS[reason] ??
          `認証を開始できません（${reason || "理由不明"}）。`,
      );
    }
    if (kind in HOST_REFUSALS)
      return new AuthCommandError(kind, HOST_REFUSALS[kind]);
    if (kind === "validation" && Array.isArray(raw.field_errors))
      return new AuthCommandError(kind, describeBody(raw as ErrorBody));
    if (kind === "unauthorized" || kind === "forbidden" || kind === "not_found")
      return new AuthCommandError(kind, describeBody(raw as ErrorBody));
    if (
      (kind === "bad_request" || kind === "storage" || kind === "other") &&
      typeof raw.message === "string"
    )
      return new AuthCommandError(kind, describeBody(raw as ErrorBody));
    return new AuthCommandError(kind, `認証の操作に失敗しました（${kind}）。`);
  }
  return new AuthCommandError(
    undefined,
    "ホストから応答がありません。状態を読み直してください。",
  );
}

/**
 * The provider reads only Banto's error kinds. The host's own refusals
 * (`auth_unavailable`, ...) are passed on as an `Error` carrying the
 * Japanese message; the provider then treats the outcome as unknown and
 * advances its revision, which only makes the next resolve re-check.
 */
function providerInvoke(invoke: Invoke): Invoke {
  return async (cmd, args) => {
    try {
      return await invoke(cmd, args);
    } catch (raw) {
      if (isObject(raw) && raw.kind === "auth_unavailable")
        throw new Error(describeError(raw).message);
      throw raw;
    }
  };
}

function parsePhase(value: unknown): AuthPhase {
  if (
    isObject(value) &&
    (value.phase === "initializing" ||
      value.phase === "transitioning" ||
      value.phase === "operational") &&
    typeof value.authDisabled === "boolean" &&
    typeof value.hasAdmin === "boolean"
  )
    return {
      phase: value.phase,
      authDisabled: value.authDisabled,
      hasAdmin: value.hasAdmin,
    };
  throw new AuthCommandError("invalid_reply", "認証フェーズの応答が不正です。");
}

function parseUser(value: unknown): UserSummary {
  if (
    isObject(value) &&
    typeof value.id === "number" &&
    typeof value.username === "string" &&
    typeof value.displayName === "string" &&
    isRole(value.role)
  )
    return {
      id: value.id,
      username: value.username,
      displayName: value.displayName,
      role: value.role,
      createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
    };
  throw new AuthCommandError("invalid_reply", "利用者の応答が不正です。");
}

function parseSettings(value: unknown): AuthSettings {
  if (
    isObject(value) &&
    typeof value.disabled === "boolean" &&
    isRole(value.disabledRole)
  )
    return { disabled: value.disabled, disabledRole: value.disabledRole };
  throw new AuthCommandError("invalid_reply", "認証設定の応答が不正です。");
}

export interface NativeAuthClient {
  readonly provider: AuthProvider;
  phase(): Promise<AuthPhase>;
  transitionToOperational(
    username: string,
    password: string,
    displayName: string,
  ): Promise<TransitionResult>;
  usersList(): Promise<UserSummary[]>;
  usersCreate(
    username: string,
    password: string,
    displayName: string,
    role: Role,
  ): Promise<void>;
  usersUpdate(id: number, displayName: string, role: Role): Promise<void>;
  usersResetPassword(id: number, newPassword: string): Promise<void>;
  usersDelete(id: number): Promise<void>;
  authConfigGet(): Promise<AuthSettings>;
  authConfigApply(disabled: boolean, disabledRole: Role): Promise<AuthSettings>;
}

export function createNativeAuthClient(invoke: Invoke): NativeAuthClient {
  async function call(cmd: string, args?: Record<string, unknown>) {
    try {
      return await invoke(cmd, args);
    } catch (raw) {
      throw describeError(raw);
    }
  }
  return {
    provider: createTauriAuthProvider({ invoke: providerInvoke(invoke) }),
    async phase() {
      return parsePhase(await call("auth_phase"));
    },
    async transitionToOperational(username, password, displayName) {
      const result = await call("auth_transition_to_operational", {
        username,
        password,
        displayName,
      });
      return { signedIn: isObject(result) && result.signedIn === true };
    },
    async usersList() {
      const result = await call("users_list");
      if (!Array.isArray(result))
        throw new AuthCommandError(
          "invalid_reply",
          "利用者一覧の応答が不正です。",
        );
      return result.map(parseUser);
    },
    async usersCreate(username, password, displayName, role) {
      await call("users_create", { username, password, displayName, role });
    },
    async usersUpdate(id, displayName, role) {
      await call("users_update", { id, displayName, role });
    },
    async usersResetPassword(id, newPassword) {
      await call("users_reset_password", { id, newPassword });
    },
    async usersDelete(id) {
      await call("users_delete", { id });
    },
    async authConfigGet() {
      return parseSettings(await call("auth_config_get"));
    },
    async authConfigApply(disabled, disabledRole) {
      return parseSettings(
        await call("auth_config_apply", { disabled, disabledRole }),
      );
    },
  };
}
