import { describe, expect, it } from "vitest";
import { windowTitle } from "./window-title";

describe("windowTitle", () => {
  it("puts the project name before the application name", () => {
    expect(windowTitle("第1工場")).toBe("第1工場 - Banto SCADA");
  });

  it("falls back to the application name for a blank project name", () => {
    expect(windowTitle("")).toBe("Banto SCADA");
    expect(windowTitle("   ")).toBe("Banto SCADA");
  });
});
