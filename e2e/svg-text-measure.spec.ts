import { test, expect } from "@playwright/test";
import { chooseTheme } from "./helpers/designer";
for (const theme of ["light", "dark"] as const)
  test(`isolated SVG measurement matches in-drawing metrics and releases temporary DOM in ${theme}`, async ({
    page,
  }) => {
    await page.goto("/");
    await chooseTheme(page, theme);
    const result = await page.evaluate(async () => {
      const modulePath = "/src/lib/svg-text-measure.ts";
      const { withSvgTextMeasure } = await import(modulePath);
      await document.fonts.ready;
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      const source = document.createElementNS(
        svg.namespaceURI,
        "text",
      ) as SVGTextElement;
      svg.style.cssText =
        "position:fixed;left:0;top:0;width:300px;height:200px";
      source.setAttribute(
        "font-family",
        'Arial, "Noto Sans", "Noto Sans CJK JP", sans-serif',
      );
      source.style.whiteSpace = "pre";
      source.setAttribute("visibility", "hidden");
      svg.append(source);
      document.body.append(svg);
      const differences = [];
      try {
        for (const size of [8, 18, 32.5])
          for (const weight of ["normal", "bold"])
            for (const spacing of ["normal", "1.25px"]) {
              source.setAttribute("font-size", String(size));
              source.setAttribute("font-weight", weight);
              source.style.letterSpacing = spacing;
              for (const text of [
                "原水ポンプ A",
                "  A B  ",
                "👩‍🔧 pump",
                "…",
                "",
                "éÅg",
              ]) {
                source.textContent = text;
                const before = source.getBBox();
                const after = withSvgTextMeasure(source, (measure) =>
                  measure(text),
                );
                for (const key of ["x", "y", "width", "height"] as const)
                  differences.push(Math.abs(before[key] - after[key]));
              }
            }
        let failed = false;
        try {
          withSvgTextMeasure(source, () => {
            throw new Error("expected");
          });
        } catch {
          failed = true;
        }
        svg.style.display = "none";
        let hidden = false;
        try {
          withSvgTextMeasure(source, (measure) => measure("hidden"));
        } catch {
          hidden = true;
        }
        return {
          maxDifference: Math.max(...differences),
          failed,
          hidden,
          hosts: document.querySelectorAll("[data-text-measure-host]").length,
        };
      } finally {
        svg.remove();
      }
    });
    expect(result).toEqual({
      maxDifference: 0,
      failed: true,
      hidden: true,
      hosts: 0,
    });
  });
