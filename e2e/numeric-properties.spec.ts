import { test, expect, type Page } from "@playwright/test";
import { selectPanel } from "./helpers/designer";
import { readFile } from "node:fs/promises";
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const field = (page: Page, name: string) =>
  page.getByLabel(name, { exact: true });
const shape = (page: Page) =>
  page
    .getByRole("img", { name: "プロセス画面", exact: true })
    .locator("[data-object-id]")
    .first();
async function start(page: Page, object = "rectangle · 3") {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await button(page, "編集").click();
  await selectPanel(page, "レイヤー");
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: object, exact: true })
    .click();
}
async function saved(page: Page) {
  const download = page.waitForEvent("download");
  await button(page, "Project JSON を保存").click();
  return JSON.parse(await readFile((await (await download).path())!, "utf8"));
}
test("Enter and blur commit only one numeric field once, keep focus and support undo/redo", async ({
  page,
}) => {
  await start(page);
  await field(page, "x").fill("125.5");
  await field(page, "x").press("Enter");
  await expect(shape(page)).toHaveAttribute(
    "transform",
    "translate(125.5 170)",
  );
  await expect(field(page, "x")).toBeFocused();
  await field(page, "y").click();
  await expect(page.getByTestId("save-state")).not.toContainText(
    "未適用の入力あり",
  );
  await button(page, "元に戻す").click();
  await expect(field(page, "x")).toHaveValue("100");
  await expect(button(page, "元に戻す")).toBeDisabled();
  await button(page, "やり直す").click();
  await expect(field(page, "x")).toHaveValue("125.5");
  await field(page, "y").fill("210");
  await field(page, "width").click();
  await expect(shape(page)).toHaveAttribute(
    "transform",
    "translate(125.5 210)",
  );
  const json = await saved(page);
  expect(json.screens[0].objects[0]).toMatchObject({ x: 125.5, y: 210 });
  expect(json.manifest.projectRevision).toBe(5); // commit, undo, redo, commit
});
test("committing numbers keeps staged tag and text, and discarding them keeps committed geometry", async ({
  page,
}) => {
  await start(page, "text · 5");
  await field(page, "表示タグ（外部名）").fill("PLC01.Fast.Pending.Value");
  await field(page, "テキスト").fill("未適用の文字");
  await field(page, "x").fill("240");
  await field(page, "x").press("Enter");
  await expect(field(page, "表示タグ（外部名）")).toHaveValue(
    "PLC01.Fast.Pending.Value",
  );
  await expect(field(page, "テキスト")).toHaveValue("未適用の文字");
  await expect(page.getByTestId("save-state")).toContainText(
    "未適用の入力あり",
  );
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "rectangle · 3", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "未適用の入力があります" });
  await dialog
    .getByRole("button", { name: "入力を破棄して続行", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "text · 5", exact: true })
    .click();
  await expect(field(page, "x")).toHaveValue("240");
  await expect(field(page, "表示タグ（外部名）")).toHaveValue("");
  await expect(field(page, "テキスト")).not.toHaveValue("未適用の文字");
});
test("invalid strings survive other field commits; Esc cancels without history or a duplicate blur commit", async ({
  page,
}) => {
  await start(page);
  await field(page, "x").fill("1e");
  await field(page, "y").fill("230");
  await field(page, "y").press("Enter");
  await expect(field(page, "x")).toHaveValue("1e");
  await expect(field(page, "x")).toHaveAttribute("aria-invalid", "true");
  await expect(shape(page)).toHaveAttribute("transform", "translate(100 230)");
  await field(page, "x").focus();
  await field(page, "x").press("Escape");
  await field(page, "width").click();
  await expect(field(page, "x")).toHaveValue("100");
  await expect(field(page, "x")).not.toHaveAttribute("aria-invalid", "true");
  await button(page, "元に戻す").click();
  await expect(field(page, "y")).toHaveValue("170");
  await expect(button(page, "元に戻す")).toBeDisabled();
});
test("model-invalid values remain staged and block leaving until fixed or discarded", async ({
  page,
}) => {
  await start(page);
  await field(page, "width").fill("0");
  await field(page, "width").press("Enter");
  await expect(field(page, "width")).toHaveAttribute("aria-invalid", "true");
  await expect(button(page, "元に戻す")).toBeDisabled();
  await button(page, "表示プレビュー").click();
  const prompt = page.getByRole("dialog", { name: "未適用の入力があります" });
  await prompt
    .getByRole("button", { name: "適用して続行", exact: true })
    .click();
  await expect(field(page, "width")).toHaveValue("0");
  await expect(button(page, "編集")).toHaveAttribute("aria-pressed", "true");
  await field(page, "width").fill("80");
  await field(page, "width").press("Enter");
  await expect(page.getByTestId("save-state")).not.toContainText(
    "未適用の入力あり",
  );
  await button(page, "表示プレビュー").click();
  await expect(
    page.getByRole("complementary", { name: "プロパティパネル" }),
  ).toHaveCount(0);
});
test("blur applies to the original target before selecting another object; same-ID project imports start clean", async ({
  page,
}) => {
  await start(page);
  await field(page, "x").fill("320");
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "ellipse · 4", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(shape(page)).toHaveAttribute("transform", "translate(320 170)");
  await expect(field(page, "x")).not.toHaveValue("320");
  const json = await saved(page);
  json.screens[0].objects[0].x = 111;
  page.on("dialog", (dialog) => dialog.accept());
  await field(page, "Project JSON を開く").setInputFiles({
    name: "next.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(json)),
  });
  await page
    .getByRole("navigation", { name: "図形一覧" })
    .getByRole("button", { name: "rectangle · 3", exact: true })
    .click();
  await expect(field(page, "x")).toHaveValue("111");
  await expect(page.getByTestId("save-state")).not.toContainText(
    "未適用の入力あり",
  );
});
test("IME Enter does not submit unrelated fields and a deferred blur is resolved after composition", async ({
  page,
}) => {
  await start(page, "text · 5");
  await field(page, "表示タグ（外部名）").fill("PLC01.Fast.Pending.Value");
  const x = field(page, "x");
  await x.focus();
  await x.dispatchEvent("compositionstart");
  await x.fill("350");
  await x.press("Enter");
  await expect(button(page, "元に戻す")).toBeDisabled();
  await x.dispatchEvent("blur");
  await expect(button(page, "元に戻す")).toBeDisabled();
  await x.dispatchEvent("compositionend");
  await expect(button(page, "元に戻す")).toBeEnabled();
  await expect(field(page, "表示タグ（外部名）")).toHaveValue(
    "PLC01.Fast.Pending.Value",
  );
  await expect(page.getByTestId("save-state")).toContainText(
    "未適用の入力あり",
  );
});
test("Ctrl+S commits the focused number and equivalent values do not add history", async ({
  page,
}) => {
  await start(page);
  await field(page, "x").fill("100.0");
  await field(page, "x").press("Enter");
  await expect(button(page, "元に戻す")).toBeDisabled();
  await field(page, "x").fill("234");
  const download = page.waitForEvent("download");
  await field(page, "x").press("Control+s");
  const json = JSON.parse(
    await readFile((await (await download).path())!, "utf8"),
  );
  expect(json.screens[0].objects[0].x).toBe(234);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("canvas drag commits the focused X before reading geometry, with separate undo steps", async ({
  page,
}) => {
  await start(page);
  const svg = page.getByRole("img", { name: "プロセス画面", exact: true });
  const scale = (await svg.boundingBox())!.width / 960;
  const box = (await shape(page).boundingBox())!;
  await field(page, "x").fill("200");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + 40 * scale,
    box.y + box.height / 2,
    { steps: 5 },
  );
  await page.mouse.up();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(field(page, "x")).toHaveValue("240");
  await button(page, "元に戻す").click();
  await expect(field(page, "x")).toHaveValue("200");
  await button(page, "元に戻す").click();
  await expect(field(page, "x")).toHaveValue("100");
  await expect(button(page, "元に戻す")).toBeDisabled();
});
test("resize uses the committed width instead of the pointerdown closure's old dimensions", async ({
  page,
}) => {
  await start(page);
  const svg = page.getByRole("img", { name: "プロセス画面", exact: true });
  const scale = (await svg.boundingBox())!.width / 960;
  const handle = page.locator('[data-resize-handle="se"]');
  await handle.scrollIntoViewIfNeeded();
  const box = (await handle.boundingBox())!;
  await field(page, "width").fill("300");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + 20 * scale,
    box.y + box.height / 2 + 20 * scale,
    { steps: 5 },
  );
  await page.mouse.up();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(field(page, "width")).toHaveValue("320");
  await button(page, "元に戻す").click();
  await expect(field(page, "width")).toHaveValue("300");
  await button(page, "元に戻す").click();
  await expect(field(page, "width")).toHaveValue("260");
});
test("canvas editing still guards a staged tag and invalid numbers, and blocks composition", async ({
  page,
}) => {
  await start(page, "text · 5");
  await field(page, "表示タグ（外部名）").fill("PLC01.Fast.Pending.Value");
  await field(page, "x").fill("220");
  await shape(page).click({ position: { x: 20, y: 20 } });
  const prompt = page.getByRole("dialog", { name: "未適用の入力があります" });
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(field(page, "表示タグ（外部名）")).toHaveValue(
    "PLC01.Fast.Pending.Value",
  );
  await expect(field(page, "x")).toHaveValue("220");
  await field(page, "表示タグ（外部名）").fill("");
  await field(page, "x").fill("bad");
  await shape(page).click({ position: { x: 20, y: 20 } });
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(field(page, "x")).toHaveValue("bad");
  await field(page, "x").press("Escape");
  await field(page, "x").dispatchEvent("compositionstart");
  await field(page, "x").fill("330");
  await shape(page).click({ position: { x: 20, y: 20 } });
  await expect(prompt).toHaveCount(0);
  await expect(field(page, "x")).toHaveValue("330");
  await field(page, "x").dispatchEvent("compositionend");
  await field(page, "x").press("Enter");
  await expect(field(page, "x")).toHaveValue("330");
});
