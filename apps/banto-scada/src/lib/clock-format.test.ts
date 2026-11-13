import { describe, expect, it } from "vitest";
import sample from "../../../../examples/read-presentation.project.json";
import cases from "../../../../examples/clock-cases.json";
import { formatClock } from "./clock-format";
import { parseProject, serializeProject, type ClockShape } from "./project";
import { applyCommand } from "./editor";
import { objectFormCommand } from "./designer/forms/object-form";
import { objectFormValues } from "./designer/numeric-properties";
import { canFlip } from "./flip";
import { shapeSlotNames, shapeTagBindings } from "./shape-bindings";

it.each(cases)("clock contract: $name", ({ target, valid, object }) => {
  const value = structuredClone(sample),
    node = target
      .split("/")
      .slice(1)
      .reduce((node, key) => node[key], value as any);
  node.push(object);
  if (valid)
    expect(
      parseProject(serializeProject(parseProject(JSON.stringify(value)))),
    ).toEqual(value);
  else expect(() => parseProject(JSON.stringify(value))).toThrow();
});

describe("formatClock", () => {
  // ローカル時刻の Date で組み立てるので、TZ に依存しない。
  const at = new Date(2026, 0, 5, 3, 4, 9);
  it("zero-pads the date as YYYY/MM/DD", () => {
    expect(formatClock({ format: "date" }, at)).toBe("2026/01/05");
    expect(formatClock({ format: "date", seconds: true }, at)).toBe(
      "2026/01/05",
    );
    expect(formatClock({ format: "date" }, new Date(2026, 11, 31))).toBe(
      "2026/12/31",
    );
  });
  it("shows the time in 24 hours, with seconds only when asked", () => {
    expect(formatClock({ format: "time" }, at)).toBe("03:04");
    expect(formatClock({ format: "time", seconds: true }, at)).toBe("03:04:09");
    expect(
      formatClock({ format: "time" }, new Date(2026, 5, 1, 23, 59, 59)),
    ).toBe("23:59");
    expect(formatClock({ format: "time" }, new Date(2026, 5, 1, 0, 0, 0))).toBe(
      "00:00",
    );
  });
  it("joins the date and the time with a space", () => {
    expect(formatClock({ format: "dateTime" }, at)).toBe("2026/01/05 03:04");
    expect(formatClock({ format: "dateTime", seconds: true }, at)).toBe(
      "2026/01/05 03:04:09",
    );
  });
  it("accepts epoch milliseconds in the local time zone", () => {
    expect(
      formatClock({ format: "dateTime", seconds: true }, at.getTime()),
    ).toBe("2026/01/05 03:04:09");
  });
  it("shows nothing for an invalid date", () => {
    expect(formatClock({ format: "date" }, new Date(NaN))).toBe("");
  });
});

describe("clock editing", () => {
  const project = () => parseProject(JSON.stringify(sample));
  function added() {
    const next = applyCommand(
      project(),
      { type: "add", screenId: sample.screens[0].id, kind: "clock" },
      "edit",
    );
    return { next, object: next.screens[0].objects.at(-1)! };
  }
  it("adds a date-and-time clock that cannot flip and reads no tag", () => {
    const { next, object } = added();
    expect(object.shape).toMatchObject({
      type: "clock",
      format: "dateTime",
    });
    expect("seconds" in object.shape).toBe(false);
    expect(parseProject(serializeProject(next))).toEqual(next);
    expect(canFlip(object)).toBe(false);
    expect(shapeTagBindings(object.shape)).toEqual([]);
    expect(shapeSlotNames(object.shape)).toEqual([]);
  });
  it("applies the Inspector form and stores seconds only when on", () => {
    const { next, object } = added();
    const data = new Map(Object.entries(objectFormValues(object, false)));
    expect(data.get("clockFormat")).toBe("dateTime");
    expect(data.get("clockSeconds")).toBe("off");
    data.set("clockFormat", "time");
    data.set("clockSeconds", "on");
    data.set("clockFontSize", "24");
    data.set("clockFontWeight", "bold");
    data.set("clockAlign", "right");
    const run = (selected: typeof object, project = next) =>
      applyCommand(
        project,
        objectFormCommand(
          { get: (key) => data.get(key) ?? null, has: (key) => data.has(key) },
          { screenId: project.screens[0].id, definition: false, selected },
        ),
        "edit",
      );
    const after = run(object);
    const shape = after.screens[0].objects.find((o) => o.id === object.id)!
      .shape as ClockShape;
    expect(shape).toEqual({
      type: "clock",
      format: "time",
      seconds: true,
      style: { fontSize: 24, fontWeight: "bold", align: "right" },
    });
    data.set("clockSeconds", "off");
    const again = run(
      after.screens[0].objects.find((o) => o.id === object.id)!,
      after,
    );
    expect(
      "seconds" in
        again.screens[0].objects.find((o) => o.id === object.id)!.shape,
    ).toBe(false);
  });
  it("rejects a bad form value", () => {
    const { next, object } = added();
    const data = new Map(Object.entries(objectFormValues(object, false)));
    data.set("clockFontSize", "0");
    expect(() =>
      objectFormCommand(
        { get: (key) => data.get(key) ?? null, has: (key) => data.has(key) },
        { screenId: next.screens[0].id, definition: false, selected: object },
      ),
    ).toThrow();
  });
});
