import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/embedded-screen.project.json" with { type: "json" };
import { chooseTheme } from "./helpers/designer";
const button = (p: Page, name: string) =>
  p.getByRole("button", { name, exact: true });
async function start(p: Page) {
  await p.setViewportSize({ width: 1920, height: 1080 });
  await p.goto("/");
  await button(p, "編集").click();
  await p.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "fullscreen.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(sample)),
  });
  await button(p, "表示プレビュー").click();
}
const active = (p: Page) =>
  p.evaluate(() => document.fullscreenElement === document.documentElement);
async function popup(p: Page) {
  await button(p, "画面を小窓で表示確認").click();
  const dialog = p.getByRole("dialog", {
    name: "画面を小窓で表示確認",
    exact: true,
  });
  await dialog.locator(`input[value="${sample.screens[1].id}"]`).check();
  await button(p, "小窓を表示").click();
  await expect(p.locator("[data-preview-popup]")).toHaveCount(1);
}
for (const theme of ["light", "dark"])
  test(`native full screen keeps popups and Modal inside the display and restores layout in ${theme}`, async ({
    page: p,
  }) => {
    await start(p);
    await chooseTheme(p, theme);
    await popup(p);
    await button(p, "全画面で表示確認").click();
    await expect.poll(() => active(p)).toBe(true);
    await expect(p.locator(".app-header")).not.toBeVisible();
    await expect(p.locator(".project-sidebar")).not.toBeVisible();
    await expect(p.locator("[data-preview-popup]")).toHaveCount(1);
    await button(p, "画面を小窓で表示確認").click();
    const chooser = p.getByRole("dialog", {
      name: "画面を小窓で表示確認",
      exact: true,
    });
    await expect(chooser).toBeVisible();
    await p.keyboard.press("Escape");
    await expect(chooser).not.toBeVisible();
    // Escape can be consumed by the browser's native fullscreen UI before reaching page layers.
    if (await active(p)) await button(p, "全画面を終了").click();
    await expect.poll(() => active(p)).toBe(false);
    await expect(p.locator(".app-header")).toBeVisible();
    await expect(p.locator(".project-sidebar")).toBeVisible();
    await expect(p.locator("[data-preview-popup]")).toHaveCount(1);
    const download = p.waitForEvent("download");
    await p.keyboard.press("Control+s");
    expect(
      JSON.parse(await readFile((await (await download).path())!, "utf8")),
    ).toEqual(sample);
  });
test("native fullscreen exit event restores the editor shell; edit and Project replacement end owned fullscreen", async ({
  page: p,
}) => {
  await start(p);
  await button(p, "全画面で表示確認").click();
  await expect.poll(() => active(p)).toBe(true);
  await p.evaluate(() => document.exitFullscreen());
  await expect(button(p, "全画面で表示確認")).toBeEnabled();
  await expect(p.locator(".app-header")).toBeVisible();
  await button(p, "全画面で表示確認").click();
  await expect.poll(() => active(p)).toBe(true);
  await button(p, "編集").click();
  await expect.poll(() => active(p)).toBe(false);
  await expect(p.locator(".app-header")).toBeVisible();
  await expect(button(p, "全画面で表示確認")).toHaveCount(0);
  await button(p, "表示プレビュー").click();
  await button(p, "全画面で表示確認").click();
  await expect.poll(() => active(p)).toBe(true);
  await p.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "new-generation.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(sample)),
  });
  await expect.poll(() => active(p)).toBe(false);
  await expect(p.locator(".app-header")).toBeVisible();
});
test("denied request leaves normal layout and preview popup intact and reports a retryable error", async ({
  page: p,
}) => {
  await p.addInitScript(() => {
    Element.prototype.requestFullscreen = async () => {
      throw new DOMException("test denial", "NotAllowedError");
    };
  });
  await start(p);
  await popup(p);
  await button(p, "全画面で表示確認").click();
  await expect(p.getByTestId("project-status")).toContainText(
    "全画面に切り替えられません",
  );
  await expect(button(p, "全画面で表示確認")).toBeEnabled();
  await expect.poll(() => active(p)).toBe(false);
  await expect(p.locator(".app-header")).toBeVisible();
  await expect(p.locator("[data-preview-popup]")).toHaveCount(1);
});
test("unavailable browser API disables fullscreen confirmation with a reason", async ({
  page: p,
}) => {
  await p.addInitScript(() =>
    Object.defineProperty(document, "fullscreenEnabled", {
      get: () => false,
      configurable: true,
    }),
  );
  await start(p);
  await expect(button(p, "全画面で表示確認")).toBeDisabled();
  await expect(button(p, "全画面で表示確認")).toHaveAttribute(
    "title",
    "このブラウザでは全画面表示を利用できません。",
  );
});
