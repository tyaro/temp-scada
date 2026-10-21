/** Run a production preview first. This runner does not alter app code or CI timeouts. */
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createServer } from "vite";
import { chromium, expect as baseExpect } from "@playwright/test";
import { mixedFixture } from "./mixed-editor-fixture.mjs";
// Measurement waits are bounded, but are not performance pass/fail thresholds.
const expect = baseExpect.configure({ timeout: 60_000 });
const { unzipSync } = createRequire(
  new URL("../package.json", import.meta.url),
)("fflate");
const output = resolve(process.argv[2] ?? "/tmp/scada-mixed-quality");
const counts = process.argv.slice(3).map(Number);
if (!counts.length) counts.push(100, 500, 1000);
const origin = process.env.SCADA_BENCHMARK_URL ?? "http://127.0.0.1:5233";
await mkdir(output, { recursive: true });
const root = fileURLToPath(new URL("../", import.meta.url));
const server = await createServer({
  root,
  configFile: false,
  server: { middlewareMode: true, watch: null },
  appType: "custom",
  logLevel: "error",
});
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
});
const summary = (values) => ({
  samples: values.length,
  medianMs: +[...values]
    .sort((a, b) => a - b)
    [Math.floor(values.length / 2)].toFixed(3),
  maxMs: +Math.max(...values).toFixed(3),
});
const button = (page, name) => page.getByRole("button", { name, exact: true });
const frame = (page) =>
  page.getByRole("region", { name: "キャンバス操作領域", exact: true });
