import { test, expect, type Page } from "@playwright/test";
import { selectPanel } from "./helpers/designer";

const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const screens = (page: Page) =>
  page.getByRole("navigation", { name: "画面一覧" });
const row = (page: Page, name: string) =>
  screens(page).getByRole("button", { name, exact: true });
const menu = (page: Page, name: string) =>
  page.getByRole("menu", { name: `画面：${name} の操作`, exact: true });
async function start(page: Page, multiple = true) {
  await page.goto("/");
  await button(page, "編集").click();
  await selectPanel(page, "プロジェクト");
  if (multiple) {
    await button(page, "画面を追加").click();
    await button(page, "画面を追加").click();
  }
}
async function action(page: Page, name: string, command: string) {
  await row(page, name).click({ button: "right" });
  await menu(page, name)
    .getByRole("menuitem", { name: command, exact: true })
    .click();
}

test("screen context opening preserves the active screen and draft; rename resolves drafts and focuses the target", async ({
  page,
}) => {
  await start(page);
  await page.getByLabel("画面名", { exact: true }).fill("仕上工程");
  const target = row(page, "画面 2");
  await target.click({ button: "right" });
  await expect(menu(page, "画面 2")).toBeVisible();
  await expect(row(page, "画面 3")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(target).toBeFocused();
  await action(page, "画面 2", "名前変更");
  const prompt = page.getByRole("dialog", { name: "未適用の入力があります" });
  await prompt.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(row(page, "画面 3")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("画面名", { exact: true })).toHaveValue(
    "仕上工程",
  );
  await action(page, "画面 2", "名前変更");
  await prompt
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(row(page, "仕上工程")).toBeVisible();
  await expect(row(page, "画面 2")).toHaveAttribute("aria-pressed", "true");
  const input = page.getByLabel("画面名", { exact: true });
  await expect(input).toBeFocused();
  await input.fill("前処理");
  await button(page, "画面設定を適用").click();
  await expect(row(page, "前処理")).toBeVisible();
});

test("screen context commands act on an inactive row, preserve the current screen and undo in order", async ({
  page,
}) => {
  await start(page);
  await action(page, "画面 2", "画面を上へ");
  await expect(screens(page).locator("button[aria-pressed]")).toHaveText([
    "画面 2",
    "プロセス画面",
    "画面 3",
  ]);
  await expect(row(page, "画面 3")).toHaveAttribute("aria-pressed", "true");
  await action(page, "プロセス画面", "画面を複製");
  await expect(row(page, "プロセス画面 コピー")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(
    page
      .getByRole("img", { name: "プロセス画面 コピー", exact: true })
      .locator("[data-object-id]"),
  ).toHaveCount(3);
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("「画面 2」");
    await dialog.dismiss();
  });
  await action(page, "画面 2", "画面を削除");
  await expect(row(page, "画面 2")).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await action(page, "画面 2", "画面を削除");
  await expect(row(page, "画面 2")).toHaveCount(0);
  await expect(row(page, "プロセス画面 コピー")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await button(page, "元に戻す").click();
  await expect(row(page, "画面 2")).toBeVisible();
  await button(page, "元に戻す").click();
  await expect(row(page, "プロセス画面 コピー")).toHaveCount(0);
  await action(page, "画面 2", "開く");
  await expect(row(page, "画面 2")).toHaveAttribute("aria-pressed", "true");
});

test("screen context keyboard and named trigger expose limits and are absent in preview", async ({
  page,
}) => {
  await start(page, false);
  const target = row(page, "プロセス画面");
  await target.focus();
  await page.keyboard.press("Shift+F10");
  const popup = menu(page, "プロセス画面");
  for (const name of ["画面を上へ", "画面を下へ", "画面を削除"]) {
    await expect(
      popup.getByRole("menuitem", { name, exact: true }),
    ).toHaveAttribute("aria-disabled", "true");
  }
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await expect(popup).not.toBeVisible();
  await button(page, "操作：画面：プロセス画面").click();
  await expect(popup).toBeVisible();
  await page.keyboard.press("Escape");
  await button(page, "表示プレビュー").click();
  await target.click({ button: "right" });
  await expect(popup).toHaveCount(0);
  await expect(button(page, "操作：画面：プロセス画面")).toHaveCount(0);
});

test("screen menus close after project replacement and respect the screen limit", async ({
  page,
}) => {
  await start(page, false);
  const { readFile } = await import("node:fs/promises");
  const project = JSON.parse(
    await readFile("examples/minimal.project.json", "utf8"),
  );
  project.screens = Array.from({ length: 100 }, (_, i) => ({
    ...project.screens[0],
    id: `0199f100-0000-7000-8000-${String(i + 1000).padStart(12, "0")}`,
    name: `工程 ${i + 1}`,
    objects: [],
  }));
  const file = {
    name: "limit.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  };
  await page
    .getByLabel("Project JSON を開く", { exact: true })
    .setInputFiles(file);
  await row(page, "工程 1").click({ button: "right" });
  await expect(
    menu(page, "工程 1").getByRole("menuitem", {
      name: "画面を複製",
      exact: true,
    }),
  ).toHaveAttribute("aria-disabled", "true");
  // Same IDs and revision must still invalidate the old menu session.
  await page
    .getByLabel("Project JSON を開く", { exact: true })
    .setInputFiles(file);
  await expect(menu(page, "工程 1")).not.toBeVisible();
  await expect(screens(page).locator("button[aria-pressed]")).toHaveCount(100);
  await expect(button(page, "元に戻す")).toBeDisabled();
});

test("screen actions protect object drafts and keep selection when another screen is removed", async ({
  page,
}) => {
  await start(page);
  await row(page, "プロセス画面").click();
  await selectPanel(page, "レイヤー");
  await page
    .getByRole("button", { name: "rectangle · 3", exact: true })
    .click();
  await page.getByLabel("色", { exact: true }).fill("#aabbcc");
  await selectPanel(page, "プロジェクト");
  await action(page, "画面 2", "画面を削除");
  const prompt = page.getByRole("dialog", { name: "未適用の入力があります" });
  page.once("dialog", (dialog) => dialog.accept());
  await prompt
    .getByRole("button", { name: "入力を破棄して続行", exact: true })
    .click();
  await expect(row(page, "画面 2")).toHaveCount(0);
  await expect(row(page, "プロセス画面")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(
    page.locator('[data-object-id][data-selected="true"]'),
  ).toHaveCount(1);
  await expect(page.getByLabel("色", { exact: true })).not.toHaveValue(
    "#aabbcc",
  );
  const input = page.getByLabel("画面名", { exact: true });
  await input.click({ button: "right" });
  await expect(menu(page, "プロセス画面")).not.toBeVisible();
});
