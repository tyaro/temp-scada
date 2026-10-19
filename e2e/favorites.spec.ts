import { fileCommand, chooseTheme, selectPanel } from "./helpers/designer";
import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const dock = (page: Page) =>
  page.getByRole("region", { name: "お気に入り部品", exact: true });
const svg = (page: Page) =>
  page.getByRole("img", { name: "プロセス画面", exact: true });
async function start(page: Page) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await button(page, "編集").click();
  await selectPanel(page, "部品");
}
async function saved(page: Page) {
  const downloading = page.waitForEvent("download");
  await fileCommand(page, "Project を保存");
  return JSON.parse(
    await readFile((await (await downloading).path())!, "utf8"),
  );
}
test("favorites keep palette drafts and Project/history unchanged, persist and remain usable without the sidebar", async ({
  page,
}) => {
  await start(page);
  await selectPanel(page, "レイヤー");
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "text · 5", exact: true })
    .click();
  await page.getByLabel("テキスト", { exact: true }).fill("保持する入力");
  await selectPanel(page, "部品");
  await page
    .getByRole("searchbox", { name: "部品を検索", exact: true })
    .fill("Rectangle");
  await button(page, "Rectangle をお気に入りに追加").focus();
  await button(page, "Rectangle をお気に入りに追加").press("Enter");
  await expect(
    dock(page).getByRole("button", {
      name: "お気に入り：四角形を配置",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByLabel("テキスト", { exact: true })).toHaveValue(
    "保持する入力",
  );
  await expect(button(page, "元に戻す")).toBeDisabled();
  await dock(page)
    .getByRole("button", { name: "お気に入り：四角形を配置", exact: true })
    .click();
  const prompt = page.getByRole("dialog", { name: "未適用の入力があります" });
  await prompt.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(svg(page).locator("[data-object-id]")).toHaveCount(3);
  await dock(page)
    .getByRole("button", { name: "お気に入り：四角形を配置", exact: true })
    .click();
  await prompt
    .getByRole("button", { name: "入力を破棄して続行", exact: true })
    .click();
  await expect(svg(page).locator("[data-object-id]")).toHaveCount(4);
  const area = (await page
    .getByRole("region", { name: "キャンバス操作領域", exact: true })
    .boundingBox())!;
  const center = await svg(page).evaluate(
    (el, point) => {
      const value = new DOMPoint(point.x, point.y).matrixTransform(
        (el as SVGSVGElement).getScreenCTM()!.inverse(),
      );
      return {
        x: value.x,
        y: value.y,
        scale: (el as SVGSVGElement).getScreenCTM()!.a,
      };
    },
    { x: area.x + area.width / 2, y: area.y + area.height / 2 },
  );
  for (const [field, size] of [
    ["x", "width"],
    ["y", "height"],
  ] as const) {
    const actual =
      Number(await page.getByLabel(field, { exact: true }).inputValue()) +
      Number(await page.getByLabel(size, { exact: true }).inputValue()) / 2;
    expect(Math.abs(actual - center[field])).toBeLessThan(1 / center.scale);
  }
  await button(page, "元に戻す").click();
  await expect(svg(page).locator("[data-object-id]")).toHaveCount(3);
  const project = await saved(page);
  expect(JSON.stringify(project)).not.toContain("favorite");
  await page.reload();
  await button(page, "編集").click();
  await expect(
    dock(page).getByRole("button", {
      name: "お気に入り：四角形を配置",
      exact: true,
    }),
  ).toBeVisible();
  await button(page, "左パネルを隠す").click();
  await dock(page)
    .getByRole("button", { name: "部品パネルを開く", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "部品", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
});
test("shared favorites are scoped to the live Project, follow names across imports, and prevent nesting", async ({
  page,
}) => {
  await start(page);
  await button(page, "ポンプを追加").click();
  await button(page, "共有定義：ポンプ をお気に入りに追加").focus();
  await button(page, "共有定義：ポンプ をお気に入りに追加").press("Enter");
  await expect(
    dock(page).getByRole("button", {
      name: "お気に入り：ポンプ（共有定義）を配置",
      exact: true,
    }),
  ).toHaveCount(1);
  await selectPanel(page, "プロジェクト");
  await button(page, "定義を編集").click();
  await expect(
    dock(page).getByRole("button", { name: /お気に入り：ポンプ/ }),
  ).toHaveCount(0);
  await expect(
    dock(page).getByRole("button", {
      name: "お気に入り：テキストを配置",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByLabel("Symbol 名", { exact: true }).fill("共用ポンプ");
  await button(page, "Symbol 設定を適用").click();
  await button(page, "画面へ戻る").click();
  await expect(
    dock(page).getByRole("button", {
      name: "お気に入り：共用ポンプ（共有定義）を配置",
      exact: true,
    }),
  ).toBeVisible();
  const project = await saved(page);
  const other = structuredClone(project);
  other.manifest.projectId = "019b0000-0000-7000-8000-000000000099";
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "other.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(other)),
  });
  await expect(
    dock(page).getByRole("button", {
      name: "お気に入り：共用ポンプ（共有定義）を配置",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "original.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(
    dock(page).getByRole("button", {
      name: "お気に入り：共用ポンプ（共有定義）を配置",
      exact: true,
    }),
  ).toBeVisible();
});
test("dock supports drag/drop, removal, preview and both themes in narrow layouts", async ({
  page,
}) => {
  await start(page);
  const canvas = page.getByRole("region", {
    name: "キャンバス操作領域",
    exact: true,
  });
  await dock(page)
    .getByRole("button", { name: "お気に入り：テキストを配置", exact: true })
    .dragTo(canvas, { targetPosition: { x: 200, y: 180 } });
  await expect(svg(page).locator("[data-object-id]")).toHaveCount(4);
  await button(page, "元に戻す").click();
  await dock(page)
    .getByRole("button", { name: "お気に入り：テキストを配置", exact: true })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "お気に入りから外す", exact: true })
    .click();
  await expect(
    dock(page).getByRole("button", {
      name: "お気に入り：テキストを配置",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    dock(page).getByRole("button", {
      name: "お気に入り：ポンプを配置",
      exact: true,
    }),
  ).toBeFocused();
  for (const theme of ["light", "dark"]) {
    await chooseTheme(page, theme);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await expect(dock(page)).toBeVisible();
    }
  }
  await button(page, "表示プレビュー").click();
  await expect(dock(page)).toHaveCount(0);
});

test("unavailable favorite storage preserves session editing and an empty dock remains recoverable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const save = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "banto.ui.scada.designer.favorites")
        throw new Error("blocked");
      return save.call(this, key, value);
    };
  });
  await start(page);
  for (const label of ["ポンプ", "バルブ", "テキスト"]) {
    await dock(page)
      .getByRole("button", { name: `お気に入り：${label}を配置`, exact: true })
      .click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "お気に入りから外す", exact: true })
      .click();
  }
  await expect(
    dock(page).getByText("部品の☆から登録", { exact: true }),
  ).toBeVisible();
  await expect(
    dock(page).getByRole("button", { name: "部品パネルを開く", exact: true }),
  ).toBeFocused();
  await expect(button(page, "元に戻す")).toBeDisabled();
  await expect(
    page
      .getByText("お気に入りを保存できません。このタブだけに適用します。", {
        exact: true,
      })
      .first(),
  ).toBeVisible();
  await button(page, "Rectangle をお気に入りに追加").focus();
  await button(page, "Rectangle をお気に入りに追加").press("Enter");
  await dock(page)
    .getByRole("button", { name: "お気に入り：四角形を配置", exact: true })
    .click();
  await expect(svg(page).locator("[data-object-id]")).toHaveCount(4);
  await page
    .getByRole("menubar")
    .getByRole("menuitem", { name: "表示", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "お気に入りを標準に戻す", exact: true })
    .click();
  await expect(
    dock(page).getByRole("button", {
      name: "お気に入り：四角形を配置",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    dock(page).getByRole("button", {
      name: "お気に入り：テキストを配置",
      exact: true,
    }),
  ).toBeVisible();
  await expect(svg(page).locator("[data-object-id]")).toHaveCount(4);
});
