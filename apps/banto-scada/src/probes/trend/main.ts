import { mount } from "svelte";
import "@banto/theme/css";
import { applyTheme } from "@banto/theme";
import "../../studio.css";
import TrendProbe from "./TrendProbe.svelte";

// Issue #359 の実証ページ（開発用、`pnpm dev` の /probes/trend.html）。
// 製品の入口とは別で、ビルドの入力にも入れない。製品のコードはこのディレクトリを import しない。
const theme = new URLSearchParams(location.search).get("theme");
applyTheme(theme === "dark" ? "dark" : "light");
mount(TrendProbe, { target: document.getElementById("app")! });
