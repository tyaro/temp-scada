import { describe, expect, it } from "vitest";
import sample from "../../../../examples/alarm-value-color.project.json";
import { parseProject, serializeProject } from "./project";
import {
  ALARM_OUTLINE_COLOR,
  ALARM_VALUE_COLORS,
  alarmColorOn,
  alarmOutlineWidth,
  alarmReservedMetrics,
  alarmTextPaint,
  alarmUnderlineBox,
  type AlarmPaintKey,
} from "./alarm-value-paint";
import { contrastRatio, relativeLuminance } from "./canvas-colors";

// 仕様: docs/design/graphics/alarm-value-color.md「見た目」
const KEYS: AlarmPaintKey[] = ["high", "medium", "low", "unknown"];

describe("contrast ratio", () => {
  it("follows WCAG 2 relative luminance", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 10);
    expect(relativeLuminance("#fff")).toBeCloseTo(1, 10);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 10);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 10);
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
    expect(contrastRatio("#123456", "#123456")).toBe(1);
  });
});

describe("alarm value colors", () => {
  it("maps each meaning to the fixed light and dark pair", () => {
    expect(ALARM_VALUE_COLORS).toEqual({
      high: { light: "#dc2626", dark: "#f87171" },
      medium: { light: "#c2410c", dark: "#fb923c" },
      low: { light: "#a16207", dark: "#facc15" },
      unknown: { light: "#6b7280", dark: "#9ca3af" },
    });
  });

  it("reads at 4.5 or more on white and on the default dark background", () => {
    for (const key of KEYS) {
      const white = alarmColorOn(key, "#ffffff");
      expect(white).toEqual({
        color: ALARM_VALUE_COLORS[key].light,
        outline: false,
      });
      expect(contrastRatio(white.color, "#ffffff")).toBeGreaterThanOrEqual(4.5);
      const dark = alarmColorOn(key, "#0b1220");
      expect(dark).toEqual({
        color: ALARM_VALUE_COLORS[key].dark,
        outline: false,
      });
      expect(contrastRatio(dark.color, "#0b1220")).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("outlines the dark color in black on a middle gray, reading at 7.59 or more", () => {
    for (const key of KEYS) {
      const gray = alarmColorOn(key, "#969696");
      expect(gray).toEqual({
        color: ALARM_VALUE_COLORS[key].dark,
        outline: true,
      });
      expect(
        contrastRatio(gray.color, ALARM_OUTLINE_COLOR),
      ).toBeGreaterThanOrEqual(7.59);
    }
  });

  // 灰の背景で、選んだ組の比が 4.5 をまたぐ境目の両側（色ごとに違う）。
  const edges: Record<AlarmPaintKey, [string, string, string, string]> = {
    high: ["#343434", "#353535", "#f6f6f6", "#f7f7f7"],
    medium: ["#414141", "#424242", "#eeeeee", "#efefef"],
    low: ["#5a5a5a", "#5b5b5b", "#f4f4f4", "#f5f5f5"],
    unknown: ["#393939", "#3a3a3a", "#f6f6f6", "#f7f7f7"],
  };
  it("switches the outline on and off on both sides of 4.5", () => {
    for (const key of KEYS) {
      const { light, dark } = ALARM_VALUE_COLORS[key];
      const [darkSide, darkEdge, lightEdge, lightSide] = edges[key];
      expect(alarmColorOn(key, darkSide)).toEqual({
        color: dark,
        outline: false,
      });
      expect(contrastRatio(dark, darkSide)).toBeGreaterThanOrEqual(4.5);
      expect(alarmColorOn(key, darkEdge)).toEqual({
        color: dark,
        outline: true,
      });
      expect(contrastRatio(dark, darkEdge)).toBeLessThan(4.5);
      expect(alarmColorOn(key, lightEdge)).toEqual({
        color: dark,
        outline: true,
      });
      expect(contrastRatio(light, lightEdge)).toBeLessThan(4.5);
      expect(alarmColorOn(key, lightSide)).toEqual({
        color: light,
        outline: false,
      });
      expect(contrastRatio(light, lightSide)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("chooses the pair per color, not once for the whole Text", () => {
    // #5a5a5a: low は暗い組で縁取り無し、high は縁取りが要る。
    expect(alarmColorOn("low", "#5a5a5a").outline).toBe(false);
    expect(alarmColorOn("high", "#5a5a5a").outline).toBe(true);
    const paint = alarmTextPaint(
      {
        tone: "severity",
        severity: "high",
        underline: "low",
        blink: false,
        title: "警報 T: x",
      },
      "#5a5a5a",
    );
    expect(paint.text).toEqual({ color: "#f87171", outline: true });
    expect(paint.underline).toEqual({
      color: "#facc15",
      outline: false,
      severity: "low",
    });
  });

  it("keeps the placement fill for normal, and the gray for unknown", () => {
    expect(
      alarmTextPaint(
        { tone: "normal", underline: "high", blink: true, title: "t" },
        "#ffffff",
      ),
    ).toEqual({
      tone: "normal",
      underline: { color: "#dc2626", outline: false, severity: "high" },
      blink: true,
      title: "t",
    });
    expect(
      alarmTextPaint({ tone: "unknown", blink: false, title: "t" }, "#0b1220"),
    ).toEqual({
      tone: "unknown",
      text: { color: "#9ca3af", outline: false },
      blink: false,
      title: "t",
    });
    // severity が表示情報に無いときは high。
    expect(
      alarmTextPaint({ tone: "severity", blink: false, title: "t" }, "#ffffff")
        .tone,
    ).toBe("high");
  });
});

describe("outline and underline geometry", () => {
  it("uses max(1, fontSize × 0.12) for the outline", () => {
    expect(alarmOutlineWidth(5)).toBe(1);
    expect(alarmOutlineWidth(20)).toBeCloseTo(2.4, 10);
  });

  it("draws the underline below the baseline within the Text frame", () => {
    const layout = { baseline: 20, left: 1, inkWidth: 40 };
    expect(alarmUnderlineBox(layout, 10, 20, 40, 0)).toEqual({
      x: 11,
      y: 23 - 0.8,
      width: 40,
      height: 1.6,
    });
    // 枠がきついときは、縁取りを含めて枠の内側へ上げる。
    const tight = alarmUnderlineBox(layout, 10, 20, 22, 2.4);
    expect(tight.y + tight.height + 1.2).toBeCloseTo(22, 10);
    // 太さは 1 を下回らない。
    expect(alarmUnderlineBox(layout, 0, 8, 40, 0).height).toBe(1);
  });

  it("reserves the outline and the underline in the measured box", () => {
    // 64px: 縁は外側に 3.84、下線の下端は縁を含めて baseline から 64 × 0.15 + 2.56 + 3.84 = 16。
    // 左右だけを縁の分広げ、上は広げない（フォントの箱の上に余白がある）。
    const box = { x: 1, y: -60, width: 100, height: 80 };
    const reserved = alarmReservedMetrics(box, 64);
    expect(reserved.x).toBeCloseTo(1 - 3.84, 10);
    expect(reserved.y).toBe(-60);
    expect(reserved.width).toBeCloseTo(100 + 7.68, 10);
    expect(reserved.height).toBe(80);
    // 文字の箱が下線より上で終わるときは、下線の下端まで広げる。
    const short = alarmReservedMetrics(
      { x: 0, y: -50, width: 10, height: 50 },
      64,
    );
    expect(short.y + short.height).toBeCloseTo(16, 10);
    // 広げた分（bleed）を戻すと、下線は文字の墨の幅に戻る。
    const line = alarmUnderlineBox(
      { baseline: 70, left: reserved.x, inkWidth: reserved.width },
      2,
      64,
      200,
      7.68,
      3.84,
    );
    expect(line.x).toBeCloseTo(2 + 1, 10);
    expect(line.width).toBeCloseTo(100, 10);
  });
});

describe("sample project", () => {
  it("loads, round-trips and points each value at a defined alarm", () => {
    const project = parseProject(JSON.stringify(sample));
    expect(parseProject(serializeProject(project))).toEqual(project);
    const ids = new Set(project.alarms?.definitions.map((item) => item.id));
    const kinds = new Set(
      project.alarms?.definitions.map((item) => item.source.kind),
    );
    expect(kinds).toEqual(new Set(["threshold", "bit"]));
    const backgrounds = project.screens.map((screen) => screen.background);
    expect(backgrounds).toEqual(["#ffffff", "#0b1220"]);
    for (const screen of project.screens) {
      const values = screen.objects.filter(
        (object) => object.shape.type === "text" && object.shape.alarmColor,
      );
      expect(values.length).toBeGreaterThan(0);
      for (const object of values)
        if (object.shape.type === "text")
          expect(ids.has(object.shape.alarmColor!.alarmId)).toBe(true);
    }
    expect(
      project.screens[0].objects.some(
        (object) =>
          object.shape.type === "screenView" &&
          object.shape.screenId === project.screens[1].id,
      ),
    ).toBe(true);
  });
});
