import {
  compatibleTag,
  type CatalogTag,
  type TagCatalog,
} from "./designer/tag-catalog";
import {
  slotReadType,
  type EquipmentInstance,
  type SlotType,
} from "./equipment";
import type { Project } from "./project";

/** One slot of one equipment: null = not adopted, externalName null = adopted but unassigned. */
export type BindingCell = { externalName: string | null } | null;
export interface BindingTableChange {
  equipmentId: string;
  slotName: string;
  before: BindingCell;
  after: BindingCell;
}
export const MAX_EXTERNAL_NAME = 512;
/** The same whitespace set the project schema rejects as a whole external name. */
const BLANK =
  /^[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]*$/;
export function isBlankName(text: string) {
  return BLANK.test(text);
}
/** Draft cells are keyed by equipment id and slot name. */
export function cellKey(equipmentId: string, slotName: string) {
  return `${equipmentId}\u0000${slotName}`;
}
export function bindingCell(
  item: EquipmentInstance,
  slotName: string,
): BindingCell {
  const binding = item.bindings.find((row) => row.slotName === slotName);
  return binding ? { externalName: binding.externalName } : null;
}
export function cellText(cell: BindingCell) {
  return cell?.externalName ?? "";
}
/**
 * A typed name adopts and assigns the slot; names are opaque and never trimmed.
 * A blank cell keeps the slot adopted but unassigned; the table never un-adopts
 * (that stays in the per-equipment form).
 */
export function cellAfter(before: BindingCell, text: string): BindingCell {
  if (!isBlankName(text)) return { externalName: text };
  return before === null ? null : { externalName: null };
}
export function sameCell(a: BindingCell, b: BindingCell) {
  return a === null
    ? b === null
    : b !== null && a.externalName === b.externalName;
}
/** Splits clipboard text from a spreadsheet into rows of cells. */
export function parsePasteGrid(text: string): string[][] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => line.split("\t"));
}
export function isGridPaste(text: string) {
  return /[\t\r\n]/.test(text.replace(/(\r\n?|\n)$/, ""));
}
/**
 * Places a pasted grid from the start cell. Cells outside the table are dropped and counted.
 */
export function pasteIntoTable(
  grid: string[][],
  rows: string[],
  columns: string[],
  startRow: number,
  startColumn: number,
) {
  const cells = new Map<string, string>();
  let dropped = 0;
  grid.forEach((line, r) =>
    line.forEach((value, c) => {
      const row = rows[startRow + r],
        column = columns[startColumn + c];
      if (row === undefined || column === undefined) dropped++;
      else cells.set(cellKey(row, column), value);
    }),
  );
  return { cells, dropped };
}
/**
 * A typed cell remembers the saved value the user was looking at when they first
 * edited it, so a later change to that binding is detected instead of overwritten.
 */
export interface BindingDraft {
  text: string;
  origin: BindingCell;
}
export function draftCell(
  drafts: ReadonlyMap<string, BindingDraft>,
  key: string,
  saved: BindingCell,
  text: string,
): BindingDraft {
  return { text, origin: drafts.get(key)?.origin ?? saved };
}
/** Cells whose draft differs from the value seen when editing, in table order. */
export function bindingTableChanges(
  project: Project,
  drafts: ReadonlyMap<string, BindingDraft>,
): BindingTableChange[] {
  const changes: BindingTableChange[] = [],
    visited = new Set<string>();
  const push = (equipmentId: string, slotName: string, draft: BindingDraft) => {
    const after = cellAfter(draft.origin, draft.text);
    if (!sameCell(draft.origin, after))
      changes.push({ equipmentId, slotName, before: draft.origin, after });
  };
  for (const item of project.equipment ?? []) {
    const type = project.equipmentTypes?.find((row) => row.id === item.typeId);
    for (const slot of type?.slots ?? []) {
      const key = cellKey(item.id, slot.name),
        draft = drafts.get(key);
      if (!draft) continue;
      visited.add(key);
      push(item.id, slot.name, draft);
    }
  }
  // Cells whose equipment or slot disappeared stay listed so applying reports it.
  for (const [key, draft] of drafts) {
    if (visited.has(key)) continue;
    const [equipmentId, slotName] = key.split("\u0000");
    push(equipmentId, slotName, draft);
  }
  return changes;
}
export function cellProblem(text: string) {
  return !isBlankName(text) && [...text].length > MAX_EXTERNAL_NAME
    ? `タグ名は${MAX_EXTERNAL_NAME}文字以内です`
    : null;
}
export type CellMatch = "found" | "missing" | "incompatible";
export type CatalogIndex = ReadonlyMap<string, readonly CatalogTag[]>;
/** Builds the lookup once per tag list so each cell check is a map access. */
export function catalogIndex(catalog: TagCatalog): CatalogIndex {
  const index = new Map<string, CatalogTag[]>();
  for (const tag of catalog.tags) {
    const rows = index.get(tag.externalName);
    if (rows) rows.push(tag);
    else index.set(tag.externalName, [tag]);
  }
  return index;
}
/** Checks an assigned name against the tag list; empty names are not checked. */
export function cellMatch(
  text: string,
  type: SlotType,
  index: CatalogIndex,
): CellMatch | null {
  if (isBlankName(text)) return null;
  const tags = index.get(text);
  if (!tags?.length) return "missing";
  return tags.some((tag) => compatibleTag(tag, slotReadType(type)))
    ? "found"
    : "incompatible";
}
/** Candidate only: every change must still match the saved cell, or nothing is applied. */
export function applyBindingTableChanges(
  next: Project,
  changes: readonly BindingTableChange[],
) {
  const seen = new Set<string>();
  for (const change of changes) {
    const key = cellKey(change.equipmentId, change.slotName);
    if (seen.has(key)) throw new Error("同じ割付の変更が重複しています");
    seen.add(key);
    const item = next.equipment?.find((row) => row.id === change.equipmentId);
    if (!item) throw new Error("機器が見つかりません");
    const type = next.equipmentTypes?.find((row) => row.id === item.typeId);
    if (!type?.slots.some((slot) => slot.name === change.slotName))
      throw new Error("未宣言のslotです");
    if (!sameCell(bindingCell(item, change.slotName), change.before))
      throw new Error(
        "割付が表を開いた後に変わりました。表を開き直してください",
      );
    if (change.after === null)
      item.bindings = item.bindings.filter(
        (row) => row.slotName !== change.slotName,
      );
    else {
      const problem =
        change.after.externalName === null
          ? null
          : cellProblem(change.after.externalName);
      if (problem) throw new Error(problem);
      const others = item.bindings.filter(
        (row) => row.slotName !== change.slotName,
      );
      others.push({
        slotName: change.slotName,
        externalName: change.after.externalName,
      });
      const order = type.slots.map((slot) => slot.name);
      item.bindings = others.sort(
        (a, b) => order.indexOf(a.slotName) - order.indexOf(b.slotName),
      );
    }
  }
}
