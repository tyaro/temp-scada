import { expect, it } from "vitest";
import { patternFromForm } from "./pattern-fields";
function fields() {
  const data = new FormData();
  for (const [key, value] of Object.entries({
    patternKind: "crosshatch",
    patternSpacing: "12",
    patternSize: "2",
    patternAngle: "405",
    patternForegroundColor: "#22aa66",
    patternForegroundAlpha: "50",
    patternBackgroundEnabled: "false",
    patternBackgroundColor: "#ffffff",
    patternBackgroundAlpha: "25",
  }))
    data.set(key, value);
  return data;
}
it("parses decimal fields and normalizes angle while explicitly clearing transparent backgrounds", () => {
  const data = fields();
  data.set("patternBackgroundAlpha", "invalid");
  expect(patternFromForm(data)).toEqual({
    type: "pattern",
    kind: "crosshatch",
    spacing: 12,
    size: 2,
    angle: 45,
    foreground: { color: "#22aa66", alpha: 0.5 },
    background: null,
  });
  data.set("patternBackgroundEnabled", "true");
  expect(() => patternFromForm(data)).toThrow();
  data.set("patternBackgroundAlpha", "25");
  expect(patternFromForm(data).background).toEqual({
    color: "#ffffff",
    alpha: 0.25,
  });
});
it("rejects malformed or out-of-range drafts without partially accepting the foreground", () => {
  for (const [key, value] of [
    ["patternSpacing", "0x10"],
    ["patternSize", "6.1"],
    ["patternAngle", "1e309"],
    ["patternForegroundAlpha", "101"],
    ["patternBackgroundEnabled", ""],
    ["patternForegroundColor", "#abc"],
  ]) {
    const data = fields();
    data.set(key, value);
    expect(() => patternFromForm(data)).toThrow();
  }
});
