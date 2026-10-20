import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/bool-colors.project.json" with { type: "json" };
import { chooseTheme, fileCommand, selectPanel } from "./helpers/designer";
for (const theme of ["light", "dark"] as const)
  test(`read status is independent of authored Text, paged and scoped to main/popup in ${theme}`, async ({
    page,
  }) => {
    const payload: any = structuredClone(sample);
    payload.symbols[0].objects[5].visible = false;
    payload.symbols[0].objects[5].opacity = 0;
    for (let index = 0; index < 11; index++) {
      const copy = structuredClone(payload.screens[0].objects[0]);
      copy.id = `0199f600-0000-7000-8000-${String(600 + index).padStart(12, "0")}`;
      copy.order = 20 + index;
      copy.name = `追加配置 ${index + 1}`;
      payload.screens[0].objects.push(copy);
    }
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto("/");
    await chooseTheme(page, theme);
    await page.getByRole("button", { name: "編集", exact: true }).click();
    await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
      name: "status.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(payload)),
    });
    const status = page.locator('details[aria-label^="読取状態："]').first();
    const assertLayout = async () => {
      const caption = await page
        .locator("main > section > .toolbar")
        .boundingBox();
      const disclosure = await status.boundingBox();
      const canvas = await page.locator(".canvas-workspace").boundingBox();
      expect(disclosure!.y).toBeGreaterThanOrEqual(
        caption!.y + caption!.height,
      );
      expect(canvas!.y).toBeGreaterThanOrEqual(
        disclosure!.y + disclosure!.height,
      );
    };
    await assertLayout();
    await expect(status.locator("summary")).toContainText("表示参照 28件");
    await expect(status.locator("summary")).toContainText("取得不能 28件");
    await expect(status.locator("[data-slot-status-key]")).toHaveCount(0);
    await status.locator("summary").click();
    await expect(status.locator("[data-slot-status-key]")).toHaveCount(20);
    await assertLayout();
    await expect(status).toContainText("機器未関連付け");
    await expect(status).toContainText("未採用");
    await status.getByRole("button", { name: "次へ", exact: true }).click();
    await expect(status.locator("[data-slot-status-key]")).toHaveCount(8);
    await expect(
      status.getByRole("button", { name: "次へ", exact: true }),
    ).toBeDisabled();
    await status.locator("summary").evaluate((element) => {
      element.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await expect(status.locator("[data-slot-status-key]")).toHaveCount(8);
    await status
      .getByRole("region", { name: "slotの読取状態一覧", exact: true })
      .focus();
    await page.keyboard.press("Escape");
    await expect(status.locator("summary")).toBeFocused();
    await expect(status.locator("[data-slot-status-key]")).toHaveCount(0);
    await status.locator("summary").press("Enter");
    await expect(status.locator("[data-slot-status-key]")).toHaveCount(8);
    await page
      .getByRole("button", { name: "表示プレビュー", exact: true })
      .click();
    await page
      .getByRole("button", { name: "画面を小窓で表示確認", exact: true })
      .click();
    const picker = page.getByRole("dialog", {
      name: "画面を小窓で表示確認",
      exact: true,
    });
    await picker.locator(`input[value="${payload.screens[0].id}"]`).check();
    await picker
      .getByRole("button", { name: "小窓を表示", exact: true })
      .click();
    const popup = page.locator(
      `[data-preview-popup="${payload.screens[0].id}"]`,
    );
    const popupStatus = popup.locator("details");
    await expect(popupStatus.locator("summary")).toContainText("表示参照 28件");
    await expect(popupStatus.locator("[data-slot-status-key]")).toHaveCount(0);
    await popupStatus.locator("summary").click();
    await expect(popupStatus.locator("[data-slot-status-key]")).toHaveCount(20);
    await popupStatus
      .getByRole("region", { name: "slotの読取状態一覧", exact: true })
      .focus();
    await page.keyboard.press("Escape");
    await expect(popup).toBeVisible();
    await expect(popupStatus.locator("[data-slot-status-key]")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
    const downloading = page.waitForEvent("download");
    await fileCommand(page, "Project を保存");
    const saved = JSON.parse(
      await readFile((await (await downloading).path())!, "utf8"),
    );
    expect(saved).toEqual(payload);
    // A replacement with the same IDs removes old detail rows and old role counts.
    await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
      name: "replacement.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(sample)),
    });
    await expect(page.locator("[data-preview-popup]")).toHaveCount(0);
    await expect(status.locator("summary")).toContainText("表示参照 6件");
    await expect(status.locator("[data-slot-status-key]")).toHaveCount(0);
  });

for (const theme of ["light", "dark"] as const)
  test(`read status resets between screen and definition in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto("/");
    await chooseTheme(page, theme);
    await page.getByRole("button", { name: "編集", exact: true }).click();
    await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
      name: "status.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(sample)),
    });
    const status = page.locator('details[aria-label^="読取状態："]').first();
    await status.locator("summary").click();
    await expect(status.locator("[data-slot-status-key]")).toHaveCount(6);
    await page.getByRole("button", { name: "編集", exact: true }).click();
    await selectPanel(page, "プロジェクト");
    await page.getByRole("button", { name: "定義を編集", exact: true }).click();
    await expect(status.locator("summary")).toContainText("表示参照 2件");
    await status.locator("summary").click();
    await expect(status.locator("[data-slot-status-key]")).toHaveCount(2);
    await page.getByRole("button", { name: "画面へ戻る", exact: true }).click();
    await expect(status.locator("summary")).toContainText("表示参照 6件");
    await expect(status.locator("[data-slot-status-key]")).toHaveCount(0);
  });
