import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sample from "../examples/process-light.project.json" with { type: "json" };
import { selectPanel, chooseTheme } from "./helpers/designer";
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const row = (page: Page, id: string) =>
  page.locator(`button[data-layer-id="${id}"]`);
const group = (page: Page, id: string) =>
  page.locator(
    `.sheet > svg [data-object-id="${id}"] > [data-object-rotation]`,
  );
async function start(page: Page, project: any = structuredClone(sample)) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await button(page, "編集").click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "opacity.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await selectPanel(page, "レイヤー");
  return project;
}
async function saved(page: Page) {
  const wait = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  return JSON.parse(await readFile((await (await wait).path())!, "utf8"));
}
for (const theme of ["light", "dark"])
  test(`placement opacity commits on Enter/blur, supports zero and keeps editor controls opaque in ${theme}`, async ({
    page,
  }) => {
    const project = await start(page),
      object = project.screens[0].objects.find(
        (o: any) => o.shape.type === "rectangle",
      );
    await chooseTheme(page, theme);
    await row(page, object.id).click();
    const input = page.getByLabel("不透明度（%）", { exact: true }),
      paint = group(page, object.id);
    await expect(input).toHaveValue("100");
    await input.fill("40");
    await input.press("Enter");
    await expect(paint).toHaveAttribute("opacity", "0.4");
    expect(
      (await saved(page)).screens[0].objects.find(
        (o: any) => o.id === object.id,
      ),
    ).toEqual({ ...object, opacity: 0.4 });
    await input.fill("0");
    await input.press("Tab");
    await expect(paint).toHaveAttribute("opacity", "0");
    // Paint becomes transparent; the hit area and selection remain in a separate opaque group.
    const outer = page.locator(`.sheet > svg [data-object-id="${object.id}"]`);
    await expect(outer).toHaveAttribute("data-selected", "true");
    expect(await outer.getAttribute("opacity")).toBeNull();
    await expect(
      outer.locator(':scope > rect[fill="transparent"]'),
    ).toBeVisible();
    await button(page, "元に戻す").click();
    await expect(input).toHaveValue("40");
    await button(page, "やり直す").click();
    await expect(input).toHaveValue("0");
    await button(page, "表示プレビュー").click();
    await expect(group(page, object.id)).toHaveAttribute("opacity", "0");
    expect(
      await page.locator('.sheet > svg [data-selected="true"]').count(),
    ).toBe(0);
  });
test("invalid opacity and Escape preserve data and staged inputs; omitted defaults add no history", async ({
  page,
}) => {
  const project = await start(page),
    object = project.screens[0].objects[0];
  await row(page, object.id).click();
  const input = page.getByLabel("不透明度（%）", { exact: true });
  await input.fill("100");
  await input.press("Enter");
  await expect(button(page, "元に戻す")).toBeDisabled();
  await page.getByLabel("配置名", { exact: true }).fill("保留中の名称");
  await input.fill("101");
  await input.press("Enter");
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await input.press("Escape");
  await expect(input).toHaveValue("100");
  await expect(page.getByLabel("配置名", { exact: true })).toHaveValue(
    "保留中の名称",
  );
  await input.fill("29");
  await input.press("Enter");
  await expect(group(page, object.id)).toHaveAttribute("opacity", "0.29");
  await expect(page.getByLabel("配置名", { exact: true })).toHaveValue(
    "保留中の名称",
  );
  await button(page, "変更を適用").click();
  expect((await saved(page)).screens[0].objects[0]).toEqual({
    ...object,
    opacity: 0.29,
    name: "保留中の名称",
  });
});
test("Symbol placement opacity composites once in both color modes and preserves child opacity and minimap", async ({
  page,
}) => {
  const project: any = structuredClone(sample),
    object = project.screens[0].objects.find(
      (o: any) => o.shape.type === "symbol",
    ),
    definition = project.symbols.find(
      (s: any) => s.id === object.shape.symbolId,
    );
  object.opacity = 0.5;
  definition.objects[0].opacity = 0.3;
  await start(page, project);
  await row(page, object.id).click();
  const paint = group(page, object.id);
  await expect(paint).toHaveAttribute("opacity", "0.5");
  await expect(paint.locator("svg > g").first()).toHaveAttribute(
    "opacity",
    "0.3",
  );
  expect(await paint.locator("svg").getAttribute("opacity")).toBeNull();
  await page
    .getByLabel("色の使い方", { exact: true })
    .selectOption("definition");
  await button(page, "色の使い方を適用").click();
  await expect(paint).toHaveAttribute("opacity", "0.5");
  await expect(paint.locator("svg > g").first()).toHaveAttribute(
    "opacity",
    "0.3",
  );
  await expect(
    page.locator(
      `.minimap [data-object-id="${object.id}"] > [data-object-rotation]`,
    ),
  ).toHaveAttribute("opacity", "0.5");
});
