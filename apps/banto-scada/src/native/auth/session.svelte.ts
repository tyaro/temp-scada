/**
 * The desktop auth state the header shows (host-gate design §6, §9 step
 * 4-3-3-2): the phase from `auth_phase` and the session from
 * `auth_resolve`, both read from the backend - never a browser-stored
 * value. Every action re-reads both afterwards, since a refusal (a failed
 * move to operation, a reset of one's own password) can change either.
 */
import { isStaleAnswerError, type Identity } from "@banto/admin-core";
import {
  describeError,
  isRole,
  type AuthPhase,
  type NativeAuthClient,
  type Role,
} from "./client";

export interface SessionInfo {
  identity: Identity;
  role: Role | undefined;
  /** `local` is the synthetic session of the auth-disabled mode. */
  kind: string | undefined;
}

export type AuthView =
  | { status: "loading" }
  /** The auth did not start, or its state could not be read. */
  | { status: "unavailable"; message: string }
  | { status: "ready"; phase: AuthPhase; session: SessionInfo | null };

/** The outcome of an action, for the form that started it. */
export interface ActionResult {
  ok: boolean;
  message?: string;
}

/** A resolve answered while the slot moved is retried this many times. */
const RESOLVE_ATTEMPTS = 4;

export function canManageUsers(view: AuthView): boolean {
  return view.status === "ready" && view.session?.role === "admin";
}

/**
 * Banto's escape hatch: while the auth-disabled mode is on, the settings
 * are open to any role, so a lowered synthetic role can be raised again.
 */
export function canEditSettings(view: AuthView): boolean {
  return (
    view.status === "ready" &&
    (view.session?.role === "admin" || view.phase.authDisabled)
  );
}

/** Whether the move to operation can be started (design §6). */
export function canTransition(view: AuthView): boolean {
  if (view.status !== "ready") return false;
  if (view.phase.phase === "transitioning") return true;
  return (
    view.phase.phase === "initializing" &&
    view.phase.authDisabled &&
    view.session?.kind === "local" &&
    view.session.role === "admin"
  );
}

export class AuthSession {
  view: AuthView = $state({ status: "loading" });
  #client: NativeAuthClient;
  #generation = 0;
  #unsubscribe: (() => void) | undefined;

  constructor(client: NativeAuthClient) {
    this.#client = client;
  }

  get client(): NativeAuthClient {
    return this.#client;
  }

  /** Re-read on every credential change the provider observes. */
  start(): () => void {
    this.#unsubscribe ??= this.#client.provider.onCredentialChanged(() => {
      void this.refresh();
    });
    void this.refresh();
    return () => {
      this.#unsubscribe?.();
      this.#unsubscribe = undefined;
      this.#generation++;
    };
  }

  /** Read the phase and the session; a newer read wins over an older one. */
  async refresh(): Promise<void> {
    const generation = ++this.#generation;
    let next: AuthView;
    try {
      const phase = await this.#client.phase();
      next = { status: "ready", phase, session: await this.#resolve() };
    } catch (error) {
      next = { status: "unavailable", message: describeError(error).message };
    }
    if (generation === this.#generation) this.view = next;
  }

  async #resolve(): Promise<SessionInfo | null> {
    for (let attempt = 1; ; attempt++) {
      try {
        const answer = await this.#client.provider.resolve();
        if (answer.status === "none") return null;
        return {
          identity: answer.identity,
          role: isRole(answer.identity.role) ? answer.identity.role : undefined,
          kind: answer.kind,
        };
      } catch (error) {
        if (!isStaleAnswerError(error) || attempt >= RESOLVE_ATTEMPTS)
          throw error;
      }
    }
  }

  async #act(action: () => Promise<ActionResult>): Promise<ActionResult> {
    let result: ActionResult;
    try {
      result = await action();
    } catch (error) {
      result = { ok: false, message: describeError(error).message };
    }
    await this.refresh();
    return result;
  }

  login(username: string, password: string): Promise<ActionResult> {
    return this.#act(async () => {
      const result = await this.#client.provider.login({ username, password });
      if (result.success) return { ok: true };
      return {
        ok: false,
        message: result.superseded
          ? "別の操作でログイン状態が変わりました。状態を確認してください。"
          : (result.error ?? "ログインできませんでした。"),
      };
    });
  }

  logout(): Promise<ActionResult> {
    return this.#act(async () => {
      await this.#client.provider.logout();
      return { ok: true };
    });
  }

  changePassword(current: string, next: string): Promise<ActionResult> {
    return this.#act(async () => {
      const result = await this.#client.provider.changePassword!(current, next);
      return result.success
        ? { ok: true, message: "パスワードを変更しました。" }
        : {
            ok: false,
            message: result.error ?? "パスワードを変更できません。",
          };
    });
  }

  /** `auth_transition_to_operational` (design §6), also its re-run. */
  transitionToOperational(
    username: string,
    password: string,
    displayName: string,
  ): Promise<ActionResult> {
    return this.#act(async () => {
      const result = await this.#client.transitionToOperational(
        username,
        password,
        displayName,
      );
      return {
        ok: true,
        message: result.signedIn
          ? "運用へ移行しました。管理者としてログインしています。"
          : "運用へ移行しました。ログインしてください。",
      };
    });
  }
}
