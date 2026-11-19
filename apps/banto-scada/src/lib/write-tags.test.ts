import { expect, it } from "vitest";
import symbolSlots from "../../../../examples/symbol-slots.project.json";
import { parseProject, type Project } from "./project";
import {
  writeTagCsv,
  writeTagCsvFileName,
  writeTagList,
  writeTagText,
} from "./write-tags";

function project(): Project {
  const next = parseProject(JSON.stringify(symbolSlots));
  next.equipmentTypes = [
    {
      id: "type-pump",
      name: "ポンプ",
      slots: [
        { name: "run", type: "bool", direction: "read" },
        {
          name: "command",
          type: "bool",
          direction: "read",
          write: {
            label: "運転指令",
            buttons: [{ label: "運転", value: true }],
          },
        },
        {
          name: "speedSp",
          type: "number",
          direction: "read",
          write: { label: "=回転数", input: { min: 0, max: 60 } },
        },
      ],
    },
  ];
  const item = (
    id: string,
    code: string,
    bindings: [string, string | null][],
  ) => ({
    id,
    typeId: "type-pump",
    code,
    name: `${code}の名前`,
    bindings: bindings.map(([slotName, externalName]) => ({
      slotName,
      externalName,
    })),
  });
  next.equipment = [
    item("e1", "P-1", [
      ["run", "A.B.run1"],
      ["command", "A.B.cmd1"],
      ["speedSp", "A.B.sp"],
    ]),
    // Unadopted speedSp is not listed; an unassigned command is reported.
    item("e2", "P-2", [["command", null]]),
    item("e3", "P-3", [["speedSp", "A.B.sp"]]),
  ];
  return next;
}

it("lists assigned write slots by name, keeps every use and reports unassigned ones", () => {
  const list = writeTagList(project());
  expect(list.rows.map((row) => row.externalName)).toEqual([
    "A.B.cmd1",
    "A.B.sp",
  ]);
  expect(list.rows[1].uses.map((use) => use.equipmentCode)).toEqual([
    "P-1",
    "P-3",
  ]);
  expect(list.unassigned).toEqual([
    {
      equipmentCode: "P-2",
      equipmentName: "P-2の名前",
      slotName: "command",
      slotType: "bool",
      label: "運転指令",
    },
  ]);
  expect(writeTagText(list)).toBe("A.B.cmd1\nA.B.sp");
});

it("writes one CSV row per use and guards free text from formulas", () => {
  const { csv } = writeTagCsv(writeTagList(project()));
  expect(csv.split("\r\n")).toEqual([
    "﻿externalName,equipmentCode,equipmentName,slot,slotType,label",
    "A.B.cmd1,P-1,P-1の名前,command,bool,運転指令",
    "A.B.sp,P-1,P-1の名前,speedSp,number,'=回転数",
    "A.B.sp,P-3,P-3の名前,speedSp,number,'=回転数",
    "",
  ]);
  expect(writeTagCsvFileName("a/b")).toBe("write-tags-a_b.csv");
});

it("leaves names a spreadsheet reads as formulas out of the CSV, not the copy", () => {
  const next = project();
  next.equipment![0].bindings[1].externalName = "=1+1";
  next.equipment![2].bindings[0].externalName = "-A.B.sp";
  const list = writeTagList(next);
  const result = writeTagCsv(list);
  expect(result.rows).toBe(1);
  expect(result.formulaNames).toEqual(["=1+1", "-A.B.sp"]);
  expect(result.csv.split("\r\n").slice(1, -1)).toEqual([
    "A.B.sp,P-1,P-1の名前,speedSp,number,'=回転数",
  ]);
  expect(writeTagText(list)).toBe("=1+1\nA.B.sp\n-A.B.sp");
});
