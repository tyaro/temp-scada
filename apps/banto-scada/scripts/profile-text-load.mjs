/** Diagnostic instrumentation, not a normal load latency benchmark. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect as baseExpect } from "@playwright/test";
const expect = baseExpect.configure({ timeout: 60_000 });
const [input, output, size = "1000"] = process.argv.slice(2);
assert(
  input && output,
  "Usage: profile-text-load.mjs package output.json [placements]",
);
const count = Number(size);
assert(Number.isInteger(count) && count > 0 && count <= 1000);
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
  });
  await page.addInitScript(() => {
    const original = SVGGraphicsElement.prototype.getBBox;
    const stats = {
      isolated: { calls: 0, nativeMs: 0 },
      drawing: { calls: 0, nativeMs: 0 },
    };
    SVGGraphicsElement.prototype.getBBox = function (...args) {
      const root = this.getRootNode();
      const isolated =
        root instanceof ShadowRoot
          ? root.host.hasAttribute("data-text-measure-host")
          : Boolean(this.closest("[data-text-measure-host]"));
      const bucket = isolated ? stats.isolated : stats.drawing;
      bucket.calls++;
      const started = performance.now();
      try {
        return original.apply(this, args);
      } finally {
        bucket.nativeMs += performance.now() - started;
      }
    };
    window.__textLoadProfile = {
      stats,
      reset() {
        for (const value of Object.values(stats)) {
          value.calls = 0;
          value.nativeMs = 0;
        }
      },
    };
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(process.env.SCADA_PROFILE_URL ?? "http://127.0.0.1:5233");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.evaluate(() => document.fonts.ready);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const results = [];
  for (let index = 0; index < 2; index++) {
    await page.evaluate(() => window.__textLoadProfile.reset());
    const before = (await cdp.send("Performance.getMetrics")).metrics;
    const inputField = page.getByLabel("Project を開く", { exact: true });
    await inputField.setInputFiles(resolve(input));
    await expect(inputField).toHaveValue("");
    await expect(page.locator(".sheet > svg > g[data-object-id]")).toHaveCount(
      count,
    );
    await expect(
      page.locator('.sheet [data-text-layout="pending"]'),
    ).toHaveCount(0);
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
    const after = (await cdp.send("Performance.getMetrics")).metrics;
    results.push({
      stats: await page.evaluate(() => window.__textLoadProfile.stats),
      metrics: Object.fromEntries(
        [
          "LayoutCount",
          "RecalcStyleCount",
          "LayoutDuration",
          "RecalcStyleDuration",
          "ScriptDuration",
          "TaskDuration",
        ].map((name) => [
          name,
          after.find((entry) => entry.name === name).value -
            before.find((entry) => entry.name === name).value,
        ]),
      ),
    });
    assert.equal(await page.locator("[data-text-measure-host]").count(), 0);
    process.stderr.write(`Diagnosed load ${index + 1}\n`);
  }
  assert.deepEqual(errors, []);
  await writeFile(
    output,
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        chromium: browser.version(),
        placements: count,
        method:
          "getBBox wrapper counts and measures native calls, including synchronous style/layout. Diagnostic overhead and driver intervals included; not normal input latency. CDP durations overlap and must not be summed.",
        results,
        textProjection: await page
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
          ),
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await browser.close();
}
