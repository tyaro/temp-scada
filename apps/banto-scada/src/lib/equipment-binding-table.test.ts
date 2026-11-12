import { describe, expect, it } from "vitest";
import equipmentSample from "../../../../examples/equipment.project.json";
import { parseProject } from "./project";
import { applyCommand } from "./editor";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import { sampleCatalog } from "./designer/tag-catalog";
import type { Project } from "./project";
import {
  bindingCell,
  bindingTableChanges,
  catalogIndex,
  draftCell,
  type BindingDraft,
  cellAfter,
  cellKey,
  cellMatch,
  isGridPaste,
  parsePasteGrid,
  pasteIntoTable,
  prefixFill,
  tagSuffixProblem,
} from "./equipment-binding-table";
import type { EquipmentSlot } from "./equipment";
const fresh = () => parseProject(JSON.stringify(equipmentSample));
const FAN = "0199f700-0000-7000-8000-000000000002";
const index = catalogIndex(sampleCatalog);
/** Types into cells of the first equipment as the table does. */
function typed(project: Project, cells: [string, string][]) {
  const drafts = new Map<string, BindingDraft>();
  const item = project.equipment![0];
  for (const [slot, text] of cells) {
    const key = cellKey(item.id, slot);
    drafts.set(key, draftCell(drafts, key, bindingCell(item, slot), text));
  }
  return drafts;
}

describe("cell semantics", () => {
  it("assigns typed names and keeps clearing within adopted slots", () => {
    expect(cellAfter(null, " A.B ")).toEqual({ externalName: " A.B " });
    expect(cellAfter(null, "  ")).toBeNull();
    expect(cellAfter(null, "\u0085\u3000")).toBeNull();
    expect(cellAfter({ externalName: "A" }, "")).toEqual({
      externalName: null,
    });
    expect(cellAfter({ externalName: null }, "")).toEqual({
      externalName: null,
    });
  });
  it("lists only real differences in table order", () => {
    const project = fresh();
    const drafts = typed(project, [
      ["current", "PLC.Fan.Current"],
      ["running", ""],
    ]);
    expect(bindingTableChanges(project, drafts)).toEqual([
      {
        equipmentId: FAN,
        slotName: "current",
        before: null,
        after: { externalName: "PLC.Fan.Current" },
      },
    ]);
  });
  it("matches names against the tag list by slot type", () => {
    expect(cellMatch("Demo.Water.Tank01.Level", "number", index)).toBe("found");
    expect(cellMatch("Demo.Water.Tank01.Level", "bool", index)).toBe(
      "incompatible",
    );
    expect(cellMatch("Demo.Water.Tank01.Level", "state", index)).toBe("found");
    expect(cellMatch("No.Such.Tag", "number", index)).toBe("missing");
    expect(cellMatch(" ", "number", index)).toBeNull();
    expect(cellMatch(" Demo.Water.Tank01.Level", "number", index)).toBe(
      "missing",
    );
  });
});

