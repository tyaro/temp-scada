/** Maps a diagnostic CPU profile using the source-map reader already shipped with Svelte. */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { resolve, basename } from "node:path";
const require = createRequire(import.meta.url);
const { SourceMapConsumer } = createRequire(
  require.resolve("svelte/package.json"),
)("source-map-js");
const [input, build] = process.argv.slice(2);
assert(
  input && build,
  "Usage: summarize-editor-profile.mjs profile.cpuprofile build-directory",
);
const profile = JSON.parse(await readFile(input, "utf8"));
const maps = new Map();
const sourceMapHashes = {};
for (const name of await readdir(resolve(build, "assets"))) {
  if (name.endsWith(".js.map")) {
    const bytes = await readFile(resolve(build, "assets", name));
    sourceMapHashes[name] = createHash("sha256").update(bytes).digest("hex");
    maps.set(
      name.slice(0, -4),
      new SourceMapConsumer(JSON.parse(bytes.toString("utf8"))),
    );
  }
}
const parents = new Map();
for (const node of profile.nodes)
  for (const child of node.children ?? []) parents.set(child, node.id);
const labels = new Map();
for (const node of profile.nodes) {
  const frame = node.callFrame;
  const map = maps.get(basename(frame.url));
  const original = map?.originalPositionFor({
    line: frame.lineNumber + 1,
    column: frame.columnNumber,
  });
  const source = original?.source ?? (frame.url || "(native)");
  labels.set(node.id, {
    source,
    location: `${source}:${original?.line ?? frame.lineNumber + 1}:${original?.column ?? frame.columnNumber}`,
    function: original?.name ?? frame.functionName,
    mapped: Boolean(original?.source),
  });
}
const files = new Map(),
  functions = new Map();
function add(table, label, field, us) {
  const row = table.get(label) ?? { selfUs: 0, inclusiveUs: 0 };
  row[field] += us;
  table.set(label, row);
}
for (let index = 0; index < profile.samples.length; index++) {
  const id = profile.samples[index],
    us = profile.timeDeltas[index];
  const label = labels.get(id);
  add(files, label.source, "selfUs", us);
  add(functions, `${label.location} ${label.function}`, "selfUs", us);
  const seenFiles = new Set(),
    seenFunctions = new Set();
  for (
    let current = id;
    current !== undefined;
    current = parents.get(current)
  ) {
    const ancestor = labels.get(current);
    seenFiles.add(ancestor.source);
    seenFunctions.add(`${ancestor.location} ${ancestor.function}`);
  }
  for (const file of seenFiles) add(files, file, "inclusiveUs", us);
  for (const fn of seenFunctions) add(functions, fn, "inclusiveUs", us);
}
const sorted = (table, field) =>
  [...table]
    .map(([label, times]) => ({ label, ...times }))
    .sort((a, b) => b[field] - a[field])
    .slice(0, 30);
process.stdout.write(
  JSON.stringify(
    {
      method:
        "Sample-weighted microseconds, including idle/driver work. Inclusive paths overlap; do not sum. Source positions are function starts, not individual hot statements. Sampling is not exact function timing.",
      samples: profile.samples.length,
      sampledUs: profile.timeDeltas.reduce((sum, value) => sum + value, 0),
      sourceMapHashes,
      mappedFunctions: [...labels.values()].filter((label) => label.mapped)
        .length,
      filesBySelf: sorted(files, "selfUs"),
      filesByInclusive: sorted(files, "inclusiveUs"),
      functionsBySelf: sorted(functions, "selfUs"),
      functionsByInclusive: sorted(functions, "inclusiveUs"),
    },
    null,
    2,
  ) + "\n",
);
