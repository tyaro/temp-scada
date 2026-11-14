import {
  bindingCell,
  cellKey,
  isBlankName,
  MAX_EXTERNAL_NAME,
  type BindingCell,
} from "./equipment-binding-table";
import type { Project } from "./project";

/** A vendor I/O list larger than this is refused before decoding. */
export const MAX_IO_CSV_BYTES = 5 * 1024 * 1024;
/** Data records (after the header) one import accepts. */
export const MAX_IO_CSV_RECORDS = 20000;

/**
 * UTF-8 (with or without BOM) is tried first; bytes that are not valid UTF-8
 * are read as Shift_JIS, the default of a Japanese Excel "CSV" save.
 */
export function decodeIoCsv(bytes: Uint8Array): {
  text: string;
  encoding: "UTF-8" | "Shift_JIS";
} {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { text: text.replace(/^﻿/, ""), encoding: "UTF-8" };
  } catch {
    return {
      text: new TextDecoder("shift_jis").decode(bytes),
      encoding: "Shift_JIS",
    };
  }
}

/**
 * RFC 4180 with comma separators: `"` quotes a field, `""` is a quote inside it,
 * and CRLF, LF or CR ends a record. Records whose fields are all empty are dropped.
 * After a closing quote only a separator, a line end or the end may follow, so
 * `"Tag"x` is rejected instead of silently becoming `Tagx`.
 * Each record keeps its 1-based line number so skipped rows can be reported.
 */
export function parseIoCsv(text: string): { line: number; fields: string[] }[] {
  const records: { line: number; fields: string[] }[] = [];
  let fields: string[] = [],
    field = "",
    quoted = false,
    closed = false,
    line = 1,
    start = 1;
  const endRecord = () => {
    fields.push(field);
    if (fields.some((value) => value !== ""))
      records.push({ line: start, fields });
    fields = [];
    field = "";
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else {
        if (ch === "\n" || (ch === "\r" && text[i + 1] !== "\n")) line++;
        field += ch;
      }
    } else if (ch === ",") {
      fields.push(field);
      field = "";
      closed = false;
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRecord();
      closed = false;
      line++;
      start = line;
    } else if (closed)
      throw new Error(`${line}行目の閉じた引用符（"）の後に文字があります`);
    else if (ch === '"' && field === "") quoted = true;
    else field += ch;
  }
  if (quoted) throw new Error(`${start}行目の引用符（"）が閉じていません`);
  if (field !== "" || fields.length) endRecord();
  return records;
}

export interface IoCsvColumns {
  code: number;
  slot: number;
  tag: number;
}
const GUESS: Record<keyof IoCsvColumns, string[]> = {
  code: ["機器番号", "code", "equipmentcode", "機器"],
  slot: ["slot", "信号", "信号名", "slotname"],
  tag: ["タグ名", "タグ", "tag", "tagname", "外部名", "externalname"],
};
/** Picks columns whose header names the role; the first unclaimed match wins. */
export function guessIoCsvColumns(
  header: readonly string[],
): Partial<IoCsvColumns> {
  const names = header.map((name) => name.trim().toLowerCase()),
    used = new Set<number>(),
    result: Partial<IoCsvColumns> = {};
  for (const role of Object.keys(GUESS) as (keyof IoCsvColumns)[]) {
    for (const word of GUESS[role]) {
      const at = names.findIndex((name, i) => name === word && !used.has(i));
      if (at >= 0) {
        result[role] = at;
        used.add(at);
        break;
      }
    }
  }
  return result;
}

export interface IoCsvSkip {
  line: number;
  code: string;
  slot: string;
  tag: string;
  reason: string;
}
export interface IoCsvImport {
  /** Text to draft by cell key, with the saved value it was read against. */
  cells: Map<string, { text: string; saved: BindingCell }>;
  /** Equipment types that received at least one cell. */
  typeIds: Set<string>;
  skipped: IoCsvSkip[];
}
/**
 * One record per signal: the equipment code and slot name (both trimmed, as
 * identifiers) pick the cell and the tag name is put in as is (never trimmed,
 * like a typed name). Blank tag names are skipped rather than unassigning, and
 * a cell named differently by two records is left untouched.
 */
export function importIoCsv(
  project: Project,
  records: readonly { line: number; fields: string[] }[],
  columns: IoCsvColumns,
): IoCsvImport {
  const equipment = new Map(
      (project.equipment ?? []).map((item) => [item.code, item]),
    ),
    types = new Map(
      (project.equipmentTypes ?? []).map((type) => [type.id, type]),
    );
  const skipped: IoCsvSkip[] = [];
  const found = new Map<
    string,
    { text: string; saved: BindingCell; typeId: string; lines: IoCsvSkip[] }
  >();
  const conflicts = new Set<string>();
  for (const { line, fields } of records) {
    const row: IoCsvSkip = {
      line,
      code: (fields[columns.code] ?? "").trim(),
      slot: (fields[columns.slot] ?? "").trim(),
      tag: fields[columns.tag] ?? "",
      reason: "",
    };
    const skip = (reason: string) => skipped.push({ ...row, reason });
    if (!row.code) {
      skip("機器番号が空です");
      continue;
    }
    const item = equipment.get(row.code);
    if (!item) {
      skip("機器番号が見つかりません");
      continue;
    }
    if (!row.slot) {
      skip("slotが空です");
      continue;
    }
    if (!types.get(item.typeId)?.slots.some((slot) => slot.name === row.slot)) {
      skip("機器種別にないslotです");
      continue;
    }
    if (isBlankName(row.tag)) {
      skip("タグ名が空です");
      continue;
    }
    if ([...row.tag].length > MAX_EXTERNAL_NAME) {
      skip(`タグ名が${MAX_EXTERNAL_NAME}文字を超えています`);
      continue;
    }
    const key = cellKey(item.id, row.slot),
      seen = found.get(key);
    if (!seen)
      found.set(key, {
        text: row.tag,
        saved: bindingCell(item, row.slot),
        typeId: item.typeId,
        lines: [row],
      });
    else {
      seen.lines.push(row);
      if (seen.text !== row.tag) conflicts.add(key);
    }
  }
  const cells = new Map<string, { text: string; saved: BindingCell }>(),
    typeIds = new Set<string>();
  for (const [key, cell] of found) {
    if (conflicts.has(key)) {
      for (const row of cell.lines)
        skipped.push({ ...row, reason: "同じslotに別のタグ名があります" });
      continue;
    }
    cells.set(key, { text: cell.text, saved: cell.saved });
    typeIds.add(cell.typeId);
  }
  skipped.sort((a, b) => a.line - b.line);
  return { cells, typeIds, skipped };
}
