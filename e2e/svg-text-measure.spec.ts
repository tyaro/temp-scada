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
      const group = document.createElementNS(svg.namespaceURI, "g");
      const inner = document.createElementNS(svg.namespaceURI, "svg");
      inner.setAttribute("width", "180");
      inner.setAttribute("height", "100");
      inner.setAttribute("viewBox", "0 0 200 140");
      inner.setAttribute("preserveAspectRatio", "none");
      inner.append(source);
      group.append(inner);
      svg.append(group);
      document.body.append(svg);
      const differences = [];
      try {
        for (const groupTransform of ["", "rotate(30) scale(1.25 0.8)"]) {
          group.setAttribute("transform", groupTransform);
          for (const scale of [1, 0.684375, 0.137]) {
            svg.setAttribute("viewBox", `0 0 ${300 / scale} ${200 / scale}`);
            for (const transform of [
              "scale(0.137)",
              "scale(0.684375)",
              "scale(1)",
              "scale(2.5)",
              "rotate(30deg) scale(0.684375)",
            ]) {
              svg.style.transformOrigin = "0 0";
              svg.style.transform = transform;
              for (const size of [8, 9.6, 18, 32.5])
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
            }
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
    expect(result.maxDifference).toBeLessThan(0.0001);
    expect({ ...result, maxDifference: 0 }).toEqual({
      maxDifference: 0,
      failed: true,
      hidden: true,
      hosts: 0,
    });
  });

for (const theme of ["light", "dark"] as const)
  test(`single-line fitting preserves text, overflow and alignment metrics in ${theme}`, async ({
    page,
  }) => {
    await page.goto("/");
    await chooseTheme(page, theme);
    const result = await page.evaluate(async () => {
      const measurePath = "/src/lib/svg-text-measure.ts",
        layoutPath = "/src/lib/text-layout.ts";
      const { withSvgTextMeasure } = await import(measurePath);
      const { fitText, TEXT_FONT } = await import(layoutPath);
      await document.fonts.ready;
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("width", "300");
      svg.setAttribute("height", "200");
      const source = document.createElementNS(
        svg.namespaceURI,
        "text",
      ) as SVGTextElement;
      source.setAttribute("font-family", TEXT_FONT);
      source.setAttribute("font-size", "20");
      source.style.whiteSpace = "normal";
      svg.append(source);
      document.body.append(svg);
      let maxDifference = 0,
        cases = 0;
      try {
        for (const scale of [1, 0.137]) {
          svg.setAttribute("viewBox", `0 0 ${300 / scale} ${200 / scale}`);
          for (const weight of ["normal", "bold"]) {
            source.setAttribute("font-weight", weight);
            for (const text of [
              "  A B  ",
              "原水ポンプ A",
              "👩‍🔧設備",
              "12345.67",
              "",
              "…",
            ])
              for (const numeric of [false, true])
                for (const width of [4, 70, 300])
                  for (const height of [10, 40]) {
                    const before = fitText(
                      text,
                      width,
                      height,
                      20,
                      numeric,
                      (value: string) => {
                        source.textContent = value;
                        return source.getBBox();
                      },
                    );
                    const after = withSvgTextMeasure(source, (measure: any) =>
                      fitText(text, width, height, 20, numeric, measure),
                    );
                    if (
                      before.text !== after.text ||
                      before.mode !== after.mode
                    )
                      throw new Error(
                        "Single-line fitting changed content or overflow mode",
                      );
                    for (const field of [
                      "baseline",
                      "left",
                      "inkWidth",
                    ] as const)
                      maxDifference = Math.max(
                        maxDifference,
                        Math.abs(before[field] - after[field]),
                      );
                    cases++;
                  }
          }
        }
        return { maxDifference, cases };
      } finally {
        svg.remove();
      }
    });
    expect(result.cases).toBe(288);
    expect(result.maxDifference).toBeLessThan(0.0001);
    await expect(page.locator("[data-text-measure-host]")).toHaveCount(0);
  });
