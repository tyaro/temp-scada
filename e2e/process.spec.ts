import { selectPanel } from "./helpers/designer";
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import legacy from "../examples/legacy.project.json" with { type: "json" };
test("edits pipes and reusable symbols, then reproduces the saved process screen", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await selectPanel(page, "プロジェクト");
  await page.getByRole("button", { name: "工程図サンプルを開く" }).click();
  const svg = page.getByRole("img", {
    name: "循環設備（静的サンプル）",
    exact: true,
  });
  await expect(svg).toBeVisible();
  await expect(svg.locator("[data-symbol-id]")).toHaveCount(2);
  await page.screenshot({
    path: "/tmp/scada-process-preview.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await selectPanel(page, "部品");
  await page.getByRole("button", { name: "配管を追加" }).click();
  await page.getByLabel("x", { exact: true }).fill("400");
  await page.getByLabel("y", { exact: true }).fill("180");
  await page
    .getByLabel("頂点", { exact: true })
    .fill("-20,0\n120,0\n120,80\n180,80");
  await page.getByLabel("線幅", { exact: true }).fill("6");
  await page.getByLabel("矢印", { exact: true }).selectOption("end");
  await page.getByRole("button", { name: "変更を適用" }).click();
  const pipe = svg.locator("[data-object-id]").last();
  await expect(pipe.locator("polyline").first()).toHaveAttribute(
    "points",
    "-20,0 120,0 120,80 180,80",
  );
  await expect(pipe.locator("polygon")).toHaveCount(1);
  await svg.scrollIntoViewIfNeeded();
  const position = await svg.evaluate((el) => {
    const p = new DOMPoint(450, 180).matrixTransform(
      (el as SVGSVGElement).getScreenCTM()!,
    );
    return { x: p.x, y: p.y };
  });
  const scale = await svg.evaluate(
    (el) => (el as SVGSVGElement).getScreenCTM()!.a,
  );
  await page.mouse.move(position.x, position.y);
  await page.mouse.down();
  await page.mouse.move(position.x + 40 * scale, position.y + 20 * scale, {
    steps: 4,
  });
  await page.mouse.up();
  expect(
    Number(await page.getByLabel("x", { exact: true }).inputValue()),
  ).toBeCloseTo(440, 0);
  expect(
    Number(await page.getByLabel("y", { exact: true }).inputValue()),
  ).toBeCloseTo(200, 0);
  await page.getByRole("button", { name: "ポンプを追加" }).click();
  await page.getByRole("button", { name: "ポンプを追加" }).click();
  await selectPanel(page, "プロジェクト");
  await page.getByRole("button", { name: "工程図サンプルを開く" }).click();
  await page
    .getByRole("dialog", { name: "Project を置き換えますか" })
    .getByRole("button", { name: "キャンセル", exact: true })
    .click();
  await expect(svg.locator("[data-object-id]")).toHaveCount(18);
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Project JSON を保存" }).click();
  const downloaded = await downloading;
  const json = await readFile((await downloaded.path())!, "utf8");
  const saved = JSON.parse(json);
  expect(saved.symbols).toHaveLength(2);
  expect(
    saved.screens[0].objects.filter((o: any) => o.shape.type === "symbol"),
  ).toHaveLength(4);
  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
  const before = await svg.innerHTML();
  await page.getByLabel("Project JSON を開く", { exact: true }).setInputFiles({
    name: "process.json",
    mimeType: "application/json",
    buffer: Buffer.from(json),
  });
  await expect.poll(() => svg.innerHTML()).toBe(before);
  expect(errors).toEqual([]);
});
test("loads legacy geometry and saves the migrated version without losing identity", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Project JSON を開く", { exact: true }).setInputFiles({
    name: "old.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(legacy)),
  });
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Project JSON を保存" }).click();
  const download = await downloading;
  const saved = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(saved.manifest.schemaVersion).toBe("0.4.0");
  expect(saved.manifest.projectId).toBe(legacy.manifest.projectId);
  expect(saved.manifest.projectRevision).toBe(legacy.manifest.projectRevision);
  expect(saved.screens).toEqual(
    legacy.screens.map((screen) => ({ ...screen, background: "#0b1220" })),
  );
});