const rafs = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
try {
  const { parseProject, serializeProject } = await server.ssrLoadModule(
    "/src/lib/project.ts",
  );
  const { writeProjectPackage } = await server.ssrLoadModule(
    "/src/lib/project-package.ts",
  );
  const minimal = JSON.parse(
    await readFile(
      new URL("../../../examples/minimal.project.json", import.meta.url),
      "utf8",
    ),
  );
  const results = [];
  for (const count of counts) {
    const fixture = mixedFixture(count),
      project = parseProject(JSON.stringify(fixture.project));
    const bytes = Buffer.from(
      await (await writeProjectPackage(project, fixture.store)).arrayBuffer(),
    );
    const filename = `mixed-${count}.bantoscada`;
    await writeFile(resolve(output, filename), bytes);
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
    });
    await context.addInitScript(() => {
      const live = new Map();
      let created = 0,
        revoked = 0,
        peakLiveBytes = 0;
      const create = URL.createObjectURL.bind(URL),
        revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = (blob) => {
        const url = create(blob);
        live.set(url, blob.size);
        created++;
        peakLiveBytes = Math.max(
          peakLiveBytes,
          [...live.values()].reduce((a, b) => a + b, 0),
        );
        return url;
      };
      URL.revokeObjectURL = (url) => {
        if (live.delete(url)) revoked++;
        revoke(url);
      };
      const quality = {
        result: null,
        resources: () => ({
          created,
          revoked,
          liveUrls: live.size,
          liveBytes: [...live.values()].reduce((a, b) => a + b, 0),
          peakLiveBytes,
        }),
        arm(key, selector) {
          quality.result = null;
          const before = document
            .querySelector(selector)
            .getAttribute("transform");
          let started = null,
            done = false;
          const down = (event) => {
            if (
              event.key.toLowerCase() === key.toLowerCase() &&
              started === null
            )
              started = performance.now();
          };
          window.addEventListener("keydown", down, true);
          const observer = new MutationObserver(() => {
            const current = document
              .querySelector(selector)
              ?.getAttribute("transform");
            if (done || started === null || current === before) return;
            done = true;
            observer.disconnect();
            window.removeEventListener("keydown", down, true);
            requestAnimationFrame(() =>
              requestAnimationFrame(
                () => (quality.result = performance.now() - started),
              ),
            );
          });
          observer.observe(document.querySelector(".sheet"), {
            attributes: true,
            childList: true,
            subtree: true,
          });
        },
      };
      window.__quality = quality;
    });
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    page.setDefaultTimeout(60_000);
    await page.goto(origin);
    await page.evaluate(() => document.fonts.ready);
    await button(page, "編集").click();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    async function memory() {
      await cdp.send("HeapProfiler.collectGarbage");
      const { metrics } = await cdp.send("Performance.getMetrics");
      return {
        heapUsedBytes: metrics.find((m) => m.name === "JSHeapUsedSize").value,
        dom: await cdp.send("Memory.getDOMCounters"),
        resources: await page.evaluate(() => window.__quality.resources()),
      };
    }
    const initial = await memory();
    const loadBreakdown = [];
    async function load() {
      const before = (await cdp.send("Performance.getMetrics")).metrics;
      const start = performance.now();
      await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
        name: filename,
        mimeType: "application/zip",
        buffer: bytes,
      });
      await expect(
        page.getByLabel("Project を開く", { exact: true }),
      ).toHaveValue("");
      await expect(
        page.locator(".sheet > svg > g[data-object-id]"),
      ).toHaveCount(count);
      await expect(
        page.locator('.sheet [data-text-layout="pending"]'),
      ).toHaveCount(0);
      await page.evaluate(async () => {
        const urls = [
          ...new Set(
            [...document.querySelectorAll(".sheet > svg image")].map(
              (image) => image.href.baseVal,
            ),
          ),
        ];
        await Promise.all(
          urls.map((src) => {
            const img = new Image();
            img.src = src;
            return img.decode();
          }),
        );
      });
      await rafs(page);
      const elapsed = performance.now() - start;
      const after = (await cdp.send("Performance.getMetrics")).metrics;
      loadBreakdown.push(
        Object.fromEntries(
          [
            "LayoutCount",
            "LayoutDuration",
            "RecalcStyleCount",
            "RecalcStyleDuration",
            "ScriptDuration",
            "TaskDuration",
          ].map((name) => [
            name,
            after.find((m) => m.name === name).value -
              before.find((m) => m.name === name).value,
          ]),
        ),
      );
      await writeFile(
        resolve(output, `mixed-${count}-loads.json`),
        JSON.stringify(loadBreakdown, null, 2) + "\n",
      );
      process.stderr.write(`Loaded ${count}: ${elapsed.toFixed(1)} ms\n`);
      return elapsed;
    }
    const firstLoadMs = await load(),
      loaded = await memory(),
      reload = [];
    for (let i = 0; i < 3; i++) reload.push(await load());
    await page.getByLabel("グリッドにスナップ", { exact: true }).uncheck();
    await page.getByRole("tab", { name: "レイヤー", exact: true }).click();
    const object = project.screens[0].objects[0],
      selector = `.sheet > svg > g[data-object-id="${object.id}"]`;
    await page.locator(`button[data-layer-id="${object.id}"]`).click();
    await frame(page).focus();
    async function key(name) {
      await page.evaluate(
        ({ key, selector }) => window.__quality.arm(key, selector),
        { key: name.includes("+") ? name.split("+").at(-1) : name, selector },
      );
      await page.keyboard.press(name);
      await page.waitForFunction(() => window.__quality.result !== null);
      return page.evaluate(() => window.__quality.result);
    }
    await key("ArrowRight");
    await key("Control+z");
    const moves = [],
      undos = [];
    for (let i = 0; i < 9; i++) moves.push(await key("ArrowRight"));
    for (let i = 0; i < 9; i++) undos.push(await key("Control+z"));
    const beforeHistory = await memory(),
      historyMoves = [];
    for (let i = 0; i < 50; i++) historyMoves.push(await key("ArrowRight"));
    const withHistory = await memory(),
      saves = [];
    let lastSaved;
    for (let i = 0; i < 3; i++) {
      const started = performance.now(),
        download = page.waitForEvent("download");
      await page.keyboard.press("Control+s");
      const file = await download;
      saves.push(performance.now() - started);
      lastSaved = Buffer.from(await readFile(await file.path()));
    }
    const files = unzipSync(lastSaved),
      manifest = JSON.parse(Buffer.from(files["manifest.json"]).toString()),
      content = JSON.parse(Buffer.from(files["project.json"]).toString());
    const restored = parseProject(
      JSON.stringify({ ...content, manifest: manifest.project }),
    );
    const expected = structuredClone(project);
    expected.screens[0].objects[0].x += 50;
    expected.manifest.projectRevision = restored.manifest.projectRevision;
    assert.deepEqual(restored, expected);
    for (const original of fixture.originals)
      assert.deepEqual(
        Buffer.from(files[`assets/${original.metadata.sha256}.png`]),
        original.bytes,
      );
    assert.deepEqual(errors, []);
    // A saved Project has no pending prompt; cycle resources through an asset-free Project.
    const cycles = [];
    for (let i = 0; i < 3; i++) {
      await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
        name: "empty.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(minimal)),
      });
      await expect(
        page.locator(".sheet > svg > g[data-object-id]"),
      ).toHaveCount(3);
      await expect
        .poll(() => page.evaluate(() => window.__quality.resources().liveUrls))
        .toBe(0);
      cycles.push(await memory());
      if (i < 2) await load();
    }
    await load();
    for (const theme of ["light", "dark"]) {
      await button(page, "テーマを変更").click();
      await page
        .getByRole("menuitem", {
          name: theme === "light" ? "ライト" : "ダーク",
          exact: true,
        })
        .click();
      await rafs(page);
      await page.screenshot({
        path: resolve(output, `mixed-${count}-${theme}.png`),
        animations: "disabled",
      });
    }
    const result = {
      placements: count,
      symbolChildren: project.symbols[0].objects.length,
      byKind: Object.fromEntries(
        ["rectangle", "text", "symbol", "image", "polyline"].map((type) => [
          type,
          project.screens[0].objects.filter((o) => o.shape.type === type)
            .length,
        ]),
      ),
      projectJsonBytes: Buffer.byteLength(serializeProject(project)),
      packageBytes: bytes.length,
      originals: project.assets.map(
        ({ sha256, width, height, byteLength }) => ({
          sha256,
          width,
          height,
          byteLength,
        }),
      ),
      textProjection: await page
        .locator(".sheet [data-text-multiline]")
        .evaluateAll((nodes) =>
          nodes.map((node) => ({
            layout: node.getAttribute("data-text-layout"),
            lines: node.getAttribute("data-text-line-count"),
            content: [...node.querySelectorAll("[data-text-content]")].map(
              (text) => ({
                text: text.textContent,
                x: text.getAttribute("x"),
                y: text.getAttribute("y"),
              }),
            ),
          })),
        ),
      loadBreakdown,
      timing: {
        firstLoadMs: +firstLoadMs.toFixed(3),
        reload: summary(reload),
        keyMove: summary(moves),
        undo: summary(undos),
        fiftyHistoryMoves: summary(historyMoves),
        saveDownload: summary(saves),
      },
      memory: {
        initial,
        loaded,
        beforeHistory,
        withHistory,
        assetFreeCycles: cycles,
      },
      checks: {
        savedContentAndOriginals: true,
        noPageErrors: true,
        noLiveUrlsAfterAssetFreeCycles: true,
      },
    };
    if (process.env.SCADA_BENCHMARK_BASELINE) {
      const baseline = JSON.parse(
        await readFile(process.env.SCADA_BENCHMARK_BASELINE, "utf8"),
      );
      const previous = baseline.results.find(
        (row) => row.placements === count,
      )?.textProjection;
      if (previous) {
        assert.equal(result.textProjection.length, previous.length);
        let maxCoordinateDifference = 0;
        result.textProjection.forEach((node, index) => {
          const old = previous[index];
          assert.equal(node.layout, old.layout);
          assert.equal(node.lines, old.lines);
          assert.equal(node.content.length, old.content.length);
          node.content.forEach((text, line) => {
            assert.equal(text.text, old.content[line].text);
            for (const key of ["x", "y"])
              maxCoordinateDifference = Math.max(
                maxCoordinateDifference,
                Math.abs(Number(text[key]) - Number(old.content[line][key])),
              );
          });
        });
        assert(
          maxCoordinateDifference <= 0.0001,
          `Text projection changed by ${maxCoordinateDifference} design units`,
        );
        result.projectionComparison = {
          nodes: previous.length,
          maxCoordinateDifference,
          textAndLineLayoutIdentical: true,
        };
      }
    }
    assert.equal(await page.locator("[data-text-measure-host]").count(), 0);
    result.checks.noTemporaryMeasurementDom = true;
    results.push(result);
    await writeFile(
      resolve(output, `mixed-${count}.json`),
      JSON.stringify(result, null, 2) + "\n",
    );
    process.stderr.write(`Measured mixed ${count} placements\n`);
    await context.close();
  }
  const report = {
    recordedAt: new Date().toISOString(),
    commit: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    node: process.version,
    chromium: browser.version(),
    platform: `${process.platform}/${process.arch}`,
    productionPreview: origin,
    viewport: { width: 1920, height: 1080 },
    method:
      "9 key samples after warmup; 3 reloads/saves; 50 retained move commits; event to DOM change plus two rAF, no real display timing",
    results,
  };
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} finally {
  await browser.close();
  await server.close();
}
