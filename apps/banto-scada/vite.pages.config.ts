import { defineConfig, loadEnv } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// GitHub Pages 向けのビルド。入口は pages/ の index.html（トップページ）と demo.html（デモ）で、
// 製品のビルド（vite.config.ts、入口は index.html）とは出力先も入口も分ける。
// base は Pages の公開先（https://<owner>.github.io/temp-scada/）。別の場所へ置くときは
// 環境変数 PAGES_BASE で差し替える。パスは apps/banto-scada（pnpm の実行場所）から数える。
export default defineConfig(({ mode }) => ({
  root: "pages",
  base: loadEnv(mode, ".", "PAGES_").PAGES_BASE ?? "/temp-scada/",
  plugins: [svelte()],
  optimizeDeps: { exclude: ["@banto/admin-core", "@banto/ui"] },
  build: {
    outDir: "../dist-pages",
    emptyOutDir: true,
    rollupOptions: {
      input: { index: "pages/index.html", demo: "pages/demo.html" },
    },
  },
}));
