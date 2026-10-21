import type { TextMetrics } from "./text-layout";

/** Keep adaptive getBBox writes outside the drawing's large SVG/style subtree. */
export function withSvgTextMeasure<T>(
  source: SVGTextElement,
  run: (measure: (text: string) => TextMetrics) => T,
): T {
  if (!source.isConnected || !source.ownerSVGElement?.getClientRects().length)
    throw new Error("Text is not measurable while hidden");
  const document = source.ownerDocument;
  const host = document.createElement("div");
  host.setAttribute("data-text-measure-host", "");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText =
    "position:fixed;left:-10000px;top:0;width:1px;height:1px;contain:strict;overflow:hidden;visibility:hidden;pointer-events:none";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "1");
  svg.setAttribute("height", "1");
  let root = source.ownerSVGElement!;
  while (root.ownerSVGElement) root = root.ownerSVGElement;
  const rootLocal = root.getCTM(),
    rootScreen = root.getScreenCTM(),
    sourceScreen = source.getScreenCTM();
  if (!rootLocal || !rootScreen || !sourceScreen)
    throw new Error("Text transform is unavailable");
  // Remove CSS paint transforms above the outer SVG while retaining every SVG viewport/group.
  const matrix = rootLocal
    .multiply(rootScreen.inverse())
    .multiply(sourceScreen);
  if (![matrix.a, matrix.b, matrix.c, matrix.d].every(Number.isFinite))
    throw new Error("Text transform is not invertible");
  // SVG viewport scaling affects Chromium's font hinting; CSS paint transforms do not.
  const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
  group.setAttribute(
    "transform",
    `matrix(${matrix.a},${matrix.b},${matrix.c},${matrix.d},0,0)`,
  );
  const probe = source.cloneNode(false) as SVGTextElement;
  probe.removeAttribute("id");
  probe.removeAttribute("transform");
  // Preserve the original SVG font metrics, including inherited typography.
  const computed = document.defaultView!.getComputedStyle(source);
  for (const property of [
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "font-stretch",
    "font-kerning",
    "font-variant",
    "letter-spacing",
    "word-spacing",
    "text-anchor",
    "dominant-baseline",
    "direction",
    "writing-mode",
    "white-space",
    "text-rendering",
  ])
    probe.style.setProperty(property, computed.getPropertyValue(property));
  group.append(probe);
  svg.append(group);
  host.append(svg);
  document.body.append(host);
  try {
    return run((text) => {
      probe.textContent = text;
      const box = probe.getBBox();
      if (text.trim() && box.width === 0 && box.height === 0)
        throw new Error("Text is not measurable");
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    });
  } finally {
    host.remove();
  }
}
