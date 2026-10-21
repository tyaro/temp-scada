import { test, expect, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import sample from "../examples/connection.project.json" with { type: "json" };
import { chooseTheme, mainCanvas, selectPanel } from "./helpers/designer";
import {
  openProject,
  downloadProject,
  downloadBytes,
} from "./helpers/project-files";
const [pump1, pump2, pipe] = sample.screens[0].objects.map((o) => o.id);
const button = (p: Page, name: string) =>
  p.getByRole("button", { name, exact: true });
const form = (p: Page, end: string) =>
  p.getByRole("form", { name: `${end}の接続`, exact: true });
async function select(p: Page, id: string) {
  await selectPanel(p, "レイヤー");
  await p.locator(`[data-layer-id="${id}"]`).click();
}
async function start(p: Page, data: object = sample) {
  await p.setViewportSize({ width: 1920, height: 1080 });
  await p.goto("/");
  await button(p, "編集").click();
  await openProject(p, {
    name: "connection.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(data)),
  });
  await select(p, pipe);
}
async function saved(p: Page) {
  return JSON.parse((await downloadBytes(await downloadProject(p))).toString());
}
for (const theme of ["light", "dark"])
  test(`connect and disconnect each endpoint through explicit properties, Undo and portable JSON in ${theme}`, async ({
    page: p,
    browser,
  }) => {
    const data = structuredClone(sample);
    delete (data.screens[0].objects[2].shape as any).connections;
    await start(p, data);
    await chooseTheme(p, theme);
    await expect(
      form(p, "始点").getByLabel("始点の接続先", { exact: true }),
    ).toHaveValue("");
    await form(p, "始点")
      .getByLabel("始点の接続先", { exact: true })
      .selectOption(pump1);
    await button(p, "始点の接続を適用").click();
    await expect(form(p, "始点")).toContainText("接続中：ポンプ1 · 配置1／右");
    await form(p, "終点")
      .getByLabel("終点の接続先", { exact: true })
      .selectOption(pump2);
    await button(p, "終点の接続を適用").click();
    await expect(form(p, "終点")).toContainText("接続中：ポンプ2 · 配置2／左");
    await button(p, "始点の接続を適用").click(); // unchanged: no extra Undo
    await button(p, "元に戻す").click();
    await expect(
      form(p, "終点").getByLabel("終点の接続先", { exact: true }),
    ).toHaveValue("");
    await expect(
      form(p, "始点").getByLabel("始点の接続先", { exact: true }),
    ).toHaveValue(pump1);
    await button(p, "やり直す").click();
    const project = await saved(p);
    expect(project.screens[0].objects[2].shape.connections).toEqual(
      sample.screens[0].objects[2].shape.connections,
    );
    if (process.env.SCADA_SCREENSHOT_DIR) {
      const close = p.locator(".toast-host button.close");
      while (await close.count()) await close.first().click();
      let screenshot: Buffer | undefined;
      const point = await mainCanvas(p).evaluate((svg) => {
        const p = new DOMPoint(220, 220).matrixTransform(
          (svg as SVGSVGElement).getScreenCTM()!,
        );
        return { x: p.x, y: p.y };
      });
      await expect
        .poll(async () => {
          screenshot = await p.screenshot({ animations: "disabled" });
          return p.evaluate(
            async ({ encoded, point }) => {
              const image = new Image();
              image.src = `data:image/png;base64,${encoded}`;
              await image.decode();
              const canvas = document.createElement("canvas");
              canvas.width = image.width;
              canvas.height = image.height;
              const context = canvas.getContext("2d")!;
              context.drawImage(image, 0, 0);
              const pixel = context.getImageData(
                Math.round(point.x),
                Math.round(point.y),
                1,
                1,
              ).data;
              return [35, 140, 176].every(
                (value, i) => Math.abs(pixel[i] - value) < 8,
              );
            },
            { encoded: screenshot.toString("base64"), point },
          );
        })
        .toBe(true);
      await writeFile(
        `${process.env.SCADA_SCREENSHOT_DIR}/connection-settings-${theme}.png`,
        screenshot!,
      );
    }
    const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
      }),
      other = await context.newPage();
    await start(other, project);
    await expect(
      form(other, "始点").getByLabel("始点の接続先", { exact: true }),
    ).toHaveValue(pump1);
    await expect(
      form(other, "終点").getByLabel("終点の接続先", { exact: true }),
    ).toHaveValue(pump2);
    await context.close();
    await form(p, "始点")
      .getByLabel("始点の接続先", { exact: true })
      .selectOption("");
    await button(p, "始点の接続を適用").click();
    await select(p, pump1);
    await p.getByLabel("x", { exact: true }).fill("140");
    await p.getByLabel("x", { exact: true }).press("Enter");
    const disconnected = await saved(p);
    expect(
      disconnected.screens[0].objects[2].shape.connections,
    ).not.toHaveProperty("start");
    expect(disconnected.screens[0].objects[2].shape.points).toEqual(
      data.screens[0].objects[2].shape.points,
    );
  });
