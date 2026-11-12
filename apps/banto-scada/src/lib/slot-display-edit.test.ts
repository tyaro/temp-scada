import { it, expect } from "vitest";
import sample from "../../../../examples/symbol-slots.project.json";
import type { EquipmentSlot, SlotStateDisplay } from "./equipment";
import {
  addStateRow,
  emptyStateDisplay,
  exampleStateDisplay,
  moveStateRow,
  nextMatch,
  slotDisplayError,
  stateRowProblem,
} from "./slot-display-edit";
import { equipmentTypeFormCommand } from "./designer/forms/equipment-type";
import { parseProject, serializeProject } from "./project";

const label = { text: "", color: "#64748b" };
function display(
  source: SlotStateDisplay["source"],
  matches: number[],
): SlotStateDisplay {
  return {
    source,
    rows: matches.map((match) => ({ match, ...label })),
    otherwise: label,
  };
}

it("suggests the next value or the lowest unused bit for a new row", () => {
  expect(nextMatch(display("value", []))).toBe(0);
  expect(nextMatch(display("value", [3, 1]))).toBe(4);
  expect(nextMatch(display("bits", [0, 2]))).toBe(1);
  const full = Array.from({ length: 32 }, (_, bit) => bit);
  expect(nextMatch(display("bits", full))).toBeUndefined();
  expect(addStateRow(display("bits", full)).rows).toHaveLength(32);
  const added = addStateRow(display("value", [5]));
  expect(added.rows.map((row) => row.match)).toEqual([5, 6]);
  expect(added.rows[1].color).toMatch(/^#[0-9a-f]{6}$/);
});

it("moves rows to change priority and keeps the ends in place", () => {
  const base = display("bits", [0, 1, 2]);
  expect(moveStateRow(base, 2, -1).rows.map((row) => row.match)).toEqual([
    0, 2, 1,
  ]);
  expect(moveStateRow(base, 0, -1)).toBe(base);
  expect(moveStateRow(base, 2, 1)).toBe(base);
});

it("names the problem of a row in the words shown next to it", () => {
  expect(stateRowProblem(display("value", [1, 1]), 0)).toBeUndefined();
  expect(stateRowProblem(display("value", [1, 1]), 1)).toBe(
    "同じ値の行が上にあります",
  );
  expect(stateRowProblem(display("bits", [32]), 0)).toBe("ビットは0〜31です");
  expect(stateRowProblem(display("bits", [Number.NaN]), 0)).toBe(
    "ビットは0〜31の整数で入れてください",
  );
  expect(stateRowProblem(display("value", [1.5]), 0)).toBe(
    "値は整数で入れてください",
  );
  expect(stateRowProblem(display("value", [-2147483649]), 0)).toMatch(/^値は/);
  const long = display("value", [0]);
  long.rows[0].text = "a".repeat(65);
  expect(stateRowProblem(long, 0)).toBe("文字は64文字以内にしてください");
  long.rows[0].text = "a\nb";
  expect(stateRowProblem(long, 0)).toBe("文字に改行は入れられません");
});

it("the examples and an empty definition pass the project schema", () => {
  const project = parseProject(JSON.stringify(sample));
  const slots: EquipmentSlot[] = [
    {
      name: "word",
      type: "state",
      direction: "read",
      stateDisplay: exampleStateDisplay("value"),
    },
    {
      name: "bits",
      type: "state",
      direction: "read",
      allowUnassigned: true,
      stateDisplay: exampleStateDisplay("bits"),
    },
    {
      name: "empty",
      type: "state",
      direction: "read",
      stateDisplay: emptyStateDisplay(),
    },
  ];
  for (const slot of slots) expect(slotDisplayError(slot)).toBeUndefined();
  project.equipmentTypes!.push({ id: "0190a4a4-0000-7000-8000-000000000a04", name: "A4", slots });
  expect(() => parseProject(serializeProject(project))).not.toThrow();
});

it("the form refuses a broken row with where it is before applying", () => {
  const project = parseProject(JSON.stringify(sample));
  const data = new FormData();
  data.set("name", "モータ");
  const rows = display("bits", [0, 0]);
  data.set(
    "slots",
    JSON.stringify([
      { name: "status", type: "state", direction: "read", stateDisplay: rows },
    ]),
  );
  const source = {
    connected: true,
    targetKey: `1:${project.manifest.projectId}:new`,
    data,
  };
  expect(() => equipmentTypeFormCommand(source, project, 1)).toThrow(
    "statusの行2: 同じビットの行が上にあります",
  );
  data.set(
    "slots",
    JSON.stringify([
      {
        name: "run",
        type: "bool",
        direction: "read",
        boolDisplay: { true: { text: "運転", color: "red" }, false: label },
      },
    ]),
  );
  expect(() => equipmentTypeFormCommand(source, project, 1)).toThrow(
    "runのtrue: 色は#rrggbbで指定してください",
  );
});
