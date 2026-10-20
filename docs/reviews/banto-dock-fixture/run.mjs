import {
  cpSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const fixture = dirname(fileURLToPath(import.meta.url));
const repo = resolve(fixture, "../../..");
const source = process.env.BANTO_SOURCE_DIR;
if (!source)
  throw new Error("Set BANTO_SOURCE_DIR to an existing Banto source checkout.");
const port = Number(process.env.DOCK_EVALUATION_PORT ?? 5229);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Invalid port");
const root = mkdtempSync(join(tmpdir(), "scada-dock-evaluation-"));
for (const pkg of ["dock-svelte", "theme"]) {
  cpSync(
    join(resolve(source), "packages", pkg),
    join(root, "banto/packages", pkg),
    {
      recursive: true,
      filter: (path) => !path.split("/").includes("node_modules"),
    },
  );
}
symlinkSync(
  join(repo, "apps/banto-scada/node_modules"),
  join(root, "node_modules"),
  "dir",
);
const replacements = {
  __SCADA_ROOT__: repo,
  __PLAYWRIGHT_MODULE__: join(repo, "node_modules/@playwright/test/index.mjs"),
  __RESULTS_FILE__: join(root, "results.json"),
  __PORT__: String(port),
};
for (const name of ["App.svelte", "Probe.svelte", "main.ts", "probe.mjs"]) {
  let content = readFileSync(join(fixture, name), "utf8");
  for (const [token, value] of Object.entries(replacements))
    content = content.replaceAll(token, value);
  const target = name === "probe.mjs" ? root : join(root, "harness");
  // cp creates the harness directory before writing the generated source.
  cpSync(join(fixture, name), join(target, name), { recursive: true });
  writeFileSync(join(target, name), content);
}
writeFileSync(
  join(root, "package.json"),
  JSON.stringify({ private: true, type: "module" }),
);
writeFileSync(
  join(root, "index.html"),
  '<div id="app"></div><script type="module" src="/harness/main.ts"></script>',
);
writeFileSync(
  join(root, "vite.config.mjs"),
  `
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
export default defineConfig({plugins:[svelte()],server:{host:'127.0.0.1',port:${port},strictPort:true,fs:{allow:${JSON.stringify([root, repo])}}}});
`,
);
const vite = spawn(
  process.execPath,
  [
    join(repo, "apps/banto-scada/node_modules/vite/bin/vite.js"),
    "--config",
    join(root, "vite.config.mjs"),
  ],
  { cwd: root, stdio: "inherit" },
);
const stop = () => vite.kill("SIGTERM");
process.once("SIGINT", () => {
  stop();
  process.exit(130);
});
process.once("SIGTERM", () => {
  stop();
  process.exit(143);
});
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (vite.exitCode !== null)
      throw new Error("Vite exited before becoming ready");
    try {
      ready = (
        await fetch(`http://127.0.0.1:${port}`, {
          signal: AbortSignal.timeout(500),
        })
      ).ok;
    } catch {}
    if (ready) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  if (!ready) throw new Error("Vite did not become ready");
  const exitCode = await new Promise((done, reject) => {
    const child = spawn(process.execPath, [join(root, "probe.mjs")], {
      cwd: root,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => done(code ?? 1));
  });
  if (exitCode !== 0) throw new Error(`Probe exited with ${exitCode}`);
  console.log(`Observations saved: ${join(root, "results.json")}`);
} finally {
  stop();
}
