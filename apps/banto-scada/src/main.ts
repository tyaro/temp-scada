import { mount } from "svelte";
import "@banto/theme/css";
import "./studio.css";
import App from "./App.svelte";
import { initializeBanto } from "./lib/banto/setup";

/** デスクトップでは host の認証 command を使う（host-gate 設計 §6）。 */
async function nativeAuthClient() {
  const [{ invoke }, { createNativeAuthClient }] = await Promise.all([
    import("@tauri-apps/api/core"),
    import("./native/auth/client"),
  ]);
  return createNativeAuthClient(invoke);
}

const authClient =
  "__TAURI_INTERNALS__" in window ? await nativeAuthClient() : undefined;
// UI 設定を復元してから描画する。Web版はオフライン編集を維持する。
const stopWatching = await initializeBanto(authClient?.provider);
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    stopWatching();
  });
if ("__TAURI_INTERNALS__" in window) {
  const { default: NativeShell } = await import("./native/NativeShell.svelte");
  mount(NativeShell, {
    target: document.getElementById("app")!,
    props: { authClient: authClient! },
  });
} else {
  mount(App, { target: document.getElementById("app")! });
}
