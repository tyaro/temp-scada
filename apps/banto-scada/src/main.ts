import { installDesignerMenuViewport } from "./lib/designer/menu-viewport";
import { mount } from "svelte";
import "@banto/theme/css";
import "./studio.css";
import App from "./App.svelte";
import { initializeBanto } from "./lib/banto/setup";

// UI 設定を復元してから描画する。Hub / 認証サーバーには接続しない。
const stopWatching = await initializeBanto();
const stopMenuViewport = installDesignerMenuViewport();
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    stopWatching();
    stopMenuViewport();
  });
mount(App, { target: document.getElementById("app")! });
