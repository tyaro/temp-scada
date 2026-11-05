import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const files = execFileSync("git", ["ls-files", "-z", "--", "*.md"], {
  cwd: root,
})
  .toString("utf8")
  .split("\0")
  // These references intentionally point into the separate upstream repository.
  .filter((file) => file && !file.startsWith("docs/upstream/industrial/"));
const anchors = new Map();
const failures = [];
let checked = 0;

function visibleMarkdown(source) {
  return source
    .replace(/^\s*(```|~~~)[^\n]*\n[\s\S]*?^\s*\1[^\n]*$/gm, "")
    .replace(/`[^`\n]+`/g, "");
}

function slug(heading) {
  return heading
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[*_~]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\p{Zs}_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

function anchorsFor(file) {
  if (anchors.has(file)) return anchors.get(file);
  const result = new Set();
  const counts = new Map();
  const content = visibleMarkdown(readFileSync(file, "utf8"));
  for (const match of content.matchAll(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = slug(match[1]);
    const count = counts.get(base) ?? 0;
    result.add(count === 0 ? base : `${base}-${count}`);
    counts.set(base, count + 1);
  }
  for (const match of content.matchAll(
    /<a\s+[^>]*\bid=["']([^"']+)["'][^>]*>/gi,
  )) {
    result.add(match[1]);
  }
  anchors.set(file, result);
  return result;
}

for (const relative of files) {
  const sourceFile = path.join(root, relative);
  const content = visibleMarkdown(readFileSync(sourceFile, "utf8"));
  for (const match of content.matchAll(
    /!?\[[^\]\n]*\]\((<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)/g,
  )) {
    const raw = match[1].replace(/^<|>$/g, "");
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(raw) || raw.startsWith("/"))
      continue;
    const [location, fragment] = raw.split("#", 2);
    const filePart = decodeURIComponent(location.split("?")[0]);
    const target = path.resolve(path.dirname(sourceFile), filePart || ".");
    checked++;
    if (!existsSync(target)) {
      failures.push(`${relative}: missing ${raw}`);
      continue;
    }
    if (fragment && target.endsWith(".md")) {
      const anchor = decodeURIComponent(fragment);
      if (!anchorsFor(target).has(anchor)) {
        failures.push(`${relative}: missing anchor ${raw}`);
      }
    }
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  console.error(
    `${failures.length} broken relative links (${checked} checked)`,
  );
  process.exitCode = 1;
} else {
  console.log(`${checked} relative Markdown links and anchors checked`);
}
