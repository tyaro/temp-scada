import { test, expect, type Page } from "@playwright/test";
import sample from "../examples/shape-label.project.json" with { type: "json" };
import { chooseTheme, mainCanvas } from "./helpers/designer";
import { openProject } from "./helpers/project-files";

// 面の図形の文字（#305 L1b）: 文字の領域・読める向き・Symbol の中・単色モードの文字色・省略の説明。
const objects = sample.screens[0].objects;
const byName = (name: string) => objects.find((o) => o.name === name)!;
const rectangle = byName("矩形の文字");
const ellipse = byName("楕円の文字");
const diamond = byName("ひし形の文字");
const small = byName("省略の出る小さな箱");
const flipped = ["左右反転", "上下反転", "両方の反転"].map(byName);
const monochrome = byName("Symbol 単色・左右反転");
const definition = byName("Symbol 定義の色・上下反転");
const rotated = byName("Symbol 子の回転・左右反転");
const boxSymbol = sample.symbols[0];
const boxChild = boxSymbol.objects[0];

const placement = (page: Page, id: string) =>
  mainCanvas(page).locator(`[data-object-id="${id}"]`);
const label = (page: Page, id: string) =>
  placement(page, id).locator("[data-shape-label] svg[data-text-layout]");

async function start(page: Page, theme: string) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await openProject(page, {
    name: "shape-label.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(sample)),
  });
  await chooseTheme(page, theme);
  for (const object of objects)
    await expect(label(page, object.id).first()).not.toHaveAttribute(
      "data-text-layout",
      "pending",
    );
}

/** 文字の画面上の向き（行列式が正なら鏡でない）と、文字の領域の画面上の中心。 */
async function glyphs(scope: ReturnType<typeof label>) {
  return scope.evaluate((svg) => {
    const text = svg.querySelector("[data-text-content]") as SVGGraphicsElement;
    const m = text.getScreenCTM()!;
    const outer = (svg as SVGSVGElement).getScreenCTM()!;
    const w = Number(svg.getAttribute("width")),
      h = Number(svg.getAttribute("height"));
    return {
      a: m.a,
      d: m.d,
      det: m.a * m.d - m.b * m.c,
      angle: (Math.atan2(m.b, m.a) * 180) / Math.PI,
      cx: outer.a * (w / 2) + outer.c * (h / 2) + outer.e,
      cy: outer.b * (w / 2) + outer.d * (h / 2) + outer.f,
      fill: text.getAttribute("fill"),
    };
  });
}
/** 形（rect・ellipse・polygon）の画面上の中心。 */
async function shapeCenter(page: Page, id: string, child?: string) {
  const scope = child
    ? placement(page, id).locator(`[data-symbol-child-id="${child}"]`)
    : placement(page, id);
  return scope
    .locator("rect, ellipse, polygon")
    .first()
    .evaluate((shape) => {
      const box = (shape as SVGGraphicsElement).getBBox();
      const m = (shape as SVGGraphicsElement).getScreenCTM()!;
      const x = box.x + box.width / 2,
        y = box.y + box.height / 2;
      return { cx: m.a * x + m.c * y + m.e, cy: m.b * x + m.d * y + m.f };
    });
}

