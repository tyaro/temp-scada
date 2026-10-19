import { test, expect } from "@playwright/test";
import { selectPanel, chooseTheme } from "./helpers/designer";

const panels = ["プロジェクト", "レイヤー", "部品"] as const;

test("sidebar tabs use manual keyboard activation and expose only the active panel", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  const tab = (name: string) => page.getByRole("tab", { name, exact: true });
  await tab("プロジェクト").focus();
  await tab("プロジェクト").press("ArrowRight");
  await expect(tab("レイヤー")).toBeFocused();
  await expect(tab("プロジェクト")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(tab("レイヤー")).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("tabpanel", { name: "レイヤー", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("tabpanel")).toHaveCount(1);
  await tab("レイヤー").press("End");
  await expect(tab("部品")).toBeFocused();
  await page.keyboard.press(" ");
  await expect(tab("部品")).toHaveAttribute("aria-selected", "true");
  await tab("部品").press("ArrowRight");
  await expect(tab("プロジェクト")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(tab("プロジェクト")).toBeFocused();
  await page
    .getByRole("button", { name: "表示プレビュー", exact: true })
    .click();
  await expect(tab("プロジェクト")).toHaveAttribute("aria-selected", "true");
  await expect(tab("レイヤー")).toBeDisabled();
  await expect(tab("部品")).toBeDisabled();
});

test("switching panels preserves hidden screen drafts, selection, viewport and history", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await selectPanel(page, "レイヤー");
  const selected = page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "rectangle · 3", exact: true });
  await selected.click();
  await page.getByLabel("表示倍率", { exact: true }).selectOption("1");
  const canvas = page.getByRole("img", { name: "プロセス画面", exact: true });
  const before = await canvas.boundingBox();
  await selectPanel(page, "プロジェクト");
  await page.getByLabel("画面名", { exact: true }).fill("未適用の工程名");
  for (const name of ["部品", "レイヤー", "プロジェクト"] as const)
    await selectPanel(page, name);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("画面名", { exact: true })).toHaveValue(
    "未適用の工程名",
  );
  await expect(page.getByLabel("x", { exact: true })).toHaveValue("100");
  await expect(page.getByTestId("save-state")).toContainText("1 フォーム");
  await expect(
    page.getByRole("button", { name: "元に戻す", exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel("表示倍率", { exact: true })).toHaveValue("1");
  expect(await canvas.boundingBox()).toEqual(before);
  await selectPanel(page, "部品");
  await page
    .getByRole("button", { name: "Rectangle を追加", exact: true })
    .click();
  const prompt = page.getByRole("dialog", { name: "未適用の入力があります" });
  await prompt
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(
    page
      .getByRole("img", { name: "未適用の工程名", exact: true })
      .locator("[data-object-id]"),
  ).toHaveCount(4);
  await expect(page.getByTestId("save-state")).not.toContainText(
    "未適用の入力あり",
  );
  await selectPanel(page, "レイヤー");
  await expect(
    page
      .getByRole("navigation", { name: "図形一覧" })
      .locator('button[data-layer-id][aria-pressed="true"]'),
  ).toHaveCount(1);
});

test("applying invalid hidden screen input reveals its panel before reporting the error", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  const name = page.getByLabel("画面名", { exact: true });
  await name.fill("");
  await selectPanel(page, "部品");
  await page
    .getByRole("button", { name: "Rectangle を追加", exact: true })
    .click();
  const prompt = page.getByRole("dialog", { name: "未適用の入力があります" });
  await prompt
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "プロジェクト", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "元に戻す", exact: true }),
  ).toBeDisabled();
  await name.fill("   ");
  await selectPanel(page, "部品");
  await page
    .getByRole("button", { name: "Rectangle を追加", exact: true })
    .click();
  await prompt
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "プロジェクト", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("save-state")).toContainText(
    "未適用の入力あり",
  );
  await expect(
    page
      .getByRole("img", { name: "プロセス画面", exact: true })
      .locator("[data-object-id]"),
  ).toHaveCount(3);
});

test("palette searches closed categories temporarily and restores expansion and query across tabs", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await selectPanel(page, "部品");
  const palette = page.getByRole("region", { name: "部品パレット" });
  const basic = palette.getByRole("button", { name: /^基本図形/ });
  const symbols = palette.getByRole("button", { name: /^シンボル/ });
  const search = palette.getByRole("searchbox", { name: "部品を検索" });
  await basic.click();
  await symbols.click();
  await expect(
    palette.getByRole("button", { name: "Rectangle を追加", exact: true }),
  ).toHaveCount(0);
  await expect(
    palette.getByRole("button", { name: "Text を追加", exact: true }),
  ).toHaveCount(1);
  await search.fill("ＰＵＭＰ");
  await expect(symbols).toHaveAttribute("aria-expanded", "true");
  await expect(
    palette.getByRole("button", { name: "ポンプを追加", exact: true }),
  ).toBeVisible();
  await selectPanel(page, "プロジェクト");
  await selectPanel(page, "部品");
  await expect(search).toHaveValue("ＰＵＭＰ");
  await palette
    .getByRole("button", { name: "検索をクリア", exact: true })
    .click();
  await expect(basic).toHaveAttribute("aria-expanded", "false");
  await expect(symbols).toHaveAttribute("aria-expanded", "false");
  await search.fill("テキスト");
  await expect(
    palette.getByRole("button", { name: "Text を追加", exact: true }),
  ).toHaveCount(1);
  await expect(
    palette.getByRole("region", {
      name: "オブジェクト（監視部品）",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "元に戻す", exact: true }),
  ).toBeDisabled();
});

for (const theme of ["light", "dark"]) {
  test(`all sidebar panels remain usable in ${theme} at both desktop sizes`, async ({
    page,
  }, testInfo) => {
    await page.goto("/");
    await page.getByRole("button", { name: "編集", exact: true }).click();
    await chooseTheme(page, theme);
    for (const [width, height] of [
      [1280, 720],
      [1440, 900],
    ]) {
      await page.setViewportSize({ width, height });
      for (const name of panels) {
        await selectPanel(page, name);
        await expect(
          page.getByRole("tab", { name, exact: true }),
        ).toBeInViewport();
        await expect(
          page.getByRole("tabpanel", { name, exact: true }),
        ).toBeInViewport();
        await expect(
          page.getByRole("button", {
            name: "Project を保存",
            exact: true,
          }),
        ).toHaveCount(0);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
      }
      await page.screenshot({
        path: testInfo.outputPath(`sidebar-${width}.png`),
        animations: "disabled",
      });
    }
  });
}
