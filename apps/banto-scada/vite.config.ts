import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
export default defineConfig({
  plugins: [svelte()],
  // Banto は .svelte.ts を含むソース配布。公式 ADR-0007 に従い事前バンドルを除外。
  optimizeDeps: { exclude: ["@banto/admin-core", "@banto/ui"] },
  server: { port: 5173, strictPort: true },
  test: { include: ["src/**/*.test.ts"] },
});
