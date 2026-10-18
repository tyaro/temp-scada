import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
async function drag(
  page: Page,
  svg: Locator,
  from: { x: number; y: number },
  delta: { x: number; y: number },
  cancel = false,
) {
  await svg.scrollIntoViewIfNeeded();
  const screen = await svg.evaluate((el, from) => {
    const m = (el as SVGSVGElement).getScreenCTM()!;
    const p = new DOMPoint(from.x, from.y).matrixTransform(m);
    return { x: p.x, y: p.y, scale: m.a };
  }, from);
  await page.mouse.move(screen.x, screen.y);
  await page.mouse.down();
  await page.mouse.move(
    screen.x + delta.x * screen.scale,
    screen.y + delta.y * screen.scale,
    { steps: 6 },
  );
  if (cancel) await page.keyboard.press("Escape");
  await page.mouse.up();
}
test("grid and drag snapping preserve relative positions with an Alt bypass", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  const svg = page.getByRole("img", { name: "プロセス画面", exact: true });
  await page.getByLabel("グリッド表示", { exact: true }).check();
  await page.getByLabel("グリッドにスナップ", { exact: true }).check();
  await page.getByLabel("グリッド間隔", { exact: true }).selectOption("20");
  await expect(svg.locator("[data-grid]")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "元に戻す", exact: true }),
  ).toBeDisabled();
  const list = page.getByRole("navigation", { name: "図形一覧" });
  await list
    .getByRole("button", { name: "rectangle · 3", exact: true })
    .click();
  await list
    .getByRole("button", { name: "ellipse · 4", exact: true })
    .click({ modifiers: ["Shift"] });
  await drag(page, svg, { x: 200, y: 250 }, { x: 17, y: -7 });
  const objects = svg.locator("[data-object-id]");
  await expect(objects.nth(0)).toHaveAttribute(
    "transform",
    "translate(120 160)",
  );
  await expect(objects.nth(1)).toHaveAttribute(
    "transform",
    "translate(590 180)",
  );
  await page.keyboard.down("Alt");
  await drag(page, svg, { x: 220, y: 240 }, { x: 7, y: 3 });
  await page.keyboard.up("Alt");
  const position = await objects.nth(0).evaluate((el) => {
    const m = (el as SVGGElement).transform.baseVal.consolidate()!.matrix;
    return { x: m.e, y: m.f };
  });
  expect(position.x).toBeCloseTo(127, 0);
  expect(position.y).toBeCloseTo(163, 0);
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect(objects.nth(0)).toHaveAttribute(
    "transform",
    "translate(120 160)",
  );
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect(objects.nth(0)).toHaveAttribute(
    "transform",
    "translate(100 170)",
  );
  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
  await expect(svg.locator("[data-grid]")).toHaveCount(0);
});
test("pipe vertices snap in screen coordinates, support keyboard and cancel without adding history", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.getByRole("button", { name: "配管を追加", exact: true }).click();
  await page.getByLabel("x", { exact: true }).fill("13");
  await page.getByLabel("y", { exact: true }).fill("17");
  await page.getByRole("button", { name: "変更を適用", exact: true }).click();
  await page.getByLabel("グリッドにスナップ", { exact: true }).check();
  const svg = page.getByRole("img", { name: "プロセス画面", exact: true });
  await expect(svg.locator("[data-vertex-index]")).toHaveCount(4);
  // CSS pixel rounding must not place the end exactly halfway between grid lines.
  await drag(page, svg, { x: 133, y: 17 }, { x: 14, y: 20 });
  await expect(page.getByLabel("頂点", { exact: true })).toHaveValue(
    "0,0\n137,23\n120,100\n240,100",
  );
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect(page.getByLabel("頂点", { exact: true })).toHaveValue(
    "0,0\n120,0\n120,100\n240,100",
  );
  await page.getByRole("button", { name: "やり直す", exact: true }).click();
  const handle = svg.locator('[data-vertex-index="1"]');
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByLabel("頂点", { exact: true })).toHaveValue(
    "0,0\n147,33\n120,100\n240,100",
  );
  await drag(page, svg, { x: 160, y: 50 }, { x: 40, y: 40 }, true);
  await expect(page.getByLabel("頂点", { exact: true })).toHaveValue(
    "0,0\n147,33\n120,100\n240,100",
  );
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Project JSON を保存" }).click();
  const download = await downloading,
    json = await readFile((await download.path())!, "utf8"),
    saved = JSON.parse(json);
  expect(saved.manifest.projectRevision).toBe(8);
  expect(saved.screens[0].objects.at(-1)).toMatchObject({
    x: 13,
    y: 17,
    shape: {
      points: [
        { x: 0, y: 0 },
        { x: 147, y: 33 },
        { x: 120, y: 100 },
        { x: 240, y: 100 },
      ],
    },
  });
  expect(Object.keys(saved).sort()).toEqual(["manifest", "screens", "symbols"]);
  await page.getByLabel("Project JSON を開く", { exact: true }).setInputFiles({
    name: "vertices.json",
    mimeType: "application/json",
    buffer: Buffer.from(json),
  });
  await page.getByRole("button", { name: "polyline · 6", exact: true }).click();
  await expect(page.getByLabel("頂点", { exact: true })).toHaveValue(
    "0,0\n147,33\n120,100\n240,100",
  );
  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
  await expect(svg.locator("[data-vertex-index]")).toHaveCount(0);
});
test("a degenerate arrow line preview never crashes and rejected edits keep history unchanged", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.getByRole("button", { name: "線を追加", exact: true }).click();
  await page.getByLabel("矢印", { exact: true }).selectOption("end");
  await page.getByRole("button", { name: "変更を適用", exact: true }).click();
  const svg = page.getByRole("img", { name: "プロセス画面", exact: true });
  await drag(page, svg, { x: 220, y: 40 }, { x: -180, y: 0 });
  await expect(page.getByTestId("project-status")).toContainText(
    "線には異なる2点が必要",
  );
  await expect(page.getByLabel("頂点", { exact: true })).toHaveValue(
    "0,0\n180,0",
  );
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect(svg.locator("[data-object-id]")).toHaveCount(3);
  expect(errors).toEqual([]);
});
