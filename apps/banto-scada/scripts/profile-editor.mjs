/** Separate diagnostic run: CPU sampling changes timing; do not compare its latency. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect as baseExpect } from "@playwright/test";

const expect = baseExpect.configure({ timeout: 60_000 });
const [input, destination, size = "1000"] = process.argv.slice(2);
assert(
  input && destination,
  "Usage: profile-editor.mjs package output-directory [placements]",
);
const count = Number(size);
assert(Number.isInteger(count) && count > 0 && count <= 1000);
const output = resolve(destination);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(process.env.SCADA_PROFILE_URL ?? "http://localhost:5234");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  const fileInput = page.getByLabel("Project を開く", { exact: true });
  await fileInput.setInputFiles(resolve(input));
  await expect(fileInput).toHaveValue("");
  const objects = page.locator(".sheet > svg > g[data-object-id]");
  await expect(objects).toHaveCount(count);
  await expect(page.locator('.sheet [data-text-layout="pending"]')).toHaveCount(
    0,
  );
  await page.evaluate(() => document.fonts.ready);
  await page.getByLabel("グリッドにスナップ", { exact: true }).uncheck();
  await page.getByRole("tab", { name: "レイヤー", exact: true }).click();
  const id = await objects.first().getAttribute("data-object-id");
  const selected = page.locator(`.sheet > svg > g[data-object-id="${id}"]`);
  await page.locator(`button[data-layer-id="${id}"]`).click();
  await page
    .getByRole("region", { name: "キャンバス操作領域", exact: true })
    .focus();
  async function key(name) {
    const before = await selected.getAttribute("transform");
    await page.keyboard.press(name);
    await expect(selected).not.toHaveAttribute("transform", before);
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
  }
  await key("ArrowRight");
  await key("Control+z");
  const initial = await selected.getAttribute("transform");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
  for (const [label, name] of [
    ["move", "ArrowRight"],
    ["undo", "Control+z"],
  ]) {
    await cdp.send("Profiler.start");
    for (let index = 0; index < 9; index++) await key(name);
    const { profile } = await cdp.send("Profiler.stop");
    await writeFile(
      resolve(output, `${label}.cpuprofile`),
      JSON.stringify(profile),
    );
    process.stderr.write(
      `Profiled ${label}: ${profile.samples.length} samples\n`,
    );
  }
  await expect(selected).toHaveAttribute("transform", initial);
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(output, "metadata.json"),
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        chromium: browser.version(),
        placements: count,
        package: resolve(input),
        samplingIntervalUs: 1000,
        keysPerProfile: 9,
        method:
          "Separate CPU diagnostic with source maps; includes browser/driver idle and coordination. Not an input-latency benchmark.",
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await browser.close();
}
