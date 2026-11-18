import { test, expect, type Page } from "@playwright/test";
import minimal from "../examples/minimal.project.json" with { type: "json" };
import { chooseTheme, mainCanvas, selectPanel } from "./helpers/designer";

const rect = minimal.screens[0].objects[0];
const triangleId = "0199f000-0000-7000-8000-0000000000a1";
const emptyId = "0199f000-0000-7000-8000-0000000000a2";
const triangle = [
  { x: 0.5, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

/** 矩形の真上に同じ枠の三角形、離れた所に塗りも枠線もない三角形を置いた Project。 */
function overlapProject() {
  const project = structuredClone(minimal) as any;
  project.screens[0].objects.push(
    {
      id: triangleId,
      order: 6,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      rotation: 0,
      shape: {
        type: "polygon",
        points: triangle,
        paint: {
          fill: {
            enabled: true,
            paint: { type: "solid", color: "#f59e0b", alpha: 1 },
          },
          stroke: null,
        },
      },
    },
    {
      id: emptyId,
      order: 7,
      x: 420,
      y: 380,
      width: 120,
      height: 120,
      rotation: 0,
      shape: {
        type: "polygon",
        points: triangle,
        paint: {
          fill: {
            enabled: false,
            paint: { type: "solid", color: "#f59e0b", alpha: 1 },
          },
          stroke: null,
        },
      },
    },
  );
  return project;
}

const placement = (page: Page, id: string) =>
  mainCanvas(page).locator(`[data-object-id="${id}"]`);

/** 配置の中の座標（枠の左上が原点）を画面上の位置へ直してクリックする。 */
async function clickLocal(page: Page, id: string, x: number, y: number) {
  const point = await placement(page, id)
    .locator("[data-object-rotation]")
    .evaluate(
      (element, local) => {
        const g = element as SVGGraphicsElement;
        const p = new DOMPoint(local.x, local.y).matrixTransform(
          g.getScreenCTM()!,
        );
        return { x: p.x, y: p.y };
      },
      { x, y },
    );
  await page.mouse.click(point.x, point.y);
}

for (const theme of ["light", "dark"] as const)
  test(`polygon is inserted, drawn, selected and undoable in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto("/");
    await chooseTheme(page, theme);
    await page.getByRole("button", { name: "編集", exact: true }).click();
    await selectPanel(page, "部品");
    const polygons = mainCanvas(page).locator(
      "[data-object-id] > [data-object-rotation] polygon",
    );
    await expect(polygons).toHaveCount(0);
    await page
      .getByRole("button", { name: "多角形を追加", exact: true })
      .click();
    await expect(polygons).toHaveCount(1);
    // 頂点は実寸（160 × 100 の枠）で描き、miter の角にする。
    await expect(polygons).toHaveAttribute("points", "80,0 160,100 0,100");
    await expect(polygons).toHaveAttribute("stroke-linejoin", "miter");
    await expect(polygons).toHaveAttribute("stroke-miterlimit", "4");
    const fill = await polygons.getAttribute("fill");
    expect(fill).toMatch(/^#/);
    const added = mainCanvas(page).locator('[data-selected="true"]');
    await expect(added).toHaveCount(1);
    await expect(
      added.locator(':scope > rect[stroke="var(--canvas-accent)"]'),
    ).toHaveAttribute("width", "160");
    // Inspector は矩形・楕円と同じ塗り・枠線の欄と、実寸の頂点の欄を出す。
    await expect(
      page.getByRole("form", { name: "塗りと枠線", exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("頂点", { exact: true })).toHaveValue(
      "80,0\n160,100\n0,100",
    );
    // ミニマップも同じ部品で描く。
    await expect(
      page.locator(".minimap [data-object-rotation] polygon"),
    ).toHaveCount(1);
    await page.getByRole("button", { name: "元に戻す", exact: true }).click();
    await expect(polygons).toHaveCount(0);
    await page.getByRole("button", { name: "やり直す", exact: true }).click();
    await expect(polygons).toHaveCount(1);
    await expect(polygons).toHaveAttribute("points", "80,0 160,100 0,100");
  });

test("polygon hit test follows the shape, not the frame", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.getByLabel("Project を開く", { exact: true }).setInputFiles({
    name: "polygon.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(overlapProject())),
  });
  await expect(placement(page, triangleId)).toHaveCount(1);
  // 三角形の空いた隅（枠の左上）は、下の矩形を選ぶ。
  await clickLocal(page, triangleId, 20, 20);
  await expect(placement(page, rect.id)).toHaveAttribute(
    "data-selected",
    "true",
  );
  await expect(placement(page, triangleId)).not.toHaveAttribute(
    "data-selected",
    "true",
  );
  // 三角形の中は三角形を選ぶ。
  await clickLocal(page, triangleId, rect.width / 2, rect.height * 0.75);
  await expect(placement(page, triangleId)).toHaveAttribute(
    "data-selected",
    "true",
  );
  // 塗りも枠線もない三角形も、輪郭の近く（右の辺の 3px 外）でつかめる。
  await clickLocal(page, emptyId, 90 + 3, 60);
  await expect(placement(page, emptyId)).toHaveAttribute(
    "data-selected",
    "true",
  );
});

test("polygon vertices are edited in the inspector and rejected in place", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await selectPanel(page, "部品");
  await page.getByRole("button", { name: "多角形を追加", exact: true }).click();
  const polygon = mainCanvas(page).locator(
    "[data-object-id] > [data-object-rotation] polygon",
  );
  const vertices = page.getByLabel("頂点", { exact: true });
  const width = page.getByLabel("幅", { exact: true });
  const x = page.getByLabel("X", { exact: true });
  const startX = Number(await x.inputValue());
  // 左へはみ出す頂点を足すと、外接矩形が新しい枠になり、触っていない頂点は動かない。
  await vertices.fill("80,0\n160,100\n0,100\n-40,50");
  await expect(page.locator("#polygon-points-error")).toHaveCount(0);
  await page.getByRole("button", { name: "変更を適用" }).click();
  await expect(polygon).toHaveAttribute("points", "120,0 200,100 40,100 0,50");
  await expect(width).toHaveValue("200");
  await expect(x).toHaveValue(String(startX - 40));
  await expect(vertices).toHaveValue("120,0\n200,100\n40,100\n0,50");
  // 水平に一直線の頂点は、欄の下に理由を出し、適用しても Project を変えない。
  await vertices.fill("0,5\n50,5\n100,5");
  await expect(page.locator("#polygon-points-error")).toContainText("1以上");
  await expect(vertices).toHaveAttribute("aria-invalid", "true");
  await page.getByRole("button", { name: "変更を適用" }).click();
  await expect(page.getByTestId("project-status")).toContainText("1以上");
  await expect(polygon).toHaveAttribute("points", "120,0 200,100 40,100 0,50");
  // 元に戻すは頂点の編集 1 回ずつ。
  await vertices.fill("120,0\n200,100\n40,100\n0,50");
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect(polygon).toHaveAttribute("points", "80,0 160,100 0,100");
  await expect(x).toHaveValue(String(startX));
});

test("polygon vertices are dragged on the canvas and rejected without changes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await selectPanel(page, "部品");
  await page.getByRole("button", { name: "多角形を追加", exact: true }).click();
  const polygon = mainCanvas(page).locator(
    "[data-object-id] > [data-object-rotation] polygon",
  );
  const handle = (index: number) =>
    mainCanvas(page).locator(`[data-vertex-index="${index}"]`);
  await expect(handle(0)).toHaveCount(1);
  await expect(handle(2)).toHaveCount(1);
  const x = page.getByLabel("X", { exact: true });
  const height = page.getByLabel("高さ", { exact: true });
  const startX = Number(await x.inputValue());
  /** 頂点を画面上の座標（world）で dx, dy だけ動かす。Alt でグリッドへ吸着させない。 */
  async function drag(index: number, dx: number, dy: number) {
    const box = (await handle(index).boundingBox())!;
    const scale = await handle(index).evaluate(
      (element) => (element as SVGGraphicsElement).getScreenCTM()!.a,
    );
    const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.keyboard.down("Alt");
    await page.mouse.move(from.x + (dx * scale) / 2, from.y + (dy * scale) / 2);
    await page.mouse.move(from.x + dx * scale, from.y + dy * scale);
    await page.mouse.up();
    await page.keyboard.up("Alt");
  }
  // 上の頂点を左上の枠の外へ。外接矩形が新しい枠になり、ほかの頂点は動かない。
  await drag(0, -120, -40);
  await expect(polygon).toHaveAttribute("points", "0,0 200,140 40,140");
  await expect(x).toHaveValue(String(startX - 40));
  await expect(height).toHaveValue("140");
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect(polygon).toHaveAttribute("points", "80,0 160,100 0,100");
  // 下の辺に重ねると一直線になるので拒否し、元の形に戻して理由を出す。
  await drag(0, 0, 100);
  await expect(page.getByTestId("project-status")).toContainText("1以上");
  await expect(polygon).toHaveAttribute("points", "80,0 160,100 0,100");
  // 方向キーでも動かせる。上へ動かすと枠が高くなる。
  await handle(0).focus();
  await page.keyboard.press("ArrowUp");
  await expect
    .poll(async () => Number(await height.inputValue()))
    .toBeGreaterThan(100);
});
