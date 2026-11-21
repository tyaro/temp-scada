import { test, expect, type Page } from "@playwright/test";
import sample from "../examples/shape-label-flow.project.json" with { type: "json" };
import {
  chooseTheme,
  fileCommand,
  mainCanvas,
  selectPanel,
} from "./helpers/designer";
import {
  downloadBytes,
  downloadProject,
  openProject,
} from "./helpers/project-files";

// フロー図のサンプル（#305 L3）: 工程の箱 10・ひし形 3・手入力の箱 1・端子 2 を、Text を別に置かずに文言つきで描く。
const objects = sample.screens[0].objects;
const shapes = objects.filter((o) => o.shape.type !== "polyline");
const firstLine = (o: (typeof shapes)[number]) =>
  (o.shape as { label: { text: string } }).label.text.split("\n")[0];

for (const theme of ["light", "dark"] as const)
  test(`flow sample draws every label without separate Text objects in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto("/");
    await chooseTheme(page, theme);
    await selectPanel(page, "プロジェクト");
    await fileCommand(page, "フロー図のサンプルを開く");
    const canvas = mainCanvas(page);
    // 配置は 16 の図形と 15 の矢印だけ。Text の配置は無い。
    await expect(canvas.locator("[data-object-id]")).toHaveCount(
      objects.length,
    );
    await expect(
      canvas.locator("[data-object-id]:not(:has([data-shape-label]))"),
    ).toHaveCount(objects.length - shapes.length);
    expect(shapes.filter((o) => o.shape.type === "rectangle")).toHaveLength(10);
    expect(
      shapes.filter(
        (o) =>
          o.shape.type === "polygon" &&
          (o.shape as { points: unknown[] }).points.length === 4 &&
          o.name.startsWith("判断"),
      ),
    ).toHaveLength(3);
    for (const object of shapes)
      await expect(
        canvas
          .locator(
            `[data-object-id="${object.id}"] [data-shape-label] [data-text-content]`,
          )
          .first(),
      ).toHaveText(firstLine(object));
    // 矩形は枠の中に文言があり、ひし形は枠の頂点で 4 角を描く。
    await expect(
      canvas.locator(
        '[data-object-id] > [data-object-rotation] polygon[stroke-linejoin="miter"]',
      ),
    ).toHaveCount(4);
  });

// #306 E2: 見本の矢印は図形へ接続済み。箱を動かすと前後の矢印が付いてきて、保存・再読込で残る。
const diamond = shapes.find((o) => o.name === "判断 温度")!;
const lines = objects.filter((o) => o.shape.type === "polyline");
type Connected = {
  points: { x: number; y: number }[];
  connections: Record<"start" | "end", { targetObjectId: string }>;
};
const shapeOf = (o: (typeof objects)[number]) =>
  o.shape as unknown as Connected;
const into = lines.find(
  (o) => shapeOf(o).connections.end.targetObjectId === diamond.id,
)!;
const out = lines.find(
  (o) => shapeOf(o).connections.start.targetObjectId === diamond.id,
)!;
async function ends(page: Page, id: string) {
  return mainCanvas(page)
    .locator(`:scope > [data-object-id="${id}"] polyline`)
    .first()
    .evaluate((el) => {
      const line = el as SVGPolylineElement;
      const toWorld = line.ownerSVGElement!.getScreenCTM()!.inverse();
      const matrix = line.getScreenCTM()!;
      return Array.from(line.points).map((point) => {
        const p = new DOMPoint(point.x, point.y)
          .matrixTransform(matrix)
          .matrixTransform(toWorld);
        return {
          x: Math.round(p.x * 1e3) / 1e3,
          y: Math.round(p.y * 1e3) / 1e3,
        };
      });
    });
}
async function screenPoint(page: Page, x: number, y: number) {
  return mainCanvas(page).evaluate(
    (svg, { x, y }) => {
      const p = new DOMPoint(x, y).matrixTransform(
        (svg as SVGSVGElement).getScreenCTM()!,
      );
      return { x: p.x, y: p.y };
    },
    { x, y },
  );
}
const shifted = (p: { x: number; y: number }) => ({ x: p.x + 40, y: p.y + 20 });

for (const theme of ["light", "dark"] as const)
  test(`flow sample arrows follow a moved box and survive save and reload in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto("/");
    await chooseTheme(page, theme);
    await page.getByRole("button", { name: "編集", exact: true }).click();
    await selectPanel(page, "プロジェクト");
    await fileCommand(page, "フロー図のサンプルを開く");
    const [intoStart, intoEnd] = shapeOf(into).points;
    const [outStart, outEnd] = shapeOf(out).points;
    await expect.poll(() => ends(page, into.id)).toEqual([intoStart, intoEnd]);

    // Inspector で接続先を種類つきで確かめる。
    await selectPanel(page, "レイヤー");
    await page.locator(`[data-layer-id="${into.id}"]`).click();
    await expect(
      page.getByRole("form", { name: "終点の接続", exact: true }),
    ).toContainText(
      `接続中：判断 温度（多角形） · 配置${diamond.order + 1}／右`,
    );

    // 判断の箱の左寄り（文字の無いところ）をつかんで動かす。
    const from = await screenPoint(page, diamond.x + 30, diamond.y + 50);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    const to = await screenPoint(page, diamond.x + 70, diamond.y + 70);
    await page.mouse.move(to.x, to.y, { steps: 5 });
    await page.mouse.up();
    await expect
      .poll(() => ends(page, into.id))
      .toEqual([intoStart, shifted(intoEnd)]);
    await expect
      .poll(() => ends(page, out.id))
      .toEqual([shifted(outStart), outEnd]);

    const saved = JSON.parse(
      (await downloadBytes(await downloadProject(page))).toString(),
    );
    const savedLine = (id: string) =>
      saved.screens[0].objects.find((o: { id: string }) => o.id === id).shape;
    expect(savedLine(into.id).connections).toEqual(shapeOf(into).connections);
    expect(savedLine(into.id).points).toEqual([intoStart, shifted(intoEnd)]);
    expect(savedLine(out.id).points).toEqual([shifted(outStart), outEnd]);

    await openProject(page, {
      name: "flow.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(saved)),
    });
    await expect
      .poll(() => ends(page, out.id))
      .toEqual([shifted(outStart), outEnd]);
    await selectPanel(page, "レイヤー");
    await page.locator(`[data-layer-id="${out.id}"]`).click();
    await expect(
      page.getByRole("form", { name: "始点の接続", exact: true }),
    ).toContainText(
      `接続中：判断 温度（多角形） · 配置${diamond.order + 1}／下`,
    );
  });
