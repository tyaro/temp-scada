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
    await p.getByLabel("幅", { exact: true }).fill("120");
    await p.getByLabel("幅", { exact: true }).press("Enter");
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
  await p.keyboard.press("ControlOrMeta+x");
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

test("an unconnected polygon keeps its in-progress vertex preview on a screen with other connections", async ({
  page: p,
}) => {
  // Issue #306 E1（オーナーのレビュー P3）: 作り直しは線から参照される多角形だけに当てる。
  // 無関係な接続線がある画面でも、独立した多角形は従来どおり途中の形を見せ、離したときに検査する。
  await start(p);
  await selectPanel(p, "部品");
  await button(p, "多角形を追加").click();
  const polygon = mainCanvas(p).locator(
    '[data-selected="true"] > [data-object-rotation] polygon',
  );
  await expect(polygon).toHaveAttribute("points", "80,0 160,100 0,100");
  const handle = mainCanvas(p).locator('[data-vertex-index="0"]');
  const box = (await handle.boundingBox())!;
  const scale = await handle.evaluate(
    (element) => (element as SVGGraphicsElement).getScreenCTM()!.a,
  );
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await p.mouse.move(from.x, from.y);
  await p.mouse.down();
  await p.keyboard.down("Alt");
  await p.mouse.move(from.x, from.y + 50 * scale);
  await p.mouse.move(from.x, from.y + 100 * scale);
  // 下の辺に重ねた途中の形（確定すれば一直線で拒否される）がそのまま見える。
  await expect(polygon).not.toHaveAttribute("points", "80,0 160,100 0,100");
  await expect(polygon).toHaveAttribute("points", /^80,100 /);
  await p.mouse.up();
  await p.keyboard.up("Alt");
  await expect(p.getByTestId("project-status")).toContainText("1以上");
  await expect(polygon).toHaveAttribute("points", "80,0 160,100 0,100");
});
// Issue #306 E3: 接続していない端をドラッグして anchor の近くで離すと接続する。
const loose = (() => {
  const data = structuredClone(sample) as any;
  const line = data.screens[0].objects[2];
  line.shape.connections = { start: line.shape.connections.start };
  line.shape.points[3] = { x: 300, y: 320 };
  return data;
})();
async function dragEnd(p: Page, to: { x: number; y: number }, alt = false) {
  await select(p, pipe);
  const from = await point(p, 300, 320),
    target = await point(p, to.x, to.y);
  await mainCanvas(p)
    .locator(`[data-vertex-object-id="${pipe}"][data-vertex-index="3"]`)
    .waitFor();
  await p.mouse.move(from.x, from.y);
  await p.mouse.down();
  if (alt) await p.keyboard.down("Alt");
  await p.mouse.move(target.x, target.y, { steps: 5 });
}
for (const theme of ["light", "dark"])
  test(`dragging a loose end near an anchor snaps, connects with one Undo, and Alt skips it in ${theme}`, async ({
    page: p,
  }) => {
    await start(p, loose);
    await chooseTheme(p, theme);
    const before = await vertices(p);
    expect(before.at(-1)).toEqual({ x: 300, y: 320 });
    await dragEnd(p, { x: 355, y: 323 });
    const ring = mainCanvas(p).locator(".connection-snap");
    await expect(ring).toHaveAttribute("data-snap-target-id", pump2);
    await expect(ring).toHaveAttribute("data-snap-anchor", "left");
    await expect
      .poll(async () => (await vertices(p)).at(-1))
      .toEqual({ x: 360, y: 320 });
    await p.mouse.up();
    await expect(ring).toHaveCount(0);
    await expect
      .poll(() => vertices(p))
      .toEqual([...before.slice(0, -1), { x: 360, y: 320 }]);
    const result = await saved(p);
    expect(result.screens[0].objects[2].shape.connections).toEqual(
      sample.screens[0].objects[2].shape.connections,
    );
    await button(p, "元に戻す").click();
    await expect.poll(() => vertices(p)).toEqual(before);
    await expect(button(p, "元に戻す")).toBeDisabled();
    // Alt を押す間は吸着もグリッドも止まり、離した位置へ動くだけ。
    await dragEnd(p, { x: 357, y: 321 }, true);
    await expect(ring).toHaveCount(0);
    await p.mouse.up();
    await p.keyboard.up("Alt");
    await expect
      .poll(async () => {
        const end = (await vertices(p)).at(-1)!;
        return [Math.round(end.x), Math.round(end.y)];
      })
      .toEqual([357, 321]);
    expect(
      (await saved(p)).screens[0].objects[2].shape.connections.end,
    ).toBeUndefined();
    // anchor の近くに置いた端をクリックしただけでは、接続も座標も履歴も変わらない
    // （#372 のレビュー P2）。
    const placed = await vertices(p);
    const at = await point(p, placed.at(-1)!.x, placed.at(-1)!.y);
    await p.mouse.move(at.x, at.y);
    await p.mouse.down();
    await expect(ring).toHaveCount(0);
    await p.mouse.up();
    await expect(ring).toHaveCount(0);
    await expect.poll(() => vertices(p)).toEqual(placed);
    expect(
      (await saved(p)).screens[0].objects[2].shape.connections.end,
    ).toBeUndefined();
    await button(p, "元に戻す").click();
    await expect.poll(() => vertices(p)).toEqual(before);
    await expect(button(p, "元に戻す")).toBeDisabled();
  });
