/** Sequential A/B/B/A load probe; separate from CPU sampling and application tests. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { chromium, expect as baseExpect } from "@playwright/test";
const expect = baseExpect.configure({ timeout: 60_000 });
const [input, output, before, after, size = "1000"] = process.argv.slice(2);
assert(
  input && output && before && after,
  "Usage: compare-editor-load.mjs package output.json before-url after-url [placements]",
);
const count = Number(size);
assert(Number.isInteger(count) && count > 0 && count <= 1000);
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
});
const results = [];
try {
  for (const label of ["before", "after", "after", "before"]) {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
    });
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(label === "before" ? before : after);
    await page.getByRole("button", { name: "編集", exact: true }).click();
    await page.evaluate(() => document.fonts.ready);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    for (const phase of ["cold", "reload"]) {
      const startMetrics = (await cdp.send("Performance.getMetrics")).metrics;
      const started = performance.now();
      const file = page.getByLabel("Project を開く", { exact: true });
      await file.setInputFiles(resolve(input));
      await expect(file).toHaveValue("");
      await expect(
        page.locator(".sheet > svg > g[data-object-id]"),
      ).toHaveCount(count);
      await expect(
        page.locator('.sheet [data-text-layout="pending"]'),
      ).toHaveCount(0);
      await page.evaluate(async () => {
        const urls = new Set(
          [...document.querySelectorAll(".sheet > svg image")].map(
            (image) => image.href.baseVal,
          ),
        );
        await Promise.all(
          [...urls].map((src) => {
            const image = new Image();
            image.src = src;
            return image.decode();
          }),
        );
        await new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        );
      });
      const elapsedMs = performance.now() - started;
      const endMetrics = (await cdp.send("Performance.getMetrics")).metrics;
      results.push({
        label,
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
            endMetrics.find((entry) => entry.name === name).value -
              startMetrics.find((entry) => entry.name === name).value,
          ]),
        ),
      });
      process.stderr.write(`${label} ${phase}: ${elapsedMs.toFixed(1)} ms\n`);
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  await writeFile(
    output,
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        chromium: browser.version(),
        placements: count,
        before,
        after,
        method:
          "A/B/B/A, fresh context per pair, cold load then one reload. Sequential; no local build/test/profiler. Driver-to-two-rAF including text layout and image decode. Durations in seconds overlap; samples too few for significance or a performance guarantee.",
        results,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await browser.close();
}
