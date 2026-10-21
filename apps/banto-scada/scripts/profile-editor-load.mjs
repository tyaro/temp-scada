/** Load-only probe. CPU sampling is optional and never used as normal latency. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { cpus, platform, release } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { chromium, expect as baseExpect } from "@playwright/test";

const expect = baseExpect.configure({ timeout: 60_000 });
const [input, destination, size = "1000", ...flags] = process.argv.slice(2);
assert(
  input && destination,
  "Usage: profile-editor-load.mjs package output-directory [placements] [--cpu] [--direct-file-query]",
);
assert(flags.every((flag) => ["--cpu", "--direct-file-query"].includes(flag)));
const count = Number(size);
assert(Number.isInteger(count) && count > 0 && count <= 1000);
const sampled = flags.includes("--cpu");
const directFileQuery = flags.includes("--direct-file-query");
const output = resolve(destination);
await mkdir(output, { recursive: true });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const packageBytes = await readFile(resolve(input));
const { unzipSync } = createRequire(
  new URL("../package.json", import.meta.url),
)("fflate");
const entries = unzipSync(packageBytes);
const project = JSON.parse(
  Buffer.from(entries["project.json"]).toString("utf8"),
);
const expectedHashes = project.assets.map((asset) => asset.sha256).sort();
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  const origin = process.env.SCADA_PROFILE_URL ?? "http://127.0.0.1:5233";
  await page.goto(origin);
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.evaluate(() => document.fonts.ready);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  if (sampled) {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
  }
  const results = [];
  let previousUrls = [];
  let firstProjection;
  for (const phase of ["cold", "reload"]) {
    const before = (await cdp.send("Performance.getMetrics")).metrics;
    if (sampled) await cdp.send("Profiler.start");
    const started = performance.now();
    // Compare driver label lookup with a narrow query without changing app behavior.
    const field = directFileQuery
      ? page.locator('input[type="file"][aria-label="Project を開く"]')
      : page.getByLabel("Project を開く", { exact: true });
    await field.setInputFiles(resolve(input));
    await expect(field).toHaveValue("");
    await expect(page.locator(".sheet > svg > g[data-object-id]")).toHaveCount(
      count,
    );
    await expect(
      page.locator('.sheet [data-text-layout="pending"]'),
    ).toHaveCount(0);
    await page.evaluate(async () => {
      await document.fonts.ready;
      const urls = new Set(
        [...document.querySelectorAll(".sheet > svg image")].map(
          (image) => image.href.baseVal,
        ),
      );
      await Promise.all(
        [...urls].map(async (src) => {
          const image = new Image();
          image.src = src;
          await image.decode();
        }),
      );
      await new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      );
    });
    const elapsedMs = performance.now() - started;
    if (sampled) {
      const { profile } = await cdp.send("Profiler.stop");
      await writeFile(
        resolve(output, `${phase}.cpuprofile`),
        JSON.stringify(profile),
      );
    }
    const after = (await cdp.send("Performance.getMetrics")).metrics;
    const originals = await page.evaluate(async () => {
      const urls = [
        ...new Set(
          [...document.querySelectorAll(".sheet > svg image")].map(
            (image) => image.href.baseVal,
          ),
        ),
      ];
      return Promise.all(
        urls.map(async (url) => {
          const bytes = await (await fetch(url)).arrayBuffer();
          const digest = await crypto.subtle.digest("SHA-256", bytes);
          return {
            url,
            bytes: bytes.byteLength,
            sha256: [...new Uint8Array(digest)]
              .map((n) => n.toString(16).padStart(2, "0"))
              .join(""),
          };
        }),
      );
    });
    assert.deepEqual(
      originals.map((asset) => asset.sha256).sort(),
      expectedHashes,
    );
    const projection = await page
      .locator(".sheet [data-text-layout]")
      .evaluateAll((nodes) =>
        nodes.map((node) => ({
          mode: node.getAttribute("data-text-layout"),
          label: node.getAttribute("aria-label"),
          content: [...node.querySelectorAll("[data-text-content]")].map(
            (text) => ({
              text: text.textContent,
              x: text.getAttribute("x"),
              y: text.getAttribute("y"),
            }),
          ),
        })),
      );
    if (firstProjection) assert.deepEqual(projection, firstProjection);
    else firstProjection = projection;
    assert.equal(await page.locator("[data-text-measure-host]").count(), 0);
    const oldUrlsRevoked = await page.evaluate(
      async (urls) =>
        Promise.all(
          urls.map(async (url) => {
            try {
              await fetch(url);
              return false;
            } catch {
              return true;
            }
          }),
        ),
      previousUrls,
    );
    assert(oldUrlsRevoked.every(Boolean));
    previousUrls = originals.map((asset) => asset.url);
    await cdp.send("HeapProfiler.collectGarbage");
    const heap = (await cdp.send("Performance.getMetrics")).metrics;
    results.push({
      phase,
      elapsedMs,
      metrics: Object.fromEntries(
        [
          "ScriptDuration",
          "LayoutDuration",
          "RecalcStyleDuration",
          "TaskDuration",
          "LayoutCount",
          "RecalcStyleCount",
        ].map((name) => [
          name,
          after.find((entry) => entry.name === name).value -
            before.find((entry) => entry.name === name).value,
        ]),
      ),
      heapAfterGc: heap.find((entry) => entry.name === "JSHeapUsedSize").value,
      originals: originals.map(({ sha256, bytes }) => ({ sha256, bytes })),
      oldUrlsRevoked,
      textCount: projection.length,
      textProjectionSha256: hash(JSON.stringify(projection)),
    });
    process.stderr.write(
      `${sampled ? "CPU diagnostic" : "Normal"} ${count} ${phase}: ${elapsedMs.toFixed(1)} ms\n`,
    );
  }
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        commit: execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        chromium: browser.version(),
        node: process.version,
        platform: platform(),
        kernel: release(),
        cpu: cpus()[0].model,
        placements: count,
        packageSha256: hash(packageBytes),
        origin,
        sampled,
        fileQuery: directFileQuery ? "direct" : "label",
        samplingIntervalUs: sampled ? 1000 : null,
        method:
          "Cold means first Project import into a loaded editor, not browser startup. Each phase ends after text settles, font readiness, image decode and 2 rAF. CPU sampling changes timing; do not compare it as normal latency. CDP durations overlap; GC, hashes, projection and old URL checks are after timing. Projection equality covers cold/reload of the same build only.",
        results,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await browser.close();
}
