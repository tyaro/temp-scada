// I5e comparison only: replay the helper source without changing workspace files.
import config from "../../apps/banto-scada/vite.config.ts";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const source = process.env.SCADA_I5E_MEASURE_SOURCE
  ? readFileSync(process.env.SCADA_I5E_MEASURE_SOURCE, "utf8")
  : execFileSync(
      "git",
      ["show", "9563504:apps/banto-scada/src/lib/svg-text-measure.ts"],
      { cwd: root, encoding: "utf8" },
    );
export default {
  ...config,
  plugins: [
    {
      name: "i5e-measure-source",
      enforce: "pre",
      load(id) {
        if (id.endsWith("/src/lib/svg-text-measure.ts")) return source;
      },
    },
    ...config.plugins,
  ],
};
