import { expect, it } from "vitest";
import {
  DEFAULT_PANEL_WIDTHS,
  parsePanelWidths,
  panelWidthMaximum,
} from "./panel-widths";

it("reads bounded integer widths and recovers from damaged or unsupported preferences", () => {
  const stored = { left: 360, right: 400 };
  expect(parsePanelWidths(JSON.stringify(stored))).toEqual(stored);
  for (const value of [
    undefined,
    null,
    "{",
    "[]",
    "null",
    '{"left":200}',
    '{"left":"240","right":288}',
    '{"left":240.5,"right":288}',
    '{"left":100000,"right":-10}',
    '{"left":240,"right":null}',
  ])
    expect(parsePanelWidths(value)).toEqual(DEFAULT_PANEL_WIDTHS);
  const fallback = parsePanelWidths(null);
  fallback.left = 300;
  expect(DEFAULT_PANEL_WIDTHS.left).toBe(240);
});

it("keeps space for the canvas across desktop widths without changing saved preferences", () => {
  for (const viewport of [1100, 1280, 1440, 1600]) {
    const left = panelWidthMaximum("left", viewport),
      right = panelWidthMaximum("right", viewport);
    expect(left).toBeGreaterThanOrEqual(200);
    expect(left).toBeLessThanOrEqual(400);
    expect(right).toBeGreaterThanOrEqual(240);
    expect(right).toBeLessThanOrEqual(440);
    expect(viewport - left - right).toBeGreaterThanOrEqual(320);
  }
});
