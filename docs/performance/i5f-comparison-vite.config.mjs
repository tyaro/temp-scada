// I5f comparison only: replay the App source without changing workspace files.
import config from "../../apps/banto-scada/vite.config.ts";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const source = process.env.SCADA_I5F_APP_SOURCE
  ? readFileSync(process.env.SCADA_I5F_APP_SOURCE, "utf8")
  : execFileSync("git", ["show", "e9c5d46:apps/banto-scada/src/App.svelte"], {
      cwd: root,
      encoding: "utf8",
    });
export default {
  ...config,
  plugins: [
    {
      name: "i5f-measure-source",
      enforce: "pre",
      load(id) {
        if (id.endsWith("/src/App.svelte")) return source;
      },
    },
    ...config.plugins,
  ],
};
