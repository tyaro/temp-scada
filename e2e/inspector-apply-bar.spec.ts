import { test, expect, type Page } from "@playwright/test";
import processSample from "../examples/process.project.json" with { type: "json" };
import { selectPanel } from "./helpers/designer";

// UX精査 P1-2: 「変更を適用」は Inspector の下端に固定し、未適用があるときだけ強調する。
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const inspector = (page: Page) =>
  page.getByRole("complementary", { name: "プロパティパネル", exact: true });

async function start(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.goto("/");
  await button(page, "編集").click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "project.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(processSample)),
  });
  await selectPanel(page, "レイヤー");
}

for (const [width, height] of [
  [1280, 800],
  [1920, 1080],
] as const) {
  test(`apply button stays visible at the bottom and marks unapplied input at ${width}x${height}`, async ({
    page,
  }) => {
    await start(page, width, height);
    await page
      .getByRole("navigation", { name: "図形一覧" })
      .getByRole("button", { name: "rectangle · 3", exact: true })
      .click();
    const apply = inspector(page).getByRole("button", {
      name: "変更を適用",
      exact: true,
    });
    const pending = inspector(page).getByText("未適用の変更があります", {
      exact: true,
    });
    await expect(apply).toBeInViewport();
    await expect(pending).toHaveCount(0);
    await expect(
      inspector(page).getByText(
        "数値は Enter、ほかは「変更を適用」で確定 · Esc で取消",
        { exact: true },
      ),
    ).toBeVisible();
    // 詳細の説明はキーボードで開け、数値欄の説明として読み上げられる。
    const help = inspector(page).getByText("適用前にほかの図形や画面へ移ると", {
      exact: false,
    });
    await expect(help).toBeHidden();
    await inspector(page)
      .locator("summary", { hasText: "数値は Enter" })
      .focus();
    await page.keyboard.press("Enter");
    await expect(help).toBeVisible();
    await expect(
      inspector(page).getByLabel("不透明度（%）", { exact: true }),
    ).toHaveAccessibleDescription(/0%でもレイヤーから選択できます/);
    for (const label of ["X", "Y", "幅", "高さ", "回転角度"])
      await expect(
        inspector(page).getByLabel(label, { exact: true }),
      ).toBeVisible();

    await page.getByLabel("配置名", { exact: true }).fill("原水槽");
    await expect(pending).toBeVisible();
    await expect(apply).toBeInViewport();
    await apply.click();
    await expect(pending).toHaveCount(0);
    await expect(page.getByLabel("配置名", { exact: true })).toHaveValue(
      "原水槽",
    );
  });
}