for (const theme of ["light", "dark"])
  test(`shape labels render readable, centered and in label.color (${theme})`, async ({
    page,
  }) => {
    await start(page, theme);

    // 矩形・ひし形: 明示の改行どおりの行、文字色は label.color。
    expect(
      await label(page, rectangle.id)
        .locator("[data-text-content]")
        .allTextContents(),
    ).toEqual(rectangle.shape.label!.text.split("\n"));
    await expect(label(page, diamond.id)).toHaveAttribute(
      "data-text-layout",
      "full",
    );
    const plain = await glyphs(label(page, rectangle.id));
    expect(plain.fill).toBe(rectangle.shape.label!.color);
    expect(plain.det).toBeGreaterThan(0);
    // 文字は pointer-events: none（形の当たり判定で選ぶ）。
    expect(
      await placement(page, rectangle.id)
        .locator("[data-shape-label]")
        .evaluate((g) => getComputedStyle(g).pointerEvents),
    ).toBe("none");

    // 反転: 形だけ鏡になり、文字は読める向きのまま枠の中心にいる。
    for (const object of flipped) {
      const glyph = await glyphs(label(page, object.id));
      expect(glyph.det).toBeGreaterThan(0);
      expect(glyph.a).toBeGreaterThan(0);
      expect(glyph.d).toBeGreaterThan(0);
      const center = await shapeCenter(page, object.id);
      expect(glyph.cx).toBeCloseTo(center.cx, 0);
      expect(glyph.cy).toBeCloseTo(center.cy, 0);
    }
    // 中央揃えの 1 行は、画面上でも形の中心に描かれる（描画の矩形で確かめる）。
    for (const object of flipped.slice(1)) {
      const drawn = await placement(page, object.id).evaluate((root) => {
        const center = (el: Element) => {
          const b = el.getBoundingClientRect();
          return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
        };
        return {
          shape: center(root.querySelector("[data-object-rotation] rect")!),
          text: center(root.querySelector("[data-text-content]")!),
        };
      });
      expect(Math.abs(drawn.text.x - drawn.shape.x)).toBeLessThan(1.5);
      expect(Math.abs(drawn.text.y - drawn.shape.y)).toBeLessThan(3);
    }
    // 左寄せは反転しても左寄せのまま（鏡で右寄せにしない）。
    const leftAligned = await label(page, flipped[0].id).evaluate((svg) => {
      const box = svg.getBoundingClientRect();
      const text = svg.querySelector("[data-text-content]")!;
      return text.getBoundingClientRect().x - box.x;
    });
    expect(leftAligned).toBeLessThan(10);

    // 反転した Symbol 配置の中でも同じ。単色モードでも文字色は label.color。
    for (const object of [monochrome, definition]) {
      const scope = placement(page, object.id).locator(
        `[data-symbol-child-id="${boxChild.id}"] [data-shape-label] svg[data-text-layout]`,
      );
      const glyph = await glyphs(scope);
      expect(glyph.det).toBeGreaterThan(0);
      expect(glyph.a).toBeGreaterThan(0);
      expect(glyph.d).toBeGreaterThan(0);
      expect(glyph.fill).toBe(boxChild.shape.label!.color);
      const center = await shapeCenter(page, object.id, boxChild.id);
      expect(glyph.cx).toBeCloseTo(center.cx, 0);
      expect(glyph.cy).toBeCloseTo(center.cy, 0);
    }
    await expect(
      placement(page, monochrome.id).locator(
        `[data-symbol-child-id="${boxChild.id}"] rect`,
      ),
    ).toHaveAttribute("fill", monochrome.fill!);
    // Symbol の子の文字には配置の説明を付けない。
    await expect(
      placement(page, monochrome.id).locator(":scope > title"),
    ).toHaveCount(0);

    // 親 flipX × 子 rotation 30: 画面上で −30°、鏡でない。
    const tilted = await glyphs(
      placement(page, rotated.id).locator(
        "[data-shape-label] svg[data-text-layout]",
      ),
    );
    expect(tilted.angle).toBeCloseTo(-30, 1);
    expect(tilted.det).toBeGreaterThan(0);

    // 楕円: 文字は内接矩形（幅・高さ / √2）に収まる。
    const inscribed = await placement(page, ellipse.id)
      .locator("ellipse")
      .evaluate((shape) => {
        const box = shape.getBoundingClientRect();
        const w = box.width / Math.SQRT2,
          h = box.height / Math.SQRT2;
        return {
          left: box.x + (box.width - w) / 2,
          top: box.y + (box.height - h) / 2,
          right: box.x + (box.width + w) / 2,
          bottom: box.y + (box.height + h) / 2,
        };
      });
    const ellipseLines = await label(page, ellipse.id)
      .locator("[data-text-content]")
      .evaluateAll((els) =>
        els.map((el) => {
          const b = el.getBoundingClientRect();
          return { left: b.x, top: b.y, right: b.right, bottom: b.bottom };
        }),
      );
    expect(ellipseLines.length).toBeGreaterThan(1);
    for (const line of ellipseLines) {
      expect(line.left).toBeGreaterThanOrEqual(inscribed.left - 0.5);
      expect(line.right).toBeLessThanOrEqual(inscribed.right + 0.5);
      expect(line.top).toBeGreaterThanOrEqual(inscribed.top - 0.5);
      expect(line.bottom).toBeLessThanOrEqual(inscribed.bottom + 0.5);
    }

    // 省略: 小さな箱は省略表示、配置の <title> に全文。
    await expect(label(page, small.id)).toHaveAttribute(
      "data-text-layout",
      "ellipsis",
    );
    const title = await placement(page, small.id)
      .locator(":scope > title")
      .textContent();
    expect(title).toContain(small.shape.label!.text);
    expect(title).toContain("省略表示");
  });
