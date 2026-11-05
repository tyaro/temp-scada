import { mount } from "svelte";
import "@banto/theme/css";
import "./studio.css";
import App from "./App.svelte";
import { initializeBanto } from "./lib/banto/setup";

// UI 設定を復元してから描画する。Web版はオフライン編集を維持する。
const stopWatching = await initializeBanto();
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    stopWatching();
  });
if ("__TAURI_INTERNALS__" in window) {
  const { default: NativeShell } = await import("./native/NativeShell.svelte");
  mount(NativeShell, { target: document.getElementById("app")! });
} else {
  mount(App, { target: document.getElementById("app")! });
}
