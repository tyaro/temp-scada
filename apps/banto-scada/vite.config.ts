import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
export default defineConfig({
  plugins: [svelte()],
  // Banto は .svelte.ts を含むソース配布。公式 ADR-0007 に従い事前バンドルを除外。
  optimizeDeps: {
    exclude: [
      "@banto/admin-core",
      "@banto/dock-svelte",
      "@banto/image-assets",
      "@banto/ui",
    ],
  },
  server: { port: 5173, strictPort: true },
  // Two windows, two entries: Editor (index.html) and Runtime (runtime.html,
  // Runtime mode design §6-5). runtime.html never loads the Editor bundle.
  build: {
    rollupOptions: {
      input: {
        index: "index.html",
        runtime: "runtime.html",
      },
    },
  },
  test: { include: ["src/**/*.test.ts"] },
});
