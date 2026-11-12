import { describe, expect, it } from "vitest";
import symbolSlots from "../../../../examples/symbol-slots.project.json";
import { parseProject, type Project } from "./project";
import { catalogIndex } from "./equipment-binding-table";
import type { TagCatalog } from "./designer/tag-catalog";
import {
  HUB_TAG_CSV_COLUMNS,
  hubTagCsv,
  hubTagCsvFileName,
  serializeHubCsv,
  splitHubName,
} from "./hub-tag-csv";

const HEADER =
  "connection,group,name,address,dataType,stringLength,stringEncoding,unit,decimals,rawLo,rawHi,engLo,engHi,enabled,writable,tagKind,expression,retain,comment";
const TYPE = "type-pump";
function project(
  equipment: [string, string, [string, string | null][]][],
): Project {
  const next = parseProject(JSON.stringify(symbolSlots));
  next.equipmentTypes = [
    {
      id: TYPE,
      name: "ポンプ",
      slots: [
        { name: "run", type: "bool", direction: "read" },
        { name: "mode", type: "state", direction: "read" },
        { name: "flow", type: "number", direction: "read" },
      ],
    },
  ];
  next.equipment = equipment.map(([code, name, bindings], i) => ({
    id: `eq-${i}`,
    typeId: TYPE,
    code,
    name,
    bindings: bindings.map(([slotName, externalName]) => ({
      slotName,
      externalName,
    })),
  }));
  return next;
}
function lines(csv: string) {
  return csv.slice(1).split("\r\n");
}
const catalog = (names: string[]): TagCatalog => ({
  revision: "r",
  groups: [],
  tags: names.map((externalName, i) => ({
    id: `t${i}`,
    groupId: "g",
    name: externalName,
    externalName,
    type: "bit",
    description: "",
  })),
});

describe("hub tag csv", () => {
  it("writes the exact Hub header after a BOM with CRLF line ends", () => {
    expect(HUB_TAG_CSV_COLUMNS.join(",")).toBe(HEADER);
    const result = hubTagCsv(project([]), null);
    expect(result.csv).toBe(`\uFEFF${HEADER}\r\n`);
    expect(result.csv.charCodeAt(0)).toBe(0xfeff);
    expect(result.rows).toBe(0);
  });
  it("quotes commas, quotes and line breaks like the Hub", () => {
    expect(serializeHubCsv([["a,b", 'say "hi"', "x\ny", "plain"]])).toBe(
      '\uFEFF"a,b","say ""hi""","x\ny",plain\r\n',
    );
  });
  it("rejects names without three non-blank parts", () => {
    expect(splitHubName("PLC1.Line A.温度")).toEqual({
      parts: ["PLC1", "Line A", "温度"],
    });
    for (const name of [
      "a.b",
      "a..c",
      "a. .c",
      " a.b.c",
      "a,b.c.d",
      "a.b.c\u0007",
      `a.b.${"c".repeat(101)}`,
      'a.b.=HYPERLINK("https://example.com")',
      "+a.b.c",
      "a.-b.c",
      "a.b.@c",
    ])
      expect(splitHubName(name)).toHaveProperty("reason");
  });
  it("splits at the first two dots so only the tag part may hold dots", () => {
    expect(splitHubName("S7.Line1.Pump.A.Run")).toEqual({
      parts: ["S7", "Line1", "Pump.A.Run"],
    });
  });
  it("writes typed candidate rows in equipment and slot order", () => {
    const result = hubTagCsv(
      project([
        [
          "P-1",
          "主ポンプ",
          [
            ["flow", "PLC1.Pump1.Flow"],
            ["run", "PLC1.Pump1.Run"],
            ["mode", "PLC1.Pump1.Mode"],
          ],
        ],
        ["P-2", "予備", [["run", null]]],
      ]),
      null,
    );
    expect(result.checked).toBe(false);
    expect(result.rows).toBe(3);
    expect(lines(result.csv)).toEqual([
      HEADER,
      "PLC1,Pump1,Run,,bit,,,,,,,,,true,false,plc,,false,P-1 主ポンプ / run",
      "PLC1,Pump1,Mode,,u16,,,,,,,,,true,false,plc,,false,P-1 主ポンプ / mode",
      "PLC1,Pump1,Flow,,,,,,,,,,,true,false,plc,,false,P-1 主ポンプ / flow",
      "",
    ]);
  });
  it("leaves out names the tag list has and lists unsplittable names", () => {
    const result = hubTagCsv(
      project([
        [
          "P-1",
          "主ポンプ",
          [
            ["run", "PLC1.Pump1.Run"],
            ["mode", "PLC1.Pump1.Mode"],
            ["flow", "Pump1Flow"],
          ],
        ],
      ]),
      catalogIndex(catalog(["PLC1.Pump1.Run"])),
    );
    expect(result).toMatchObject({ rows: 1, registered: 1, checked: true });
    expect(result.invalid).toEqual([
      {
        equipmentCode: "P-1",
        slotName: "flow",
        externalName: "Pump1Flow",
        reason: expect.stringContaining("2個以上が必要"),
      },
    ]);
    expect(lines(result.csv)[1]).toMatch(/^PLC1,Pump1,Mode,/);
  });
  it("writes a shared name once and counts the other uses", () => {
    const result = hubTagCsv(
      project([
        ["P-1", "主", [["run", "PLC1.Common.Alarm"]]],
        [
          "P-2",
          "予備",
          [
            ["run", "PLC1.Common.Alarm"],
            ["flow", "PLC1.Common.Alarm"],
          ],
        ],
      ]),
      null,
    );
    expect(result.rows).toBe(1);
    // Different slot types leave the data type to the user.
    expect(lines(result.csv)[1]).toBe(
      "PLC1,Common,Alarm,,,,,,,,,,,true,false,plc,,false,P-1 主 / run ほか2件",
    );
  });
  it("keeps a formula-like comment as text and counts rows without a data type", () => {
    const result = hubTagCsv(
      project([
        [
          "=P-1",
          "主",
          [
            ["run", "PLC1.Pump1.Run"],
            ["flow", "PLC1.Pump1.Flow"],
          ],
        ],
      ]),
      null,
    );
    expect(result.untyped).toBe(1);
    expect(lines(result.csv)[1]).toBe(
      "PLC1,Pump1,Run,,bit,,,,,,,,,true,false,plc,,false,'=P-1 主 / run",
    );
  });
  it("names the file after the project with unsafe characters replaced", () => {
    expect(hubTagCsvFileName("ライン1")).toBe("hub-tags-ライン1.csv");
    expect(hubTagCsvFileName('a/b:"c"')).toBe("hub-tags-a_b__c_.csv");
    expect(hubTagCsvFileName("  ")).toBe("hub-tags-project.csv");
  });
});