test("grid rounding that lands a dragged end on the other end still snaps to a valid anchor", async ({
  page: p,
}) => {
  // #372 のレビュー P3: 2 点の線 (360,330)→(300,330) の終点を、ポンプ2 の left
  // (360,320) の近くの (361,326) へ寄せる。グリッド 10 の丸めでは途中の終点が始点
  // (360,330) に重なるが、確定と同じく保存済みの線で判定するので left へ接続する。
  const data = structuredClone(sample) as any;
  const line = data.screens[0].objects[2];
  delete line.shape.connections;
  line.shape.points = [
    { x: 360, y: 330 },
    { x: 300, y: 330 },
  ];
  await start(p, data);
  await p.getByLabel("グリッドにスナップ", { exact: true }).check();
  await select(p, pipe);
  const from = await point(p, 300, 330),
    to = await point(p, 361, 326);
  await mainCanvas(p)
    .locator(`[data-vertex-object-id="${pipe}"][data-vertex-index="1"]`)
    .waitFor();
  await p.mouse.move(from.x, from.y);
  await p.mouse.down();
  await p.mouse.move(to.x, to.y, { steps: 5 });
  const ring = mainCanvas(p).locator(".connection-snap");
  await expect(ring).toHaveAttribute("data-snap-target-id", pump2);
  await expect(ring).toHaveAttribute("data-snap-anchor", "left");
  await expect
    .poll(() => vertices(p))
    .toEqual([
      { x: 360, y: 330 },
      { x: 360, y: 320 },
    ]);
  await p.mouse.up();
  await expect
    .poll(() => vertices(p))
    .toEqual([
      { x: 360, y: 330 },
      { x: 360, y: 320 },
    ]);
  expect((await saved(p)).screens[0].objects[2].shape.connections).toEqual({
    end: { targetObjectId: pump2, anchor: "left" },
  });
});
// Issue #306 E4: 連続配置で配管を選び、クリックで頂点を足して描く。始点・終点は anchor へ吸着する。
const boxesOnly = (() => {
  const data = structuredClone(sample) as any;
  data.screens[0].objects = data.screens[0].objects.slice(0, 2);
  return data;
})();
async function clickAt(p: Page, x: number, y: number) {
  await p.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const at = await point(p, x, y);
  await p.mouse.move(at.x - 3, at.y - 3);
  await p.mouse.click(at.x, at.y);
}
for (const theme of ["light", "dark"])
  test(`drawing a pipe by clicks snaps both ends to anchors, commits once and Undo removes it in ${theme}`, async ({
    page: p,
  }) => {
    await start(p, boxesOnly);
    await chooseTheme(p, theme);
    await selectPanel(p, "部品");
    await button(p, "連続配置ツール").click();
    await button(p, "配管を追加").click();
    await p.getByLabel("グリッドにスナップ", { exact: true }).check();
    await p.getByLabel("グリッド間隔", { exact: true }).selectOption("10");
    const bar = p.getByRole("status", { name: "連続配置の状態", exact: true });
    await expect(bar).toContainText("描く");
    const objects = mainCanvas(p).locator(":scope > [data-object-id]");
    await expect(objects).toHaveCount(2);
    const draft = p.getByTestId("line-draft");
    // 1 点目: ポンプ1 の right (180,220) の近く。始点の輪が残る。
    await clickAt(p, 184, 223);
    const startRing = draft.locator('.connection-snap[data-snap-end="start"]');
    await expect(startRing).toHaveAttribute("data-snap-target-id", pump1);
    await expect(startRing).toHaveAttribute("data-snap-anchor", "right");
    await clickAt(p, 270, 220);
    await clickAt(p, 270, 320);
    // 終点の候補: ポンプ2 の left (360,320) の近くで輪が出る。
    const near = await point(p, 355, 317);
    await p.mouse.move(near.x, near.y);
    const endRing = draft.locator('.connection-snap[data-snap-end="end"]');
    await expect(endRing).toHaveAttribute("data-snap-target-id", pump2);
    await expect(endRing).toHaveAttribute("data-snap-anchor", "left");
    await expect(objects).toHaveCount(2);
    await clickAt(p, 355, 317);
    await expect(objects).toHaveCount(3);
    await expect(draft).toHaveCount(0);
    const line = (await saved(p)).screens[0].objects[2];
    // 描いた線を選択する（今の追加と同じ。#373 のレビュー）。
    await expect(
      mainCanvas(p).locator(`[data-vertex-object-id="${line.id}"]`).first(),
    ).toBeAttached();
    expect(line.shape.type).toBe("polyline");
    expect(line.shape.strokeWidth).toBe(8);
    expect(line.shape.connections).toEqual({
      start: { targetObjectId: pump1, anchor: "right" },
      end: { targetObjectId: pump2, anchor: "left" },
    });
    expect(
      line.shape.points.map((q: any) => ({ x: q.x + line.x, y: q.y + line.y })),
    ).toEqual([
      { x: 180, y: 220 },
      { x: 270, y: 220 },
      { x: 270, y: 320 },
      { x: 360, y: 320 },
    ]);
    // 配置の状態は残る。Undo 1 回で線ごと消える。
    await expect(bar).toContainText("描く");
    await button(p, "元に戻す").click();
    await expect(objects).toHaveCount(2);
    await expect(button(p, "元に戻す")).toBeDisabled();
  });
