import { mount } from "svelte";
import "@banto/theme/css";
import "./studio.css";
import App from "./App.svelte";
import { initializeBanto } from "./lib/banto/setup";

// UI 設定を復元してから描画する。Hub / 認証サーバーには接続しない。
const stopWatching = await initializeBanto();
if (import.meta.hot) import.meta.hot.dispose(stopWatching);
mount(App, { target: document.getElementById("app")! });