describe("spreadsheet paste", () => {
  it("parses tab separated rows and drops the trailing newline", () => {
    expect(parsePasteGrid("a\tb\r\nc\td\r\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(isGridPaste("single\n")).toBe(false);
    expect(isGridPaste("a\tb")).toBe(true);
    expect(isGridPaste("a\nb")).toBe(true);
  });
  it("places cells from the start cell and counts cells outside the table", () => {
    const { cells, dropped } = pasteIntoTable(
      [
        ["1", "2", "3"],
        ["4", "5", "6"],
      ],
      ["r1", "r2"],
      ["a", "b"],
      1,
      0,
    );
    expect([...cells]).toEqual([
      [cellKey("r2", "a"), "1"],
      [cellKey("r2", "b"), "2"],
    ]);
    expect(dropped).toBe(4);
  });
});

describe("assign-equipment-tags", () => {
  it("applies all cells as one undoable edit in slot order", () => {
    const original = fresh();
    const changes = bindingTableChanges(
      original,
      typed(original, [
        ["current", "PLC.Fan.Current"],
        ["running", "PLC.Fan.Run"],
      ]),
    );
    const result = recordEdit(
      original,
      emptyHistory(),
      { type: "assign-equipment-tags", changes },
      "edit",
    );
    expect(result.project.equipment![0].bindings).toEqual([
      { slotName: "running", externalName: "PLC.Fan.Run" },
      { slotName: "current", externalName: "PLC.Fan.Current" },
    ]);
    const undone = travelHistory(
      result.project,
      result.history,
      "undo",
      "edit",
    );
    expect(undone.project.equipment).toEqual(original.equipment);
  });
  it("keeps the value seen at the first edit so a later change is not overwritten", () => {
    const opened = fresh();
    const drafts = typed(opened, [["running", "PLC.Fan.Run"]]);
    const moved = applyCommand(
      opened,
      {
        type: "update-equipment",
        equipmentId: FAN,
        code: "FAN-101",
        name: opened.equipment![0].name,
        bindings: [{ slotName: "running", externalName: "Other.Run" }],
      },
      "edit",
    );
    // Typing again in the same cell keeps the first origin.
    const key = cellKey(FAN, "running");
    drafts.set(
      key,
      draftCell(
        drafts,
        key,
        bindingCell(moved.equipment![0], "running"),
        "PLC.Fan.Run2",
      ),
    );
    const changes = bindingTableChanges(moved, drafts);
    expect(changes[0].before).toEqual({ externalName: null });
    expect(() =>
      applyCommand(moved, { type: "assign-equipment-tags", changes }, "edit"),
    ).toThrow("表を開き直してください");
  });
  it("keeps an unadopted origin when the slot is adopted elsewhere before retyping", () => {
    const opened = fresh();
    const drafts = typed(opened, [["current", "A"]]);
    const moved = applyCommand(
      opened,
      {
        type: "update-equipment",
        equipmentId: FAN,
        code: "FAN-101",
        name: opened.equipment![0].name,
        bindings: [
          { slotName: "running", externalName: null },
          { slotName: "current", externalName: "Other.Current" },
        ],
      },
      "edit",
    );
    const key = cellKey(FAN, "current");
    drafts.set(
      key,
      draftCell(drafts, key, bindingCell(moved.equipment![0], "current"), "B"),
    );
    const changes = bindingTableChanges(moved, drafts);
    expect(changes[0].before).toBeNull();
    expect(() =>
      applyCommand(moved, { type: "assign-equipment-tags", changes }, "edit"),
    ).toThrow("表を開き直してください");
  });
  it("keeps cells of removed equipment so applying reports them", () => {
    const opened = fresh();
    const drafts = typed(opened, [["current", "A"]]);
    const removed = { ...opened, equipment: [] };
    const changes = bindingTableChanges(removed, drafts);
    expect(changes).toHaveLength(1);
    expect(() =>
      applyCommand(
        opened,
        {
          type: "assign-equipment-tags",
          changes: [{ ...changes[0], equipmentId: "gone" }],
        },
        "edit",
      ),
    ).toThrow("機器が見つかりません");
  });
  it("rejects every change when a saved cell moved since the table opened", () => {
    const original = fresh();
    const command = {
      type: "assign-equipment-tags" as const,
      changes: [
        {
          equipmentId: FAN,
          slotName: "current",
          before: null,
          after: { externalName: "A" },
        },
        {
          equipmentId: FAN,
          slotName: "running",
          before: { externalName: "stale" },
          after: { externalName: "B" },
        },
      ],
    };
    expect(() => applyCommand(original, command, "edit")).toThrow(
      "表を開き直してください",
    );
    expect(original).toEqual(fresh());
  });
  it("rejects undeclared slots, duplicates and over-long names", () => {
    const original = fresh();
    const change = {
      equipmentId: FAN,
      slotName: "current",
      before: null,
      after: { externalName: "A" },
    };
    for (const changes of [
      [{ ...change, slotName: "missing" }],
      [change, change],
      [{ ...change, after: { externalName: "x".repeat(513) } }],
      [{ ...change, equipmentId: "nope" }],
    ])
      expect(() =>
        applyCommand(
          original,
          { type: "assign-equipment-tags", changes },
          "edit",
        ),
      ).toThrow();
  });
});

describe("prefix fill", () => {
  const slots: EquipmentSlot[] = [
    { name: "running", type: "bool", direction: "read", tagSuffix: "Running" },
    { name: "current", type: "number", direction: "read" },
    {
      name: "fault",
      type: "bool",
      direction: "read",
      allowUnassigned: true,
      tagSuffix: "Fault",
    },
    {
      name: "pressure",
      type: "number",
      direction: "read",
      allowUnassigned: true,
      tagSuffix: "Pressure",
    },
  ];
  const prefixes = new Map([
    ["a", "Demo.Water.Pump01."],
    ["b", " "],
    ["c", "s7.line1.P101_"],
  ]);
  it("joins prefix and suffix for suffixed slots of rows with a prefix", () => {
    const result = prefixFill(slots, ["a", "b", "c", "d"], prefixes, null);
    expect([...result.cells]).toEqual([
      [cellKey("a", "running"), "Demo.Water.Pump01.Running"],
      [cellKey("a", "fault"), "Demo.Water.Pump01.Fault"],
      [cellKey("a", "pressure"), "Demo.Water.Pump01.Pressure"],
      [cellKey("c", "running"), "s7.line1.P101_Running"],
      [cellKey("c", "fault"), "s7.line1.P101_Fault"],
      [cellKey("c", "pressure"), "s7.line1.P101_Pressure"],
    ]);
    expect(result).toMatchObject({ filled: 6, blanked: 0 });
  });
  it("blanks only allowUnassigned names missing from the tag list", () => {
    const result = prefixFill(slots, ["a", "c"], prefixes, index);
    expect([...result.cells]).toEqual([
      [cellKey("a", "running"), "Demo.Water.Pump01.Running"],
      [cellKey("a", "fault"), ""],
      [cellKey("a", "pressure"), "Demo.Water.Pump01.Pressure"],
      // Missing but not allowed unassigned: kept and shown unresolved.
      [cellKey("c", "running"), "s7.line1.P101_Running"],
      [cellKey("c", "fault"), ""],
      [cellKey("c", "pressure"), ""],
    ]);
    expect(result).toMatchObject({ filled: 3, blanked: 3 });
  });
  it("adopts a blanked unadopted slot as unassigned until it is typed again", () => {
    const project = fresh();
    const item = project.equipment![0];
    const key = cellKey(item.id, "current");
    const drafts = new Map<string, BindingDraft>();
    drafts.set(key, draftCell(drafts, key, null, "", true));
    expect(cellAfter(null, "", true)).toEqual({ externalName: null });
    expect(bindingTableChanges(project, drafts)).toEqual([
      {
        equipmentId: item.id,
        slotName: "current",
        before: null,
        after: { externalName: null },
      },
    ]);
    drafts.set(key, draftCell(drafts, key, null, ""));
    expect(bindingTableChanges(project, drafts)).toEqual([]);
  });
  it("checks a suffix like a tag name", () => {
    expect(tagSuffixProblem("")).toBeNull();
    expect(tagSuffixProblem(" RUN")).toBeNull();
    expect(tagSuffixProblem(" 　")).toBe("タグ名の末尾は空白だけにできません");
    expect(tagSuffixProblem("x".repeat(512))).toBeNull();
    expect(tagSuffixProblem("x".repeat(513))).toBe(
      "タグ名の末尾は512文字以内です",
    );
  });
});
