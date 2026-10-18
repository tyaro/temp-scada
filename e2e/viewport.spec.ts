import { selectPanel } from "./helpers/designer";
import { test, expect, type Locator, type Page } from "@playwright/test";
async function designDrag(
  page: Page,
  svg: Locator,
  from: { x: number; y: number },
  delta: { x: number; y: number },
) {
  const viewport = page.getByRole("region", {
    name: "キャンバス操作領域",
  });
  const sheet = await page
    .getByTestId("canvas-sheet")
    .evaluate((el) => ({ x: el.offsetLeft, y: el.offsetTop }));
  const scale = await svg.evaluate(
    (el) => (el as SVGSVGElement).getScreenCTM()!.a,
  );
  await viewport.evaluate(
    (el, { sheet, scale, from }) => {
      el.scrollLeft = sheet.x + from.x * scale - el.clientWidth / 2;
      el.scrollTop = sheet.y + from.y * scale - el.clientHeight / 2;
    },
    { sheet, scale, from },
  );
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
    { steps: 5 },
  );
  await page.mouse.up();
}
for (const percentage of [25, 100, 400])
  test(`editing at ${percentage}% uses design coordinates for movement, resize and vertices`, async ({
    page,
  }) => {
    await page.goto("/");
    const button = (name: string) =>
      page.getByRole("button", { name, exact: true });
    await button("編集").click();
    await page
      .getByLabel("表示倍率", { exact: true })
      .selectOption(String(percentage / 100));
    const svg = page.getByRole("img", { name: "プロセス画面", exact: true });
    await expect
      .poll(() => svg.evaluate((el) => (el as SVGSVGElement).getScreenCTM()!.a))
      .toBeCloseTo(percentage / 100, 3);
    await selectPanel(page, "レイヤー");
    await page
      .getByRole("navigation", { name: "図形一覧" })
      .getByRole("button", { name: "rectangle · 3", exact: true })
      .click();
    await designDrag(page, svg, { x: 200, y: 250 }, { x: 40, y: -20 });
    await expect(page.getByLabel("x", { exact: true })).toHaveValue("140");
    await expect(page.getByLabel("y", { exact: true })).toHaveValue("150");
    await button("元に戻す").click();
    await designDrag(page, svg, { x: 360, y: 350 }, { x: 40, y: 20 });
    await expect(page.getByLabel("width", { exact: true })).toHaveValue("300");
    await expect(page.getByLabel("height", { exact: true })).toHaveValue("200");
    await button("元に戻す").click();
    await selectPanel(page, "部品");
    await button("配管を追加").click();
    const pipeOrigin = {
      x: Number(await page.getByLabel("x", { exact: true }).inputValue()),
      y: Number(await page.getByLabel("y", { exact: true }).inputValue()),
    };
    await designDrag(
      page,
      svg,
      { x: pipeOrigin.x + 120, y: pipeOrigin.y },
      { x: 40, y: 20 },
    );
    await expect(page.getByLabel("頂点", { exact: true })).toHaveValue(
      "0,0\n160,20\n120,100\n240,100",
    );
  });
