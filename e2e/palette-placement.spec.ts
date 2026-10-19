import { fileCommand, selectPanel } from "./helpers/designer";
import { test, expect, type Page, type Locator } from "@playwright/test";
import { readFile } from "node:fs/promises";

const canvas = (page: Page) =>
  page.getByRole("region", { name: "キャンバス操作領域", exact: true });
async function beginDrag(page: Page, source: Locator) {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent("dragstart", { dataTransfer });
  return dataTransfer;
}
async function centerAt(page: Page, x: number, y: number) {
  return page.getByTestId("canvas-sheet").evaluate(
    (sheet, point) => {
      const svg = sheet.querySelector("svg")!;
      const result = new DOMPoint(point.x, point.y).matrixTransform(
        svg.getScreenCTM()!,
      );
      return { clientX: result.x, clientY: result.y };
    },
    { x, y },
  );
}

test("icon/name views preserve search, category expansion and drafts and persist as a UI preference", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.getByLabel("画面名", { exact: true }).fill("未適用の名前");
  await selectPanel(page, "部品");
  const palette = page.getByRole("region", { name: "部品パレット" });
  const rectangle = palette.getByRole("button", {
    name: "Rectangle を追加",
    exact: true,
  });
  const iconBox = (await rectangle.boundingBox())!;
  expect(iconBox.height).toBe(44);
  expect(iconBox.width).toBeLessThan(64);
  await rectangle.focus();
  await expect(rectangle).toHaveAttribute("title", "Rectangle を追加");
  expect(
    (await palette.locator(".search-tools").boundingBox())!.height,
  ).toBeLessThanOrEqual(40);
  const basic = palette.getByRole("button", { name: /^基本図形/ });
  await basic.click();
  await palette.getByRole("button", { name: "名称一覧", exact: true }).click();
  await expect(basic).toHaveAttribute("aria-expanded", "false");
  const search = palette.getByRole("searchbox", { name: "部品を検索" });
  await search.fill("ＰＵＭＰ");
  const pump = palette.getByRole("button", {
    name: "ポンプを追加",
    exact: true,
  });
  expect((await pump.boundingBox())!.width).toBeGreaterThan(150);
  await expect(pump.locator("span")).toBeVisible();
  await palette
    .getByRole("button", { name: "アイコン一覧", exact: true })
    .click();
  await expect(search).toHaveValue("ＰＵＭＰ");
  await palette
    .getByRole("button", { name: "検索をクリア", exact: true })
    .click();
  await expect(basic).toHaveAttribute("aria-expanded", "false");
  await palette.getByRole("button", { name: "名称一覧", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "元に戻す", exact: true }),
  ).toBeDisabled();
  await selectPanel(page, "プロジェクト");
  await expect(page.getByLabel("画面名", { exact: true })).toHaveValue(
    "未適用の名前",
  );
  await page.getByLabel("画面名", { exact: true }).fill("プロセス画面");
  await expect
    .poll(() =>
      page.evaluate(() =>
        localStorage.getItem("banto.ui.scada.designer.palette-view"),
      ),
    )
    .toBe("names");
  await page.reload();
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await selectPanel(page, "部品");
  await expect(
    palette.getByRole("button", { name: "名称一覧", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

for (const zoom of [0.25, 1, 4]) {
  test(`native palette drag places a primitive at the drop point at ${zoom * 100}% with one undo step`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.getByRole("button", { name: "編集", exact: true }).click();
    await selectPanel(page, "部品");
    await page
      .getByLabel("表示倍率", { exact: true })
      .selectOption(String(zoom));
    if (zoom === 4)
      await canvas(page).evaluate((el) => {
        el.scrollLeft = 630;
        el.scrollTop = 370;
      });
    const target = (await canvas(page).boundingBox())!;
    const drop = { x: target.width / 2, y: target.height / 2 };
    await page
      .getByRole("button", { name: "Rectangle を追加", exact: true })
      .dragTo(canvas(page), { targetPosition: drop });
    const svg = page.getByRole("img", { name: "プロセス画面", exact: true });
    await expect(svg.locator("[data-object-id]")).toHaveCount(4);
    const expected = await svg.evaluate(
      (el, point) => {
        const p = new DOMPoint(point.x, point.y).matrixTransform(
          (el as SVGSVGElement).getScreenCTM()!.inverse(),
        );
        return { x: p.x, y: p.y };
      },
      { x: target.x + drop.x, y: target.y + drop.y },
    );
    const x = Number(await page.getByLabel("x", { exact: true }).inputValue());
    const y = Number(await page.getByLabel("y", { exact: true }).inputValue());
    const width = Number(
      await page.getByLabel("width", { exact: true }).inputValue(),
    );
    const height = Number(
      await page.getByLabel("height", { exact: true }).inputValue(),
    );
    expect(Math.abs(x + width / 2 - expected.x)).toBeLessThan(2 / zoom);
    expect(Math.abs(y + height / 2 - expected.y)).toBeLessThan(2 / zoom);
    await page.getByRole("button", { name: "元に戻す", exact: true }).click();
    await expect(svg.locator("[data-object-id]")).toHaveCount(3);
    await page.getByRole("button", { name: "やり直す", exact: true }).click();
    await expect(svg.locator("[data-object-id]")).toHaveCount(4);
  });
}

test("dragging shared symbols from the name list preserves definition identity through JSON", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await selectPanel(page, "部品");
  await page.getByRole("button", { name: "名称一覧", exact: true }).click();
  await page
    .getByRole("button", { name: "ポンプを追加", exact: true })
    .dragTo(canvas(page));
  const source = page
    .getByRole("region", { name: "部品パレット" })
    .getByRole("button", { name: "ポンプ を配置", exact: true });
  await source.dragTo(canvas(page));
  const svg = page.getByRole("img", { name: "プロセス画面", exact: true });
  await expect(svg.locator("[data-symbol-id]")).toHaveCount(2);
  const ids = await svg
    .locator("[data-symbol-id]")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-symbol-id")));
  expect(ids[1]).toBe(ids[0]);
  const downloading = page.waitForEvent("download");
  await fileCommand(page, "Project JSON を保存");
  const json = await readFile((await (await downloading).path())!, "utf8");
  const saved = JSON.parse(json);
  expect(saved.symbols).toHaveLength(1);
  expect(saved.manifest.projectRevision).toBe(3);
  await page.getByLabel("Project JSON を開く", { exact: true }).setInputFiles({
    name: "dropped.json",
    mimeType: "application/json",
    buffer: Buffer.from(json),
  });
  await expect(svg.locator("[data-symbol-id]")).toHaveCount(2);
});

test("drop snaps the center, permits an Alt bypass, and ignores cancelled, external and preview drops", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await selectPanel(page, "部品");
  await page.getByLabel("グリッドにスナップ", { exact: true }).check();
  await page.getByLabel("グリッド間隔", { exact: true }).selectOption("50");
  const source = page.getByRole("button", {
    name: "Rectangle を追加",
    exact: true,
  });
  const svg = page.getByRole("img", { name: "プロセス画面", exact: true });
  const point = await centerAt(page, 333, 217);
  for (const altKey of [false, true]) {
    const dataTransfer = await beginDrag(page, source);
    await canvas(page).dispatchEvent("dragover", {
      dataTransfer,
      ...point,
      altKey,
    });
    await expect(page.locator(".drop-marker")).toHaveCount(1);
    await canvas(page).dispatchEvent("drop", {
      dataTransfer,
      ...point,
      altKey,
    });
    await source.dispatchEvent("dragend", { dataTransfer });
    const x = Number(await page.getByLabel("x", { exact: true }).inputValue());
    const y = Number(await page.getByLabel("y", { exact: true }).inputValue());
    const w = Number(
      await page.getByLabel("width", { exact: true }).inputValue(),
    );
    const h = Number(
      await page.getByLabel("height", { exact: true }).inputValue(),
    );
    expect(Math.abs(x + w / 2 - (altKey ? 333 : 350))).toBeLessThan(2);
    expect(Math.abs(y + h / 2 - (altKey ? 217 : 200))).toBeLessThan(2);
    await dataTransfer.dispose();
  }
  const cancelled = await beginDrag(page, source);
  await source.dispatchEvent("dragend", { dataTransfer: cancelled });
  await canvas(page).dispatchEvent("drop", {
    dataTransfer: cancelled,
    ...point,
  });
  await expect(svg.locator("[data-object-id]")).toHaveCount(5);
  const external = await page.evaluateHandle(() => {
    const d = new DataTransfer();
    d.setData("application/x-banto-scada-part", "untrusted");
    return d;
  });
  await canvas(page).dispatchEvent("drop", {
    dataTransfer: external,
    ...point,
  });
  await expect(svg.locator("[data-object-id]")).toHaveCount(5);
  const dataTransfer = await beginDrag(page, source);
  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
  await canvas(page).dispatchEvent("drop", { dataTransfer, ...point });
  await expect(svg.locator("[data-object-id]")).toHaveCount(5);
  await expect(page.locator(".drop-marker")).toHaveCount(0);
});

