import { expect, test } from "@playwright/test";

test("native Hub controls stay in the header and reveal connection details", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {
        invoke: async (command: string) => {
          if (command === "hub_saved_endpoint") return "http://127.0.0.1:8722";
          if (command === "hub_connect")
            return { state: "offline", cause: "test" };
          if (command === "hub_disconnect") return null;
          throw new Error(`Unexpected command: ${command}`);
        },
      },
    });
  });

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  const summary = page.locator(".app-header .hub-connection summary");
  await expect(summary).toContainText("Hub");
  await expect(summary).toContainText("要確認");
  await expect(page.locator("#hub-endpoint")).toBeHidden();
  await expect(page.locator("main")).toBeVisible();
  const hubBounds = await summary.boundingBox();
  const menuBounds = await page.getByRole("menubar").boundingBox();
  expect(
    hubBounds && menuBounds && hubBounds.x + hubBounds.width < menuBounds.x,
  ).toBe(true);

  await summary.click();
  await expect(page.getByLabel("Hub 接続先")).toHaveValue(
    "http://127.0.0.1:8722",
  );
  await expect(
    page.getByRole("status").filter({ hasText: "Hub接続: offline / test" }),
  ).toBeVisible();
  await page.locator(".studio-brand").click();
  await expect(page.locator("#hub-endpoint")).toBeHidden();
  await summary.click();
  await page.getByLabel("Hub 接続先").press("Escape");
  await expect(page.locator("#hub-endpoint")).toBeHidden();
  await summary.click();
  await page.getByRole("button", { name: "切断", exact: true }).click();
  await expect(summary).toContainText("未接続");
  await expect(
    page.getByRole("status").filter({ hasText: "切断しました" }),
  ).toBeVisible();
});
