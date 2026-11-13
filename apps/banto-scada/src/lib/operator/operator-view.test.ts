import { describe, expect, it } from "vitest";
import {
  OPERATOR_HISTORY_LIMIT,
  canGoBack,
  canGoForward,
  currentScreen,
  goBack,
  goForward,
  pushScreen,
  startHistory,
} from "./operator-history";
import { operatorLayout, operatorStartScreen } from "./operator-layout";

describe("operator history", () => {
  it("pushes screens and moves back and forward", () => {
    let history = startHistory("a");
    expect(canGoBack(history)).toBe(false);
    expect(canGoForward(history)).toBe(false);
    history = pushScreen(history, "b");
    history = pushScreen(history, "c");
    expect(currentScreen(history)).toBe("c");
    history = goBack(goBack(history));
    expect(currentScreen(history)).toBe("a");
    expect(canGoBack(history)).toBe(false);
    expect(goBack(history)).toBe(history);
    history = goForward(history);
    expect(currentScreen(history)).toBe("b");
    expect(canGoForward(history)).toBe(true);
  });
  it("drops the forward entries on a new screen", () => {
    let history = pushScreen(pushScreen(startHistory("a"), "b"), "c");
    history = pushScreen(goBack(goBack(history)), "d");
    expect(history.entries).toEqual(["a", "d"]);
    expect(canGoForward(history)).toBe(false);
    expect(goForward(history)).toBe(history);
  });
  it("ignores the current screen", () => {
    const history = startHistory("a");
    expect(pushScreen(history, "a")).toBe(history);
  });
  it("keeps the newest 50 entries", () => {
    let history = startHistory("s0");
    for (let i = 1; i <= 60; i++) history = pushScreen(history, `s${i}`);
    expect(history.entries).toHaveLength(OPERATOR_HISTORY_LIMIT);
    expect(history.entries[0]).toBe("s11");
    expect(currentScreen(history)).toBe("s60");
    for (let i = 0; i < 100; i++) history = goBack(history);
    expect(currentScreen(history)).toBe("s11");
  });
});

describe("operator layout", () => {
  it("scales the header and footer to the main width and fits the window", () => {
    const layout = operatorLayout(
      { width: 1000, height: 1000 },
      { width: 960, height: 540 },
      { width: 1920, height: 120 },
      { width: 480, height: 30 },
    );
    // ヘッダー 60・主画面 540・フッター 60 → 960×660。窓の幅で決まる。
    expect(layout.scale).toBeCloseTo(1000 / 960);
    expect(layout.frame.width).toBeCloseTo(1000);
    expect(layout.frame.height).toBeCloseTo(660 * (1000 / 960));
    expect(layout.frame.x).toBe(0);
    expect(layout.frame.y).toBeCloseTo((1000 - 660 * (1000 / 960)) / 2);
    expect(layout.header!.height).toBeCloseTo(60 * (1000 / 960));
    expect(layout.main.y).toBeCloseTo(60 * (1000 / 960));
    expect(layout.main.height).toBeCloseTo(540 * (1000 / 960));
    expect(layout.footer!.y).toBeCloseTo(600 * (1000 / 960));
    expect(layout.footer!.height).toBeCloseTo(60 * (1000 / 960));
  });
  it("fits by height and centers horizontally", () => {
    const layout = operatorLayout(
      { width: 2000, height: 660 },
      { width: 960, height: 540 },
      { width: 960, height: 60 },
      { width: 960, height: 60 },
    );
    expect(layout.scale).toBeCloseTo(1);
    expect(layout.frame).toEqual({ x: 520, y: 0, width: 960, height: 660 });
  });
  it("shows only the main screen without a frame", () => {
    const layout = operatorLayout(
      { width: 480, height: 540 },
      { width: 960, height: 540 },
    );
    expect(layout.header).toBeUndefined();
    expect(layout.footer).toBeUndefined();
    expect(layout.scale).toBeCloseTo(0.5);
    expect(layout.main).toEqual({ x: 0, y: 0, width: 480, height: 270 });
    expect(layout.frame.y).toBeCloseTo(135);
  });
  it("uses zero scale for an empty window", () => {
    expect(
      operatorLayout({ width: 0, height: 0 }, { width: 960, height: 540 })
        .scale,
    ).toBe(0);
  });
});

describe("operator start screen", () => {
  const screens = [{ id: "main" }, { id: "sub" }, { id: "head" }];
  it("prefers the frame start screen", () => {
    expect(operatorStartScreen({ startScreenId: "sub" }, screens, "main")).toBe(
      "sub",
    );
  });
  it("falls back to the Designer screen", () => {
    expect(operatorStartScreen(undefined, screens, "sub")).toBe("sub");
  });
  it("does not start on a header or footer screen", () => {
    expect(
      operatorStartScreen({ headerScreenId: "head" }, screens, "head"),
    ).toBe("main");
  });
  it("does not open when only frame screens exist", () => {
    expect(
      operatorStartScreen(
        { headerScreenId: "head", footerScreenId: "foot" },
        [{ id: "head" }, { id: "foot" }],
        "head",
      ),
    ).toBeUndefined();
  });
});