test("Escape cancels only the line in progress, Enter commits a free line, and a second Escape stops placement", async ({
  page: p,
}) => {
  await start(p, boxesOnly);
  await selectPanel(p, "部品");
  await button(p, "連続配置ツール").click();
  await button(p, "線を追加").click();
  const bar = p.getByRole("status", { name: "連続配置の状態", exact: true });
  const objects = mainCanvas(p).locator(":scope > [data-object-id]");
  const draft = p.getByTestId("line-draft");
  await clickAt(p, 100, 400);
  await clickAt(p, 200, 400);
  await expect(draft.locator("polyline")).toHaveCount(1);
  await p.keyboard.press("Escape");
  await expect(draft).toHaveCount(0);
  await expect(bar).toBeVisible();
  await expect(objects).toHaveCount(2);
  // Backspace で 1 点戻し、Enter で確定する。接続は無い。
  await clickAt(p, 100, 400);
  await clickAt(p, 150, 450);
  await clickAt(p, 200, 400);
  await p.keyboard.press("Backspace");
  await p.keyboard.press("Enter");
  await expect(objects).toHaveCount(3);
  const line = (await saved(p)).screens[0].objects[2];
  expect(line.shape.strokeWidth).toBe(2);
  expect(line.shape.connections).toBeUndefined();
  expect(line.shape.points).toHaveLength(2);
  // 画面の外（余白）にも頂点を置ける（#373 のレビュー、オーナーが許容）。
  await p.getByLabel("表示倍率", { exact: true }).selectOption("0.5");
  await clickAt(p, -40, 20);
  await clickAt(p, 100, 100);
  await p.keyboard.press("Enter");
  await expect(objects).toHaveCount(4);
  const outside = (await saved(p)).screens[0].objects[3];
  expect(Math.round(outside.x)).toBe(-40);
  await p.keyboard.press("Escape");
  await expect(bar).toHaveCount(0);
});
