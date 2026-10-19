import type { Page } from "@playwright/test";

export interface ImageFixture {
  width: number;
  height: number;
  rectangles: {
    x: number;
    y: number;
    width: number;
    height: number;
    color: string;
  }[];
}
/** Real browser encoding: source bytes and transparency are part of the tests. */
export async function pngFixture(
  page: Page,
  fixture: ImageFixture,
): Promise<Buffer> {
  const encoded = await page.evaluate(({ width, height, rectangles }) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d")!;
    for (const rect of rectangles) {
      context.fillStyle = rect.color;
      context.fillRect(rect.x, rect.y, rect.width, rect.height);
    }
    return canvas.toDataURL("image/png").split(",")[1];
  }, fixture);
  return Buffer.from(encoded, "base64");
}
