// I5d comparison only: overlay the baseline or a replayed candidate without changing workspace files.
import config from "../../apps/banto-scada/vite.config.ts";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const source = process.env.SCADA_I5D_TEXT_SOURCE
  ? readFileSync(process.env.SCADA_I5D_TEXT_SOURCE, "utf8")
  : execFileSync(
      "git",
      ["show", "1e86740:apps/banto-scada/src/lib/TextPrimitive.svelte"],
      { cwd: root, encoding: "utf8" },
    );
export default {
  ...config,
  plugins: [
    {
      name: "i5d-baseline-source",
      enforce: "pre",
      load(id) {
        if (id.endsWith("/src/lib/TextPrimitive.svelte")) return source;
      },
    },
    ...config.plugins,
  ],
};
