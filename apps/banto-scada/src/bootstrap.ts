import "@banto/theme/css";
import "./studio.css";
import { initializeBanto } from "./lib/banto/setup";
import type { NativeAuthClient } from "./native/auth/client";

/**
 * What both entries (`main.ts` Editor, `runtime.ts` Runtime) do before they
 * draw: the desktop's auth client and the Banto UI settings. It imports no
 * screen, so the Runtime bundle does not pull the Editor in (Runtime mode
 * design §6-5).
 */

/** デスクトップでは host の認証 command を使う（host-gate 設計 §6）。 */
async function nativeAuthClient(): Promise<NativeAuthClient> {
  const [{ invoke }, { createNativeAuthClient }] = await Promise.all([
    import("@tauri-apps/api/core"),
    import("./native/auth/client"),
  ]);
  return createNativeAuthClient(invoke);
}

export function isNative(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

/** The auth client on the desktop (none in the browser) and the function that
 * stops watching the UI settings. */
export async function startBanto(): Promise<{
  authClient?: NativeAuthClient;
  stop: () => void;
}> {
  const authClient = isNative() ? await nativeAuthClient() : undefined;
  // UI 設定を復元してから描画する。Web版はオフライン編集を維持する。
  const stop = await initializeBanto(authClient?.provider);
  return { authClient, stop };
}
