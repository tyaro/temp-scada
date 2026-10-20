import { expect, it } from "vitest";
import {
  parseFloatingPanelPlacement,
  initialFloatingPanelPlacement,
  visibleFloatingPanelRect,
} from "./floating-panel-layout";
import { createFloatingPanelWorkspace } from "./controllers/floating-panel.svelte";
it("separates sidebar and Inspector persistence identities while clamping display only", () => {
  const area = { width: 1920, height: 1080, top: 108 };
  for (const panelId of ["sidebar", "inspector"] as const) {
    const saved = {
      ...initialFloatingPanelPlacement(area, panelId),
      mode: "floating" as const,
    };
    expect(parseFloatingPanelPlacement(JSON.stringify(saved), panelId)).toEqual(
      saved,
    );
    expect(
      parseFloatingPanelPlacement(
        JSON.stringify(saved),
        panelId === "sidebar" ? "inspector" : "sidebar",
      ),
    ).toBeNull();
    const before = structuredClone(saved);
    expect(
      visibleFloatingPanelRect(saved.rect, {
        width: 1100,
        height: 500,
        top: 108,
      }),
    ).not.toBeNull();
    expect(saved).toEqual(before);
  }
});
it("has one gesture owner and never changes its front rank on another panel's request", () => {
  const workspace = createFloatingPanelWorkspace();
  expect(workspace.claim("sidebar")).toBe(true);
  expect(workspace.gesturing).toBe(true);
  expect(workspace.claim("inspector")).toBe(false);
  workspace.raise("inspector");
  expect(workspace.rank("sidebar")).toBe(2);
  expect(workspace.rank("inspector")).toBe(1);
  workspace.release("inspector");
  expect(workspace.gesturing).toBe(true);
  workspace.release("sidebar");
  expect(workspace.gesturing).toBe(false);
  workspace.raise("inspector");
  expect(workspace.rank("inspector")).toBe(2);
  expect(workspace.claim("inspector")).toBe(true);
});
