import { describe, expect, it } from "vitest";
import equipmentSample from "../../../../examples/equipment.project.json";
import { parseProject } from "./project";
import { cellKey } from "./equipment-binding-table";
import {
  decodeIoCsv,
  guessIoCsvColumns,
  importIoCsv,
  parseIoCsv,
} from "./equipment-io-csv";

const FAN = "0199f700-0000-7000-8000-000000000002";
const FAN2 = "0199f700-0000-7000-8000-0000000000f2";
function project() {
  const result = parseProject(JSON.stringify(equipmentSample));
  result.equipment!.push({
    id: FAN2,
    typeId: result.equipment![0].typeId,
    code: "FAN-102",
    name: "2号送風機",
    bindings: [{ slotName: "current", externalName: "old.current" }],
  });
  return result;
}
const columns = { code: 0, slot: 1, tag: 2 };
const records = (text: string) => parseIoCsv(text).slice(1);

describe("decodeIoCsv", () => {
  it("reads UTF-8 with or without a BOM", () => {
    const bytes = new TextEncoder().encode("﻿機器番号,slot\r\n");
    expect(decodeIoCsv(bytes)).toEqual({
      text: "機器番号,slot\r\n",
      encoding: "UTF-8",
    });
  });
  it("falls back to Shift_JIS for bytes that are not UTF-8", () => {
    // "機器" in Shift_JIS
    const bytes = new Uint8Array([0x8b, 0x40, 0x8a, 0xed]);
    expect(decodeIoCsv(bytes)).toEqual({ text: "機器", encoding: "Shift_JIS" });
  });
});

describe("parseIoCsv", () => {
  it("handles quotes, escaped quotes, newlines in fields and line ends", () => {
    expect(parseIoCsv('a,"b,1","c ""q"""\r\n"x\ny",,z\n\n,,\rlast')).toEqual([
      { line: 1, fields: ["a", "b,1", 'c "q"'] },
      { line: 2, fields: ["x\ny", "", "z"] },
      { line: 6, fields: ["last"] },
    ]);
  });
  it("keeps a trailing empty field and ignores a final line end", () => {
    expect(parseIoCsv("a,\n")).toEqual([{ line: 1, fields: ["a", ""] }]);
  });
  it("rejects text after a closing quote", () => {
    expect(() => parseIoCsv('a\n"Tag"extra,b')).toThrow("2行目の閉じた引用符");
    expect(() => parseIoCsv('"a" ,b')).toThrow("1行目");
    expect(parseIoCsv('"a",""\r\n"b"')).toEqual([
      { line: 1, fields: ["a", ""] },
      { line: 2, fields: ["b"] },
    ]);
  });
  it("rejects a quote inside an unquoted field", () => {
    expect(() => parseIoCsv('a,b\nFAN-101,PLC"Run')).toThrow(
      "2行目の欄の途中に引用符",
    );
  });
  it("stops once the data records exceed the limit", () => {
    expect(parseIoCsv("h\n1\n2\n\n", 2)).toHaveLength(3);
    expect(() => parseIoCsv("h\n1\n2\n3", 2)).toThrow("見出しを除いて2行まで");
  });
  it("rejects an unterminated quote", () => {
    expect(() => parseIoCsv('a\n"b,c')).toThrow("2行目");
  });
});

describe("guessIoCsvColumns", () => {
  it("finds the columns by header name", () => {
    expect(
      guessIoCsvColumns(["アドレス", " 機器番号 ", "信号", "Tag", "備考"]),
    ).toEqual({ code: 1, slot: 2, tag: 3 });
  });
  it("leaves unknown roles out", () => {
    expect(guessIoCsvColumns(["a", "slot"])).toEqual({ slot: 1 });
  });
});

describe("importIoCsv", () => {
  it("drafts one cell per signal across equipment, keeping the name as is", () => {
    const result = importIoCsv(
      project(),
      records(
        "code,slot,tag\n FAN-101 ,running, PLC.Fan.Run \nFAN-102,current,PLC.Fan2.Current\n",
      ),
      columns,
    );
    expect([...result.cells]).toEqual([
      [
        cellKey(FAN, "running"),
        { text: " PLC.Fan.Run ", saved: { externalName: null } },
      ],
      [
        cellKey(FAN2, "current"),
        { text: "PLC.Fan2.Current", saved: { externalName: "old.current" } },
      ],
    ]);
    expect([...result.typeIds]).toHaveLength(1);
    expect(result.skipped).toEqual([]);
  });
  it("reports rows it cannot place, with their line numbers", () => {
    const long = "x".repeat(513);
    const result = importIoCsv(
      project(),
      records(
        [
          "code,slot,tag",
          ",running,A",
          "NONE,running,A",
          "FAN-101,,A",
          "FAN-101,speed,A",
          "FAN-101,current,  ",
          `FAN-101,current,${long}`,
          "FAN-101,running,A",
        ].join("\n"),
      ),
      columns,
    );
    expect(result.skipped.map((row) => [row.line, row.reason])).toEqual([
      [2, "機器番号が空です"],
      [3, "機器番号が見つかりません"],
      [4, "slotが空です"],
      [5, "機器種別にないslotです"],
      [6, "タグ名が空です"],
      [7, "タグ名が512文字を超えています"],
    ]);
    expect(result.cells.size).toBe(1);
  });
  it("accepts a repeated same name but skips a cell named differently twice", () => {
    const result = importIoCsv(
      project(),
      records(
        "code,slot,tag\nFAN-101,running,A\nFAN-101,running,A\nFAN-102,running,B\nFAN-102,running,C\n",
      ),
      columns,
    );
    expect([...result.cells.keys()]).toEqual([cellKey(FAN, "running")]);
    expect(
      result.skipped.map((row) => [row.line, row.tag, row.reason]),
    ).toEqual([
      [4, "B", "同じslotに別のタグ名があります"],
      [5, "C", "同じslotに別のタグ名があります"],
    ]);
  });
  it("reads a missing field of a short record as empty", () => {
    const result = importIoCsv(
      project(),
      records("code,slot,tag\nFAN-101,running\n"),
      columns,
    );
    expect(result.skipped[0].reason).toBe("タグ名が空です");
  });
});
