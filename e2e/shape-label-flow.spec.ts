import { test, expect } from "@playwright/test";
import sample from "../examples/shape-label-flow.project.json" with { type: "json" };
import {
  chooseTheme,
  fileCommand,
  mainCanvas,
  selectPanel,
} from "./helpers/designer";

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
