import { test, expect, type Page } from "@playwright/test";
import { selectPanel, chooseTheme } from "./helpers/designer";

const inspector = (page: Page) =>
  page.getByRole("complementary", { name: "プロパティパネル", exact: true });
const viewport = (page: Page) =>
  page.getByRole("region", { name: "キャンバス操作領域", exact: true });
async function showInspector(page: Page) {
  await page.getByRole("button", { name: "メニュー", exact: true }).click();
  await page
    .getByRole("menu", { name: "常設メニュー", exact: true })
    .getByRole("menuitem", { name: "プロパティを表示", exact: true })
    .click();
}
async function center(page: Page) {
  return viewport(page).evaluate((el) => {
    const svg = el.querySelector("svg")!;
    const box = el.getBoundingClientRect();
    const point = new DOMPoint(
      box.left + el.clientLeft + el.clientWidth / 2,
      box.top + el.clientTop + el.clientHeight / 2,
    ).matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: point.x, y: point.y };
  });
}

test("hiding properties releases its width, retains drafts and restores through the permanent menu", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await selectPanel(page, "部品");
  await page
    .getByRole("button", { name: "Rectangle を追加", exact: true })
    .click();
  await page.getByLabel(/^(?:色|塗りの色)$/, { exact: true }).fill("#aabbcc");
  const revision = await page.locator(".toolbar").innerText();
  const width = (await viewport(page).boundingBox())!.width;
  await inspector(page)
    .getByRole("button", { name: "プロパティを隠す", exact: true })
    .click();
  await expect(inspector(page)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "メニュー", exact: true }),
  ).toBeFocused();
  await expect
    .poll(async () => (await viewport(page).boundingBox())!.width)
    .toBeGreaterThan(width + 250);
  await expect(
    page.locator('[data-editor-form="shape-paint"] input[name="fillColor"]'),
  ).toHaveValue("#aabbcc");
  await expect(page.getByTestId("save-state")).toContainText("1 フォーム");
  expect(await page.locator(".toolbar").innerText()).toBe(revision);
  await page
    .getByRole("menubar")
    .getByRole("menuitem", { name: "表示", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "メニューバーを隠す", exact: true })
    .click();
  await showInspector(page);
  await expect(inspector(page)).toBeVisible();
  await expect(
    page.getByLabel(/^(?:色|塗りの色)$/, { exact: true }),
  ).toHaveValue("#aabbcc");
  await page
    .getByRole("button", { name: "塗りと枠線を適用", exact: true })
    .click();
  await expect(page.getByTestId("save-state")).not.toContainText(
    "未適用の入力あり",
  );
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect(
    page.getByLabel(/^(?:色|塗りの色)$/, { exact: true }),
  ).not.toHaveValue("#aabbcc");
});

for (const zoom of [0.25, 1, 4]) {
  test(`property visibility preserves the design center and ${zoom * 100}% zoom`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.getByRole("button", { name: "編集", exact: true }).click();
    await page
      .getByLabel("表示倍率", { exact: true })
      .selectOption(String(zoom));
    await viewport(page).evaluate((el) => {
      el.scrollLeft = 100;
      el.scrollTop = 70;
    });
    const before = await center(page);
    const width = (await viewport(page).boundingBox())!.width;
    await inspector(page)
      .getByRole("button", { name: "プロパティを隠す", exact: true })
      .click();
    await expect
      .poll(async () => (await viewport(page).boundingBox())!.width)
      .toBeGreaterThan(width + 250);
    await expect
      .poll(async () => Math.abs((await center(page)).x - before.x))
      .toBeLessThan(1.1 / zoom);
    await expect
      .poll(async () => Math.abs((await center(page)).y - before.y))
      .toBeLessThan(1.1 / zoom);
    await expect(page.getByLabel("表示倍率", { exact: true })).toHaveValue(
      String(zoom),
    );
    await showInspector(page);
    await expect
      .poll(async () =>
        Math.abs((await viewport(page).boundingBox())!.width - width),
      )
      .toBeLessThan(1);
    await expect
      .poll(async () => Math.abs((await center(page)).x - before.x))
      .toBeLessThan(1.1 / zoom);
    await expect
      .poll(async () => Math.abs((await center(page)).y - before.y))
      .toBeLessThan(1.1 / zoom);
    await expect(
      page.getByRole("button", { name: "元に戻す", exact: true }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "全体表示", exact: true }).click();
    await expect(page.getByLabel("表示倍率", { exact: true })).toHaveValue(
      "fit",
    );
  });
}

test("hidden invalid properties reopen for native and model validation", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await selectPanel(page, "部品");
  await page
    .getByRole("button", { name: "Rectangle を追加", exact: true })
    .click();
  const width = page.getByLabel("width", { exact: true });
  const original = await width.inputValue();
  await width.fill("0");
  await inspector(page)
    .getByRole("button", { name: "プロパティを隠す", exact: true })
    .click();
  await page.keyboard.press("Control+s");
  const prompt = page.getByRole("dialog", { name: "未適用の入力があります" });
  await prompt
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(inspector(page)).toBeVisible();
  await expect(width).toHaveValue("0");
  await expect(width).toBeFocused();
  await width.fill(original);
  await page.getByRole("button", { name: "配管を追加", exact: true }).click();
  await page.getByLabel("頂点", { exact: true }).fill("0,0\n0,0");
  await inspector(page)
    .getByRole("button", { name: "プロパティを隠す", exact: true })
    .click();
  await page.keyboard.press("Control+s");
  await prompt
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(inspector(page)).toBeVisible();
  await expect(page.getByLabel("頂点", { exact: true })).toHaveValue(
    "0,0\n0,0",
  );
  await expect(page.getByTestId("project-status")).toContainText(
    "線には異なる2点が必要",
  );
});

for (const theme of ["light", "dark"]) {
  test(`properties show and hide in ${theme} at supported desktop sizes`, async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "編集", exact: true }).click();
    await chooseTheme(page, theme);
    for (const [width, height] of [
      [1280, 720],
      [1440, 900],
    ]) {
      await page.setViewportSize({ width, height });
      await expect(
        inspector(page).getByRole("button", {
          name: "プロパティを隠す",
          exact: true,
        }),
      ).toBeInViewport();
      await inspector(page)
        .getByRole("button", { name: "プロパティを隠す", exact: true })
        .click();
      await showInspector(page);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
  });
}
