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
  "Usage: compare-editor-load.mjs package output.json before-url after-url [placements] [--keys [--history]]",
);
const count = Number(size);
const compareKeys = process.argv[7] === "--keys";
const compareHistory = compareKeys && process.argv[8] === "--history";
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
    if (compareKeys) {
      await page.getByLabel("グリッドにスナップ", { exact: true }).uncheck();
      await page.getByRole("tab", { name: "レイヤー", exact: true }).click();
      const objects = page.locator(".sheet > svg > g[data-object-id]");
      const id = await objects.first().getAttribute("data-object-id");
      const selector = `.sheet > svg > g[data-object-id="${id}"]`;
      const selected = page.locator(selector);
      await page.locator(`button[data-layer-id="${id}"]`).click();
      await page
        .getByRole("region", { name: "キャンバス操作領域", exact: true })
        .focus();
      const initial = await selected.getAttribute("transform");
      const urls = () =>
        page
          .locator(".sheet > svg image")
          .evaluateAll((nodes) => nodes.map((node) => node.href.baseVal));
      const imageUrls = await urls();
      async function key(name) {
        const startMetrics = (await cdp.send("Performance.getMetrics")).metrics;
        await page.evaluate(
          ({ selector, key }) => {
            const node = document.querySelector(selector);
            const before = node.getAttribute("transform");
            let started = null;
            window.__comparisonKeyResult = null;
            const down = (event) => {
              if (event.isTrusted && event.key === key && started === null)
                started = performance.now();
            };
            window.addEventListener("keydown", down, true);
            const observer = new MutationObserver(() => {
              if (started === null || node.getAttribute("transform") === before)
                return;
              observer.disconnect();
              window.removeEventListener("keydown", down, true);
              requestAnimationFrame(() =>
                requestAnimationFrame(
                  () =>
                    (window.__comparisonKeyResult =
                      performance.now() - started),
                ),
              );
            });
            observer.observe(node, {
              attributes: true,
              attributeFilter: ["transform"],
            });
          },
          { selector, key: name.split("+").at(-1) },
        );
        await page.keyboard.press(name);
        await page.waitForFunction(() => window.__comparisonKeyResult !== null);
        const elapsedMs = await page.evaluate(
          () => window.__comparisonKeyResult,
        );
        const endMetrics = (await cdp.send("Performance.getMetrics")).metrics;
        return {
          elapsedMs,
          metrics: Object.fromEntries(
            [
              "ScriptDuration",
              "LayoutDuration",
              "RecalcStyleDuration",
              "TaskDuration",
            ].map((name) => [
              name,
              endMetrics.find((entry) => entry.name === name).value -
                startMetrics.find((entry) => entry.name === name).value,
            ]),
          ),
        };
      }
      await key("ArrowRight");
      await key("Control+z");
      for (const [phase, command] of [
        ["move", "ArrowRight"],
        ["undo", "Control+z"],
      ]) {
        const samples = [];
        for (let i = 0; i < 9; i++) samples.push(await key(command));
        results.push({ label, phase, samples });
        process.stderr.write(
          `${label} ${phase}: ${samples.map((s) => s.elapsedMs.toFixed(1)).join(", ")} ms\n`,
        );
      }
      await expect(selected).toHaveAttribute("transform", initial);
      if (compareHistory) {
        const position = () =>
          selected.evaluate((g) => {
            const m = g.transform.baseVal.consolidate().matrix;
            return { x: m.e, y: m.f };
          });
        const start = await position(),
          samples = [];
        for (let i = 0; i < 50; i++) samples.push(await key("ArrowRight"));
        assert.deepEqual(await position(), { x: start.x + 50, y: start.y });
        results.push({ label, phase: "historyMoves", samples });
        process.stderr.write(
          `${label} historyMoves: ${samples.map((s) => s.elapsedMs.toFixed(1)).join(", ")} ms\n`,
        );
      }
      assert.deepEqual(
        await urls(),
        imageUrls,
        "geometry/history must retain the current Store URLs",
      );
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
        compareKeys,
        compareHistory,
        method:
          "A/B/B/A, fresh context per pair, cold load then one reload; optional --keys adds 9 moves and 9 Undo after warmup, trusted key event to transform plus two rAF; asserts final transform and stable image URLs; --keys --history adds 50 further moves and checks the full displacement. Sequential; no local build/test/profiler. Driver-to-two-rAF including text layout and image decode. Durations in seconds overlap; samples too few for significance or a performance guarantee.",
        results,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await browser.close();
}
