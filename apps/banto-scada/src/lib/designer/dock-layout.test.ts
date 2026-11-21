import { describe, expect, it } from "vitest";
import {
  designerDockLayout,
  frontLeftPanes,
  keepDesignerPaneWidths,
  withDesignerPaneWidths,
} from "./dock-layout";

describe("designerDockLayout", () => {
  it("左3つを Project が表のタブにまとめ、中央と Inspector を横に並べる", () => {
    const layout = designerDockLayout({
      hostWidth: 1200,
      leftWidth: 240,
      rightWidth: 288,
    });
    const root = layout.docked;
    expect(root?.type).toBe("split");
    if (root?.type !== "split") return;
    expect(root.direction).toBe("row");
    const [tabs, center, right] = root.children;
    expect(tabs).toMatchObject({
      type: "tabs",
      activeIndex: 0,
      children: [{ id: "left" }, { id: "layers" }, { id: "parts" }],
    });
    expect(center).toMatchObject({ type: "panel", id: "center" });
    expect(right).toMatchObject({ type: "panel", id: "right" });
    expect(root.sizes[0]).toBeCloseTo(240 / 1200);
    expect(root.sizes[2]).toBeCloseTo(288 / 1200);
    expect(layout.floating).toEqual([]);
    expect(frontLeftPanes(layout)).toEqual(["project"]);
  });

  it("幅を標準に戻すときは配置を変えず、左右の区画の比率だけを直す", () => {
    const layout = designerDockLayout({
      hostWidth: 1200,
      leftWidth: 400,
      rightWidth: 400,
    });
    const reset = withDesignerPaneWidths(layout, {
      hostWidth: 1200,
      leftWidth: 240,
      rightWidth: 288,
    });
    const root = reset.docked;
    if (root?.type !== "split") throw new Error("split expected");
    expect(root.children).toEqual((layout.docked as typeof root).children);
    expect(root.sizes[0]).toBeCloseTo(240 / 1200);
    expect(root.sizes[2]).toBeCloseTo(288 / 1200);
    expect(root.sizes.reduce((sum, size) => sum + size, 0)).toBeCloseTo(1);
  });

  it("表のタブが変わると表に出ている左のパネルも変わる", () => {
    const layout = designerDockLayout({
      hostWidth: 1200,
      leftWidth: 240,
      rightWidth: 288,
    });
    const root = layout.docked;
    if (root?.type !== "split" || root.children[0].type !== "tabs")
      throw new Error("tabs expected");
    const tabs = { ...root.children[0], activeIndex: 2 };
    const next = {
      ...layout,
      docked: { ...root, children: [tabs, ...root.children.slice(1)] },
    };
    expect(frontLeftPanes(next)).toEqual(["parts"]);
  });

  it("窓の幅が変わっても左右の px を保ち、中央が 320px を切るなら左右を縮める", () => {
    const layout = designerDockLayout({
      hostWidth: 1920,
      leftWidth: 240,
      rightWidth: 288,
    });
    const sizes = (width: number) => {
      const root = keepDesignerPaneWidths(layout, 1920, width).docked;
      if (root?.type !== "split") throw new Error("split expected");
      return root.sizes.map((size) => size * width);
    };
    const [left, center, right] = sizes(1280);
    expect(left).toBeCloseTo(240);
    expect(right).toBeCloseTo(288);
    expect(center).toBeCloseTo(1280 - 240 - 288);
    const narrow = sizes(700);
    expect(narrow[1]).toBeCloseTo(320);
    expect(narrow[0] / narrow[2]).toBeCloseTo(240 / 288);
    expect(keepDesignerPaneWidths(layout, 1920, 1920)).toBe(layout);
  });
});
