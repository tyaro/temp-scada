import { test, expect } from "@playwright/test";
import { patternGeometry } from "../apps/banto-scada/src/lib/pattern-paint";
// Test the actual SVG tiling and alpha in Chromium before connecting it to the Project paint model.
for (const kind of ["hatch", "crosshatch", "dots"] as const)
  test(`${kind} tile renders one foreground alpha without seams or clipped dots`, async ({
    page,
  }) => {
    await page.goto("/");
    const result = await page.evaluate(
      async ({ kind, path }) => {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36"><defs><pattern id="p" patternUnits="userSpaceOnUse" patternContentUnits="userSpaceOnUse" width="12" height="12"><path d="${path}" fill="#22aa66" fill-opacity="0.5" fill-rule="nonzero"/></pattern></defs><rect width="36" height="36" fill="url(#p)"/></svg>`;
        const image = new Image();
        image.src =
          "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 36;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(image, 0, 0);
        const alpha = (x: number, y: number) =>
          ctx.getImageData(x, y, 1, 1).data[3];
        return {
          kind,
          center: alpha(6, 6),
          horizontal: [0, 1, 11, 12, 13, 23, 24, 35].map((x) => alpha(x, 6)),
          vertical: [0, 1, 11, 12, 13, 23, 24, 35].map((y) => alpha(6, y)),
          empty: alpha(2, 2),
          dotCenters: [6, 18, 30].map((x) => alpha(x, 6)),
        };
      },
      { kind, path: patternGeometry(kind, 12, 4) },
    );
    expect(result.center).toBe(128);
    expect(result.empty).toBe(0);
    if (kind !== "dots") expect(result.horizontal).toEqual(Array(8).fill(128));
    if (kind === "crosshatch")
      expect(result.vertical).toEqual(Array(8).fill(128));
    if (kind === "dots") expect(result.dotCenters).toEqual([128, 128, 128]);
  });
