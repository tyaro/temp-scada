import { expect, it } from "vitest";
import { render } from "svelte/server";
import Primitive from "./Primitive.svelte";
import type { LayoutObject } from "./project";
import type { NumericReading } from "./tag-presentation";
const object: LayoutObject = {
  rotation: 0,
  id: "test",
  order: 1,
  x: 0,
  y: 0,
  width: 300,
  height: 30,
  fill: "#ffffff",
  shape: {
    type: "text",
    style: { fontSize: 21, fontWeight: "normal", align: "left" },
    text: "STATIC FALLBACK",
    binding: { externalName: "PLC01.Fast.Value" },
  },
};
it("renders current and degraded readings through the same SVG primitive without leaking static fallback", () => {
  const cases: [NumericReading | undefined, string, string][] = [
    [undefined, "disconnected", "-- · 未接続"],
    [
      { state: "resolved", quality: "good", numericValue: 0 },
      "good",
      "0</title>",
    ],
    [
      { state: "resolved", quality: "stale", numericValue: 123.45 },
      "stale",
      "-- · Stale",
    ],
    [
      { state: "resolved", quality: "bad", numericValue: 123.45 },
      "bad",
      "-- · Bad",
    ],
    [{ state: "unresolved" }, "unresolved", "-- · 未解決"],
    [
      { state: "resolved", quality: "good", numericValue: null },
      "invalid",
      "-- · 値が不正",
    ],
  ];
  for (const [reading, state, text] of cases) {
    const { body } = render(Primitive, {
      props: {
        object,
        readings: reading
          ? new Map([["PLC01.Fast.Value", reading]])
          : undefined,
      },
    });
    expect(body).toContain(`data-tag-state="${state}"`);
    expect(body).toContain('data-text-layout="pending"');
    expect(body).not.toContain("data-text-content");
    expect(body.replaceAll(/<!--.*?-->/g, "")).toContain(text);
    expect(body).not.toContain("STATIC FALLBACK");
    expect(body).not.toContain("123.45");
  }
});
it("escapes the external name as text and preserves unbound static rendering", () => {
  const escaped = {
    ...object,
    shape: {
      type: "text" as const,
      style: {
        fontSize: 21,
        fontWeight: "normal" as const,
        align: "left" as const,
      },
      text: "static",
      binding: { externalName: '<script>alert("tag")</script>' },
    },
  };
  const { body } = render(Primitive, { props: { object: escaped } });
  expect(body).not.toContain("<script>");
  expect(body).toContain("&lt;script>");
  const unbound = {
    ...object,
    shape: {
      type: "text" as const,
      style: {
        fontSize: 21,
        fontWeight: "normal" as const,
        align: "left" as const,
      },
      text: "STATIC FALLBACK",
    },
  };
  const staticSvg = render(Primitive, { props: { object: unbound } }).body;
  expect(staticSvg).toContain("STATIC FALLBACK");
  expect(staticSvg).not.toContain("data-tag-state=");
});
