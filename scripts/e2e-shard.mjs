// Split the e2e spec files into CI shards by their recorded duration.
//
// Playwright's own `--shard` splits by test count, so slow files that sit
// next to each other in name order pile up in one shard. This script assigns
// whole files to the least-loaded shard, heaviest first, using the seconds in
// `e2e/shard-durations.json`. Files missing from that table get the median.
//
//   node scripts/e2e-shard.mjs <index> <total>
//     Prints the anchored file patterns of shard <index> (1-based) for
//     `playwright test`.
//   node scripts/e2e-shard.mjs --update <job log>...
//     Rewrites the table from Playwright list-reporter output (for example
//     `gh run view --job <id> --log` of every e2e shard of one or more runs).
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const e2eDir = path.join(root, "e2e");
const tablePath = path.join(e2eDir, "shard-durations.json");

function specFiles() {
  return readdirSync(e2eDir)
    .filter((name) => name.endsWith(".spec.ts"))
    .sort();
}

function readTable() {
  return JSON.parse(readFileSync(tablePath, "utf8"));
}

function median(values) {
  if (values.length === 0) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function assignShards(files, table, total) {
  const fallback = median(Object.values(table));
  const weighted = files
    .map((file) => ({ file, seconds: table[file] ?? fallback }))
    .sort((a, b) => b.seconds - a.seconds || a.file.localeCompare(b.file));
  const shards = Array.from({ length: total }, () => ({
    seconds: 0,
    files: [],
  }));
  for (const { file, seconds } of weighted) {
    let target = shards[0];
    for (const shard of shards)
      if (shard.seconds < target.seconds) target = shard;
    target.seconds += seconds;
    target.files.push(file);
  }
  for (const shard of shards) shard.files.sort();
  return shards;
}

function parseSeconds(text) {
  const minutes = /^(\d+(?:\.\d+)?)m(?: (\d+(?:\.\d+)?)s)?$/.exec(text);
  if (minutes) return Number(minutes[1]) * 60 + Number(minutes[2] ?? 0);
  if (text.endsWith("ms")) return Number(text.slice(0, -2)) / 1000;
  if (text.endsWith("s")) return Number(text.slice(0, -1));
  return Number.NaN;
}

function update(logs) {
  const runsPerFile = new Map();
  for (const log of logs) {
    const totals = new Map();
    for (const line of readFileSync(log, "utf8").split("\n")) {
      const match = /[✓✘]\s+\d+ e2e\/([^:]+\.spec\.ts):.*\(([^)]+)\)\s*$/.exec(
        line,
      );
      if (!match) continue;
      const seconds = parseSeconds(match[2]);
      if (Number.isNaN(seconds)) continue;
      totals.set(match[1], (totals.get(match[1]) ?? 0) + seconds);
    }
    for (const [file, seconds] of totals) {
      runsPerFile.set(file, [...(runsPerFile.get(file) ?? []), seconds]);
    }
  }
  const table = {};
  for (const file of specFiles()) {
    const runs = runsPerFile.get(file);
    if (runs)
      table[file] = Math.max(
        1,
        Math.round(runs.reduce((a, b) => a + b, 0) / runs.length),
      );
  }
  writeFileSync(tablePath, `${JSON.stringify(table, null, 2)}\n`);
  const missing = specFiles().filter((file) => !(file in table));
  console.log(
    `wrote ${Object.keys(table).length} files to ${path.relative(root, tablePath)}`,
  );
  if (missing.length)
    console.log(`not in the logs (median is used): ${missing.join(", ")}`);
}

function main(args) {
  if (args[0] === "--update") {
    if (args.length < 2) throw new Error("--update needs one or more job logs");
    update(args.slice(1));
    return;
  }
  const index = Number(args[0]);
  const total = Number(args[1]);
  if (
    !Number.isInteger(index) ||
    !Number.isInteger(total) ||
    index < 1 ||
    index > total
  ) {
    throw new Error("usage: node scripts/e2e-shard.mjs <index> <total>");
  }
  const shard = assignShards(specFiles(), readTable(), total)[index - 1];
  if (shard.files.length === 0)
    throw new Error(`shard ${index}/${total} has no files`);
  const escape = (file) => file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  console.log(shard.files.map((file) => `e2e/${escape(file)}$`).join(" "));
}

main(process.argv.slice(2));