test("connection draft survives cancelled navigation and composing Enter or submit cannot commit", async ({
  page: p,
}) => {
  await start(p);
  const target = form(p, "始点").getByLabel("始点の接続先", { exact: true }),
    anchor = form(p, "始点").getByLabel("始点の接続位置", { exact: true });
  await target.selectOption(pump2);
  await anchor.selectOption("top");
  await button(p, "表示プレビュー").click();
  await expect(
    p.getByRole("dialog", { name: "未適用の入力があります", exact: true }),
  ).toBeVisible();
  await button(p, "キャンセル").click();
  await expect(target).toHaveValue(pump2);
  await expect(anchor).toHaveValue("top");
  await expect(form(p, "始点")).toContainText("接続中：ポンプ1 · 配置1／右");
  await anchor.dispatchEvent("compositionstart");
  await anchor.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await button(p, "始点の接続を適用").click();
  await expect(button(p, "元に戻す")).toBeDisabled();
  await expect(form(p, "始点")).toContainText("接続中：ポンプ1 · 配置1／右");
  await anchor.dispatchEvent("compositionend");
  await button(p, "始点の接続を適用").click();
  await expect(form(p, "始点")).toContainText("接続中：ポンプ2 · 配置2／上");
  await button(p, "元に戻す").click();
  await expect(form(p, "始点")).toContainText("接続中：ポンプ1 · 配置1／右");
});
test("Symbol properties expose referring endpoints and locked pipes disable connection changes", async ({
  page: p,
}) => {
  const data = structuredClone(sample);
  (data.screens[0].objects[2] as any).locked = true;
  await start(p, data);
  await expect(
    form(p, "始点").getByLabel("始点の接続先", { exact: true }),
  ).toBeDisabled();
  await expect(button(p, "始点の接続を適用")).toBeDisabled();
  await select(p, pump1);
  await expect(
    p.getByRole("region", { name: "このSymbolに接続中の配管", exact: true }),
  ).toContainText("ポンプ間配管 · 始点（右）");
  await p.keyboard.press("Delete");
  await expect(p.getByTestId("project-status")).toContainText("ポンプ間配管");
  await expect(button(p, "元に戻す")).toBeDisabled();
});
test("a line without any Symbol candidates shows a clear reason and cannot apply a connection", async ({
  page: p,
}) => {
  const data = structuredClone(sample);
  delete (data.screens[0].objects[2].shape as any).connections;
  data.screens[0].objects = data.screens[0].objects.slice(2);
  await start(p, data);
  await expect(
    p.getByRole("region", { name: "配管の接続設定", exact: true }),
  ).toContainText("この画面に接続先のSymbolがありません。");
  await expect(button(p, "始点の接続を適用")).toBeDisabled();
  await expect(button(p, "終点の接続を適用")).toBeDisabled();
});

test("Apply-and-continue rejects all dirty forms before mutation while a connection is composing", async ({
  page: p,
}) => {
  await start(p);
  // Dirty the ordinary object form first: it must not commit before the IME guard.
  const name = p.getByLabel("配置名", { exact: true });
  await name.fill("未適用の配管名");
  const target = form(p, "始点").getByLabel("始点の接続先", { exact: true });
  await target.selectOption(pump2);
  await target.dispatchEvent("compositionstart");
  await button(p, "表示プレビュー").click();
  await button(p, "適用して続行").click();
  await expect(p.getByTestId("project-status")).toContainText("文字変換");
  await expect(button(p, "元に戻す")).toBeDisabled();
  await expect(name).toHaveValue("未適用の配管名");
  await expect(target).toHaveValue(pump2);
  await expect(form(p, "始点")).toContainText("接続中：ポンプ1 · 配置1／右");
  await expect(p.locator(`[data-layer-id="${pipe}"]`)).toContainText(
    "ポンプ間配管",
  );
  await target.dispatchEvent("compositionend");
  await button(p, "表示プレビュー").click();
  await button(p, "適用して続行").click();
  await expect(button(p, "編集")).toBeVisible();
  const result = await saved(p);
  expect(result.screens[0].objects[2].name).toBe("未適用の配管名");
  expect(
    result.screens[0].objects[2].shape.connections.start.targetObjectId,
  ).toBe(pump2);
});
test("same-name Symbol placements have distinct visible candidate and committed labels", async ({
  page: p,
}) => {
  const data = structuredClone(sample);
  data.screens[0].objects[0].name = data.screens[0].objects[1].name =
    "同名ポンプ";
  await start(p, data);
  const target = form(p, "始点").getByLabel("始点の接続先", { exact: true });
  await expect(target.locator("option")).toHaveText([
    "接続なし（解除）",
    "同名ポンプ · 配置1",
    "同名ポンプ · 配置2",
  ]);
  await target.selectOption(pump2);
  await button(p, "始点の接続を適用").click();
  await expect(form(p, "始点")).toContainText("接続中：同名ポンプ · 配置2／右");
  expect(
    (await saved(p)).screens[0].objects[2].shape.connections.start
      .targetObjectId,
  ).toBe(pump2);
});