test("pan is temporary navigation, supports Space/middle button and Escape, and does not edit placements", async ({
  page,
}) => {
  await page.goto("/");
  const button = (name: string) =>
    page.getByRole("button", { name, exact: true });
  await button("編集").click();
  await page.getByLabel("表示倍率", { exact: true }).selectOption("2");
  const viewport = page.getByRole("region", {
    name: "キャンバス操作領域",
  });
  await selectPanel(page, "レイヤー");
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "rectangle · 3", exact: true })
    .click();
  await button("パンツール").click();
  const read = () =>
    viewport.evaluate((el) => ({ x: el.scrollLeft, y: el.scrollTop }));
  const before = await read();
  const drag = async (cancel = false, middle = false) => {
    const box = (await viewport.boundingBox())!,
      x = box.x + box.width / 2,
      y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down({ button: middle ? "middle" : "left" });
    await page.mouse.move(x - 80, y - 40, { steps: 4 });
    if (cancel) await page.keyboard.press("Escape");
    await page.mouse.up({ button: middle ? "middle" : "left" });
  };
  await drag();
  const after = await read();
  expect(after.x - before.x).toBeCloseTo(80, 0);
  expect(after.y - before.y).toBeCloseTo(40, 0);
  await drag(true);
  expect(await read()).toEqual(after);
  await button("選択ツール").click();
  await viewport.focus();
  await page.keyboard.down("Space");
  await drag();
  await page.keyboard.up("Space");
  const space = await read();
  expect(space.x - after.x).toBeCloseTo(80, 0);
  await drag(false, true);
  expect((await read()).x - space.x).toBeCloseTo(80, 0);
  await expect(page.getByLabel("x", { exact: true })).toHaveValue("100");
  await expect(button("元に戻す")).toBeDisabled();
  expect(
    await viewport.evaluate((el) =>
      el.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "+",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    ),
  ).toBe(true);
});
test("view settings survive target and preview switches, reset on import, and never enter exported project", async ({
  page,
}) => {
  await page.goto("/");
  const button = (name: string) =>
    page.getByRole("button", { name, exact: true });
  await button("編集").click();
  await page.getByLabel("表示倍率", { exact: true }).selectOption("2");
  const viewport = page.getByRole("region", {
    name: "キャンバス操作領域",
  });
  await viewport.evaluate((el) => {
    el.scrollLeft = 200;
    el.scrollTop = 80;
  });
  await expect.poll(() => viewport.evaluate((el) => el.scrollLeft)).toBe(200);
  await selectPanel(page, "プロジェクト");
  await button("画面を追加").click();
  await page.getByLabel("表示倍率", { exact: true }).selectOption("0.5");
  await page
    .getByRole("navigation", { name: "画面一覧" })
    .getByRole("button", { name: "プロセス画面", exact: true })
    .click();
  await expect(page.getByLabel("表示倍率", { exact: true })).toHaveValue("2");
  await expect.poll(() => viewport.evaluate((el) => el.scrollLeft)).toBe(200);
  await button("表示プレビュー").click();
  await expect(page.getByRole("group", { name: "キャンバス表示" })).toHaveCount(
    0,
  );
  await button("編集").click();
  await expect(page.getByLabel("表示倍率", { exact: true })).toHaveValue("2");
  await expect.poll(() => viewport.evaluate((el) => el.scrollLeft)).toBe(200);
  const downloading = page.waitForEvent("download");
  await button("Project JSON を保存").click();
  const download = await downloading;
  const path = (await download.path())!;
  const { readFile } = await import("node:fs/promises");
  const json = await readFile(path, "utf8"),
    saved = JSON.parse(json);
  expect(saved.manifest.projectRevision).toBe(2);
  expect(Object.keys(saved.screens[0]).sort()).toEqual([
    "background",
    "height",
    "id",
    "name",
    "objects",
    "width",
  ]);
  await page.getByLabel("Project JSON を開く", { exact: true }).setInputFiles({
    name: "view.json",
    mimeType: "application/json",
    buffer: Buffer.from(json),
  });
  await expect(page.getByLabel("表示倍率", { exact: true })).toHaveValue("fit");
  await expect(button("元に戻す")).toBeDisabled();
});
test("adding parts while zoomed centers them in the visible viewport in a single undo step", async ({
  page,
}) => {
  await page.goto("/");
  const button = (name: string) =>
    page.getByRole("button", { name, exact: true });
  await button("編集").click();
  await page.getByLabel("表示倍率", { exact: true }).selectOption("4");
  const viewport = page.getByRole("region", { name: "キャンバス操作領域" });
  await viewport.evaluate((el) => {
    el.scrollLeft = 800;
    el.scrollTop = 500;
  });
  const center = await page
    .getByRole("img", { name: "プロセス画面", exact: true })
    .evaluate((el) => {
      const viewport = el.closest(".viewport")!,
        box = viewport.getBoundingClientRect();
      const point = new DOMPoint(
        box.x + viewport.clientLeft + viewport.clientWidth / 2,
        box.y + viewport.clientTop + viewport.clientHeight / 2,
      ).matrixTransform((el as SVGSVGElement).getScreenCTM()!.inverse());
      return { x: point.x, y: point.y };
    });
  await selectPanel(page, "部品");
  await button("Rectangle を追加").click();
  expect(
    Number(await page.getByLabel("x", { exact: true }).inputValue()),
  ).toBeCloseTo(center.x - 80, 2);
  expect(
    Number(await page.getByLabel("y", { exact: true }).inputValue()),
  ).toBeCloseTo(center.y - 50, 2);
  await expect(
    page
      .getByRole("img", { name: "プロセス画面", exact: true })
      .locator("[data-object-id]")
      .last(),
  ).toBeInViewport();
  await button("元に戻す").click();
  await expect(button("元に戻す")).toBeDisabled();
});
