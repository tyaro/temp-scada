import { mount } from "svelte";
import "@banto/theme/css";
import { applyTheme } from "@banto/theme";
import "../../studio.css";
import DockProbe from "./DockProbe.svelte";

// Issue #331 D1 の実証ページ（開発用、`pnpm dev` の /probes/dock.html）。
// 製品の入口（src/main.ts・runtime.html）とは別で、ビルドの入力にも入れない。
// 製品のコードはこのディレクトリを import しない。
const theme = new URLSearchParams(location.search).get("theme");
applyTheme(theme === "dark" ? "dark" : "light");
mount(DockProbe, { target: document.getElementById("app")! });
