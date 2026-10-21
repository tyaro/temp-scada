import { expect, test, type Page } from "@playwright/test";
import sample from "../examples/connection.project.json" with { type: "json" };
import { mainCanvas, chooseTheme, selectPanel } from "./helpers/designer";
import {
  openProject,
  downloadProject,
  downloadBytes,
} from "./helpers/project-files";
const [pump1, pump2, pipe] = sample.screens[0].objects.map((o) => o.id);
const button = (p: Page, name: string) =>
  p.getByRole("button", { name, exact: true });
async function start(p: Page, data: object = sample) {
  await p.setViewportSize({ width: 1920, height: 1080 });
  await p.goto("/");
  await button(p, "編集").click();
  await openProject(p, {
    name: "connections.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(data)),
  });
}
async function select(p: Page, id: string) {
  await selectPanel(p, "レイヤー");
  await p.locator(`[data-layer-id="${id}"]`).click();
}
async function vertices(p: Page) {
  return mainCanvas(p)
    .locator(`:scope > [data-object-id="${pipe}"] polyline`)
    .first()
    .evaluate((el) => {
      const line = el as SVGPolylineElement,
        root = line.ownerSVGElement!;
      const toWorld = root.getScreenCTM()!.inverse(),
        matrix = line.getScreenCTM()!;
      return Array.from(line.points).map((point) => {
        const p = new DOMPoint(point.x, point.y)
          .matrixTransform(matrix)
          .matrixTransform(toWorld);
        return {
          x: Math.round(p.x * 1e5) / 1e5,
          y: Math.round(p.y * 1e5) / 1e5,
        };
      });
    });
}
async function point(p: Page, x: number, y: number) {
  return mainCanvas(p).evaluate(
    (svg, { x, y }) => {
      const p = new DOMPoint(x, y).matrixTransform(
        (svg as SVGSVGElement).getScreenCTM()!,
      );
      return { x: p.x, y: p.y };
    },
    { x, y },
  );
}
async function drag(p: Page) {
  const from = await point(p, 140, 220),
    to = await point(p, 210, 250);
  await p.mouse.move(from.x, from.y);
  await p.mouse.down();
  await p.mouse.move(to.x, to.y, { steps: 5 });
}
async function saved(p: Page) {
  return JSON.parse((await downloadBytes(await downloadProject(p))).toString());
}
for (const theme of ["light", "dark"])
  test(`connected endpoints follow a live target drag, cancel, commit and Undo in ${theme}`, async ({
    page: p,
  }) => {
    await start(p);
    await chooseTheme(p, theme);
    const before = await vertices(p);
    await drag(p);
    await expect
      .poll(() => vertices(p))
      .toEqual([{ x: 250, y: 250 }, ...before.slice(1)]);
    await p.keyboard.press("Escape");
    await p.mouse.up();
    await expect.poll(() => vertices(p)).toEqual(before);
    await drag(p);
    await p.mouse.up();
    await expect
      .poll(() => vertices(p))
      .toEqual([{ x: 250, y: 250 }, ...before.slice(1)]);
    const result = await saved(p);
    expect(result.screens[0].objects[2].shape.connections).toEqual(
      sample.screens[0].objects[2].shape.connections,
    );
    await button(p, "元に戻す").click();
    await expect.poll(() => vertices(p)).toEqual(before);
    await expect(button(p, "元に戻す")).toBeDisabled();
    await select(p, pump1);
    await p.getByLabel("回転角度", { exact: true }).fill("90");
    await p.getByLabel("回転角度", { exact: true }).press("Enter");
    await expect
      .poll(() => vertices(p))
      .toEqual([{ x: 140, y: 260 }, ...before.slice(1)]);
    await p.getByLabel("width", { exact: true }).fill("120");
    await p.getByLabel("width", { exact: true }).press("Enter");
    await expect
      .poll(() => vertices(p))
      .toEqual([{ x: 160, y: 280 }, ...before.slice(1)]);
    await button(p, "表示プレビュー").click();
    await expect
      .poll(() => vertices(p))
      .toEqual([{ x: 160, y: 280 }, ...before.slice(1)]);
  });
test("a locked referring line blocks the target drag and leaves history and persisted geometry unchanged", async ({
  page: p,
}) => {
  const data = structuredClone(sample);
  (data.screens[0].objects[2] as any).locked = true;
  await start(p, data);
  const before = await vertices(p);
  await drag(p);
  await expect.poll(() => vertices(p)).toEqual(before);
  await p.mouse.up();
  await expect(p.getByTestId("project-status")).toContainText("ロック");
  await expect(button(p, "元に戻す")).toBeDisabled();
  expect(await saved(p)).toEqual(data);
});
test("target-only delete and cut are rejected before clipboard write; grouped selection can remove its line too", async ({
  page: p,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await start(p);
  await select(p, pump1);
  await p.keyboard.press("Delete");
  await expect(p.getByTestId("project-status")).toContainText("接続先");
  await p.evaluate(() => navigator.clipboard.writeText("keep clipboard"));
  await mainCanvas(p).focus();
  await p.keyboard.press("Control+x");
  await expect(p.getByTestId("project-status")).toContainText("接続先");
  expect(await p.evaluate(() => navigator.clipboard.readText())).toBe(
    "keep clipboard",
  );
  await expect(button(p, "元に戻す")).toBeDisabled();
  await select(p, pipe);
  await expect(
    p.locator(`[data-vertex-object-id="${pipe}"][data-vertex-index="0"]`),
  ).toHaveAttribute("aria-disabled", "true");
  await expect(
    p.locator(`[data-vertex-object-id="${pipe}"][data-vertex-index="1"]`),
  ).toHaveAttribute("aria-disabled", "false");
  await p.locator(`[data-layer-id="${pump1}"]`).click({ modifiers: ["Shift"] });
  await p.keyboard.press("Delete");
  expect((await saved(p)).screens[0].objects.map((o: any) => o.id)).toEqual([
    pump2,
  ]);
  await button(p, "元に戻す").click();
  expect((await saved(p)).screens[0].objects).toEqual(
    sample.screens[0].objects,
  );
});
