import type { SlotType } from "./equipment";
import { serializeHubCsv } from "./hub-tag-csv";
import type { Project } from "./project";

/**
 * Write-tag list (operation design §7): the external names the Project may
 * write, built from the equipment bindings and the slots' `write`. A Hub
 * administrator scopes the terminal's write key with it; names outside the
 * scope are refused by the Hub.
 */
export interface WriteTagUse {
  equipmentCode: string;
  equipmentName: string;
  slotName: string;
  slotType: SlotType;
  label: string;
}
export interface WriteTagRow {
  externalName: string;
  /** Every use of the name, in equipment then slot order. */
  uses: WriteTagUse[];
}
export interface WriteTagList {
  rows: WriteTagRow[];
  /** Adopted write slots without a name yet: they cannot be written. */
  unassigned: WriteTagUse[];
}

/** Saved bindings only; unadopted slots are not listed. */
export function writeTagList(project: Project): WriteTagList {
  const types = new Map(
    (project.equipmentTypes ?? []).map((type) => [type.id, type]),
  );
  const rows = new Map<string, WriteTagUse[]>();
  const unassigned: WriteTagUse[] = [];
  for (const item of project.equipment ?? []) {
    for (const slot of types.get(item.typeId)?.slots ?? []) {
      if (!slot.write) continue;
      const binding = item.bindings.find((row) => row.slotName === slot.name);
      if (!binding) continue;
      const use = {
        equipmentCode: item.code,
        equipmentName: item.name,
        slotName: slot.name,
        slotType: slot.type,
        label: slot.write.label,
      };
      if (binding.externalName === null) {
        unassigned.push(use);
        continue;
      }
      const list = rows.get(binding.externalName);
      if (list) list.push(use);
      else rows.set(binding.externalName, [use]);
    }
  }
  return {
    rows: [...rows].map(([externalName, uses]) => ({ externalName, uses })),
    unassigned,
  };
}

/** One name per line, for pasting into the Hub's key scope. */
export function writeTagText(list: WriteTagList) {
  return list.rows.map((row) => row.externalName).join("\n");
}

const FORMULA_START = /^[=+\-@]/;
/** Free text only: a leading `'` keeps a spreadsheet from reading a formula. */
function textCell(text: string) {
  return FORMULA_START.test(text) ? `'${text}` : text;
}

export const WRITE_TAG_CSV_COLUMNS = [
  "externalName",
  "equipmentCode",
  "equipmentName",
  "slot",
  "slotType",
  "label",
] as const;

/**
 * One row per use, so a name written by several slots shows each of them. The
 * external name is kept exactly (it is the identity the Hub compares).
 */
export function writeTagCsv(list: WriteTagList) {
  return serializeHubCsv([
    [...WRITE_TAG_CSV_COLUMNS],
    ...list.rows.flatMap((row) =>
      row.uses.map((use) => [
        row.externalName,
        textCell(use.equipmentCode),
        textCell(use.equipmentName),
        use.slotName,
        use.slotType,
        textCell(use.label),
      ]),
    ),
  ]);
}

export function writeTagCsvFileName(projectName: string) {
  // eslint-disable-next-line no-control-regex
  const safe = projectName.replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_").trim();
  return `write-tags-${safe || "project"}.csv`;
}
