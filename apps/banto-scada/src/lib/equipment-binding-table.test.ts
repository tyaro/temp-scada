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
} from "./equipment-binding-table";
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
