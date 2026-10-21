// I5c comparison only: on the I5c candidate tree, restore the two changed runtime
// files in Vite's loader without replacing workspace files or creating a worktree.
import config from "../../apps/banto-scada/vite.config.ts";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const sources = new Map(
  [
    "apps/banto-scada/src/App.svelte",
    "apps/banto-scada/src/lib/designer/controllers/project-files.svelte.ts",
  ].map((path) => [
    path,
    execFileSync("git", ["show", `a17fc96:${path}`], {
      cwd: root,
      encoding: "utf8",
    }),
  ]),
);
export default {
  ...config,
  plugins: [
    {
      name: "i5c-baseline-source",
      enforce: "pre",
      load(id) {
        for (const [path, source] of sources)
          if (id.endsWith(`/${path}`)) return source;
      },
    },
    ...config.plugins,
  ],
};
