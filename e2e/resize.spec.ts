import { selectPanel } from "./helpers/designer";
import { test, expect, type Page, type Locator } from "@playwright/test";
import { readFile } from "node:fs/promises";
async function resize(
  page: Page,
  svg: Locator,
  handle: string,
  dx: number,
  dy: number,
  cancel = false,
) {
  const target = svg.locator(`[data-resize-handle="${handle}"]`);
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  const scale = await svg.evaluate(
    (el) => (el as SVGSVGElement).getScreenCTM()!.a,
  );
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + dx * scale,
    box.y + box.height / 2 + dy * scale,
    { steps: 5 },
  );
  if (cancel) await page.keyboard.press("Escape");
  await page.mouse.up();
}
test("resize handles update geometry atomically with snap, cancel, history and JSON round-trip", async ({
  page,
}) => {
  await page.goto("/");
  const button = (name: string) =>
    page.getByRole("button", { name, exact: true });
  await button("編集").click();
  const svg = page.getByRole("img", { name: "プロセス画面", exact: true });
  await selectPanel(page, "レイヤー");
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "rectangle · 3", exact: true })
    .click();
  await expect(svg.locator("[data-resize-handle]")).toHaveCount(8);
  await resize(page, svg, "nw", 20, 30);
  await expect(page.getByLabel("x", { exact: true })).toHaveValue("120");
  await expect(page.getByLabel("y", { exact: true })).toHaveValue("200");
  await expect(page.getByLabel("width", { exact: true })).toHaveValue("240");
  await expect(page.getByLabel("height", { exact: true })).toHaveValue("150");
  await button("元に戻す").click();
  await expect(page.getByLabel("width", { exact: true })).toHaveValue("260");
  await button("やり直す").click();
  await resize(page, svg, "se", 40, 40, true);
  await expect(page.getByLabel("width", { exact: true })).toHaveValue("240");
  await page.getByLabel("グリッドにスナップ", { exact: true }).check();
  await page.getByLabel("グリッド間隔", { exact: true }).selectOption("20");
  await resize(page, svg, "se", 13, 13);
  await expect(page.getByLabel("width", { exact: true })).toHaveValue("260");
  await expect(page.getByLabel("height", { exact: true })).toHaveValue("160");
  await page.keyboard.down("Alt");
  await resize(page, svg, "e", 7, 0);
  await page.keyboard.up("Alt");
  await expect(page.getByLabel("width", { exact: true })).toHaveValue("267");
  const east = svg.locator('[data-resize-handle="e"]');
  await east.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByLabel("width", { exact: true })).toHaveValue("280");
  const downloading = page.waitForEvent("download");
  await button("Project JSON を保存").click();
  const json = await readFile((await (await downloading).path())!, "utf8");
  const saved = JSON.parse(json);
  expect(saved.screens[0].objects[0]).toMatchObject({
    x: 120,
    y: 200,
    width: 280,
    height: 160,
  });
  expect(saved.manifest.projectRevision).toBe(7);
  await page.getByLabel("Project JSON を開く", { exact: true }).setInputFiles({
    name: "resize.json",
    mimeType: "application/json",
    buffer: Buffer.from(json),
  });
  await button("表示プレビュー").click();
  await expect(svg.locator("[data-resize-handle]")).toHaveCount(0);
  await expect(svg.locator("[data-object-id]").first()).toHaveAttribute(
    "transform",
    "translate(120 200)",
  );
});
test("symbols resize their viewport without changing shared definitions or other instances", async ({
  page,
}) => {
  await page.goto("/");
  const button = (name: string) =>
    page.getByRole("button", { name, exact: true });
  await button("編集").click();
  await selectPanel(page, "部品");
  await button("ポンプを追加").click();
  await button("選択図形を複製").click();
  const svg = page.getByRole("img", { name: "プロセス画面", exact: true });
  await resize(page, svg, "se", 40, 20);
  const instances = svg.locator("[data-symbol-id]");
  await expect(instances.first()).toHaveAttribute("width", "100");
  await expect(instances.last()).toHaveAttribute("width", "140");
  await expect(instances.last()).toHaveAttribute("height", "120");
  const downloading = page.waitForEvent("download");
  await button("Project JSON を保存").click();
  const saved = JSON.parse(
    await readFile((await (await downloading).path())!, "utf8"),
  );
  expect(saved.symbols).toHaveLength(1);
  expect(saved.symbols[0].width).toBe(100);
  await button("すべて選択").click();
  await expect(svg.locator("[data-resize-handle]")).toHaveCount(0);
  await button("選択解除").click();
  await button("配管を追加").click();
  await expect(svg.locator("[data-resize-handle]")).toHaveCount(0);
  await expect(svg.locator("[data-vertex-index]")).toHaveCount(4);
});
