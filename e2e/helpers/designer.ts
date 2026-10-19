import type { Page } from "@playwright/test";

/** Follow the same tab entry points as the editor user. */
export async function selectPanel(
  page: Page,
  name: "プロジェクト" | "レイヤー" | "部品",
) {
  const tab = page.getByRole("tab", { name, exact: true });
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
}

/** Use the compact theme icon menu, retaining the explicit OS-following option. */
export async function chooseTheme(page: Page, value: string) {
  const labels: Record<string, string> = {
    light: "ライト",
    dark: "ダーク",
    system: "OS に合わせる",
  };
  const label = labels[value];
  if (!label) throw new Error(`Unknown theme: ${value}`);
  await page.getByRole("button", { name: "テーマを変更", exact: true }).click();
  await page
    .getByRole("menu", { name: "テーマ", exact: true })
    .getByRole("menuitem", { name: label, exact: true })
    .click();
}

/** File operations remain available with the menubar or sidebar hidden. */
export async function fileCommand(page: Page, name: string) {
  const bar = page.getByRole("menubar", {
    name: "Designer メニューバー",
    exact: true,
  });
  if (await bar.isVisible()) {
    await bar.getByRole("menuitem", { name: "ファイル", exact: true }).click();
    await page
      .getByRole("menu", { name: "ファイル", exact: true })
      .getByRole("menuitem", { name, exact: true })
      .click();
  } else {
    await page.getByRole("button", { name: "メニュー", exact: true }).click();
    await page
      .getByRole("menu", { name: "常設メニュー", exact: true })
      .getByRole("menuitem", { name, exact: true })
      .click();
  }
}

/** Main canvas root; minimap and Popup projections have separate roots. */
export const mainCanvas = (page: Page) => page.locator(".sheet > svg");

/** Mode changes resize the viewport before the app's ResizeObserver publishes fit. */
export async function settleCanvasLayout(page: Page) {
  await page
    .getByRole("region", { name: "キャンバス操作領域", exact: true })
    .evaluate(
      (element) =>
        new Promise<void>((resolve) => {
          const observer = new ResizeObserver(() => {
            observer.disconnect();
            // Finish resize callbacks, Svelte updates and the following render frames.
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          });
          observer.observe(element);
        }),
    );
}
