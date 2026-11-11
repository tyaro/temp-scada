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

/** Menubar group, or the header ☰ (shown only while the menubar is hidden). */
export async function chooseMenuItem(
  page: Page,
  group: "ファイル" | "表示" | "記録" | "ヘルプ",
  name: string,
) {
  const bar = page.getByRole("menubar", {
    name: "Designer メニューバー",
    exact: true,
  });
  const permanent = page.getByRole("button", { name: "メニュー", exact: true });
  // Either the menubar or, when it is hidden, the header ☰ is the entry point.
  await bar.or(permanent).waitFor();
  if (await bar.isVisible()) {
    await bar.getByRole("menuitem", { name: group, exact: true }).click();
    await page
      .getByRole("menu", { name: group, exact: true })
      .getByRole("menuitem", { name, exact: true })
      .click();
  } else {
    await permanent.click();
    await page
      .getByRole("menu", { name: "常設メニュー", exact: true })
      .getByRole("menuitem", { name, exact: true })
      .click();
  }
}

/** File operations remain available with the menubar or sidebar hidden. */
export async function fileCommand(page: Page, name: string) {
  await chooseMenuItem(page, "ファイル", name);
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