test("deferred drops preserve the chosen point and respect draft cancellation", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.getByLabel("画面名", { exact: true }).fill("配置先の工程");
  await selectPanel(page, "部品");
  const source = page.getByRole("button", {
    name: "Rectangle を追加",
    exact: true,
  });
  const point = await centerAt(page, 400, 300);
  const prompt = page.getByRole("dialog", { name: "未適用の入力があります" });
  for (const apply of [false, true]) {
    const dataTransfer = await beginDrag(page, source);
    await canvas(page).dispatchEvent("drop", { dataTransfer, ...point });
    await source.dispatchEvent("dragend", { dataTransfer });
    await expect(prompt).toBeVisible();
    await prompt
      .getByRole("button", {
        name: apply ? "適用して続行" : "キャンセル",
        exact: true,
      })
      .click();
    if (!apply)
      await expect(
        page
          .getByRole("img", { name: "プロセス画面", exact: true })
          .locator("[data-object-id]"),
      ).toHaveCount(3);
    await dataTransfer.dispose();
  }
  await expect(
    page
      .getByRole("img", { name: "配置先の工程", exact: true })
      .locator("[data-object-id]"),
  ).toHaveCount(4);
  const x = Number(await page.getByLabel("x", { exact: true }).inputValue());
  const w = Number(
    await page.getByLabel("width", { exact: true }).inputValue(),
  );
  expect(Math.abs(x + w / 2 - 400)).toBeLessThan(2);
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect(
    page
      .getByRole("img", { name: "配置先の工程", exact: true })
      .locator("[data-object-id]"),
  ).toHaveCount(3);
});

