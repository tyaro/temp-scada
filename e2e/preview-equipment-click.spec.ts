import { test, expect, type Page } from "@playwright/test";
import sample from "../examples/read-presentation.project.json" with { type: "json" };
import { mainCanvas } from "./helpers/designer";

// UX精査 F-2: 表示プレビューで、機器を関連付けた Symbol から既存の読取詳細の小窓を開く。
const button = (p: Page, name: string) =>
  p.getByRole("button", { name, exact: true });
const [pump, spare] = sample.equipment;
const symbol = (p: Page, id: string) =>
  mainCanvas(p).locator(`g[data-object-id="${id}"]`);
const linkedId = "0199f600-0000-7000-8000-000000000020";
const spareId = "0199f600-0000-7000-8000-000000000021";
const unlinkedId = "0199f600-0000-7000-8000-000000000022";
const popup = (p: Page, id: string) =>
  p.locator(`[data-preview-popup="${id}"][data-popup-kind="equipment"]`);

async function start(p: Page) {
  await p.setViewportSize({ width: 1920, height: 1080 });
  await p.goto("/");
  await button(p, "編集").click();
  await p.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "equipment-click.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(sample)),
  });
}

test("edit mode keeps equipment Symbols as plain drawing objects", async ({
  page,
}) => {
  await start(page);
  await expect(mainCanvas(page).locator("[data-equipment-link]")).toHaveCount(
    0,
  );
  await expect(symbol(page, linkedId)).not.toHaveAttribute("role", "button");
});

test("preview Symbol with equipment opens the existing read-detail window by click and keyboard", async ({
  page,
}) => {
  await start(page);
  await button(page, "表示プレビュー").click();
  const linked = symbol(page, linkedId);
  await expect(linked).toHaveAttribute("role", "button");
  await expect(linked).toHaveAttribute("data-equipment-link", pump.id);
  await expect(linked.locator(":scope > title")).toHaveText(
    `${pump.code} ${pump.name}`,
  );
  expect(await linked.evaluate((el) => getComputedStyle(el).cursor)).toBe(
    "pointer",
  );
  // 関連付けのない Symbol は無反応。
  const unlinked = symbol(page, unlinkedId);
  await expect(unlinked).not.toHaveAttribute("role", "button");
  await unlinked.click({ force: true });
  await expect(page.locator('[data-popup-kind="equipment"]')).toHaveCount(0);

  await button(page, `${pump.code} ${pump.name}の読取詳細を開く`).click();
  await expect(popup(page, pump.id)).toBeVisible();
  await expect(popup(page, pump.id)).toContainText(
    `${pump.code} · ${pump.name}`,
  );
  await popup(page, pump.id).locator("[data-popup-move]").press("Escape");
  await expect(popup(page, pump.id)).toHaveCount(0);
  await expect(linked).toBeFocused();

  await symbol(page, spareId).focus();
  await page.keyboard.press("Enter");
  await expect(popup(page, spare.id)).toBeVisible();
  // ツールバーの一覧からの入口は残る。
  await expect(button(page, "機器の読取詳細")).toBeEnabled();
});

test("full-screen preview also opens read details from the drawing", async ({
  page,
}) => {
  await start(page);
  await button(page, "表示プレビュー").click();
  await button(page, "全画面で表示確認").click();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.fullscreenElement === document.documentElement,
      ),
    )
    .toBe(true);
  await button(page, `${pump.code} ${pump.name}の読取詳細を開く`).click();
  await expect(popup(page, pump.id)).toBeVisible();
});
