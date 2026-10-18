import type { Page } from "@playwright/test";

/** Follow the same tab entry points as the editor user. */
export async function selectPanel(
  page: Page,
  name: "プロジェクト" | "レイヤー" | "部品",
) {
  const tab = page.getByRole("tab", { name, exact: true });
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
}