test("changing targets invalidates a drag and shared definitions accept only primitive parts", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.getByRole("button", { name: "画面を追加", exact: true }).click();
  await selectPanel(page, "部品");
  const stale = await beginDrag(
    page,
    page.getByRole("button", { name: "Rectangle を追加", exact: true }),
  );
  await selectPanel(page, "プロジェクト");
  await page
    .getByRole("navigation", { name: "画面一覧" })
    .getByRole("button", { name: "プロセス画面", exact: true })
    .click();
  await canvas(page).dispatchEvent("drop", {
    dataTransfer: stale,
    ...(await centerAt(page, 400, 300)),
  });
  await expect(
    page
      .getByRole("img", { name: "プロセス画面", exact: true })
      .locator("[data-object-id]"),
  ).toHaveCount(3);
  await stale.dispose();
  await selectPanel(page, "部品");
  const builtin = page.getByRole("button", {
    name: "ポンプを追加",
    exact: true,
  });
  await builtin.dragTo(canvas(page));
  const beforeDefinition = await beginDrag(page, builtin);
  await page
    .getByRole("button", { name: "参照する Symbol 定義を編集", exact: true })
    .click();
  const definition = page.getByRole("img", { name: "ポンプ", exact: true });
  const count = await definition.locator("[data-object-id]").count();
  await canvas(page).dispatchEvent("drop", {
    dataTransfer: beforeDefinition,
    ...(await centerAt(page, 50, 50)),
  });
  await expect(definition.locator("[data-object-id]")).toHaveCount(count);
  await selectPanel(page, "部品");
  await expect(builtin).toHaveCount(0);
  await page
    .getByRole("button", { name: "Rectangle を追加", exact: true })
    .dragTo(canvas(page));
  await expect(definition.locator("[data-object-id]")).toHaveCount(count + 1);
});
