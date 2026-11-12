import { isBlankName, type CatalogIndex } from "./equipment-binding-table";
import type { SlotType } from "./equipment";
import type { Project } from "./project";

/**
 * Columns of the Hub tag CSV import, in order. The Hub checks the header for an
 * exact match (banto-industrial apps/banto-hub/src/lib/banto/tagCsv.ts
 * `TAG_CSV_COLUMNS`, 19 columns as of 2026-11-12).
 */
export const HUB_TAG_CSV_COLUMNS = [
  "connection",
  "group",
  "name",
  "address",
  "dataType",
  "stringLength",
  "stringEncoding",
  "unit",
  "decimals",
  "rawLo",
  "rawHi",
  "engLo",
  "engHi",
  "enabled",
  "writable",
  "tagKind",
  "expression",
  "retain",
  "comment",
] as const;
type Column = (typeof HUB_TAG_CSV_COLUMNS)[number];
/** Hub limits: each name part is 100 chars at most, a comment 500. */
const MAX_PART = 100;
const MAX_COMMENT = 500;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;

/** Candidate Hub data type of a slot; a number slot is left for the user to choose. */
export function hubDataType(type: SlotType) {
  return type === "bool" ? "bit" : type === "state" ? "u16" : "";
}

function checkParts(parts: string[]): string | null {
  if (parts.some((part) => isBlankName(part))) return "空の部分がある";
  if (parts.some((part) => part !== part.trim()))
    return "部分の前後に空白がある（Hubの取込みで削られる）";
  if (parts.some((part) => Array.from(part).length > MAX_PART))
    return `${MAX_PART}文字を超える部分がある`;
  // Excel may read such a cell as a formula even when quoted. Renaming would
  // change the tag name, so the name is not exported.
  if (parts.some((part) => FORMULA_START.test(part)))
    return "先頭が = + - @ の部分がある（表計算ソフトで数式として読まれる）";
  return null;
}
const FORMULA_START = /^[=+\-@]/;
/** Free text such as the comment: a leading `'` keeps it from being a formula. */
function textCell(text: string) {
  return FORMULA_START.test(text) ? `'${text}` : text;
}
/**
 * Splits a Hub external name `connection.group.tag` for the export only. Other
 * features never split external names (catalog-selection.md). Connection and
 * group names never hold a dot (2026-11-12 user decision), so the first two
 * dots split the name and the tag part may hold more dots. A name that cannot
 * be split is not exported.
 */
export function splitHubName(
  name: string,
): { parts: [string, string, string] } | { reason: string } {
  if (name.includes(",") || CONTROL.test(name))
    return { reason: "カンマや制御文字を含む" };
  const first = name.indexOf(".");
  const second = first < 0 ? -1 : name.indexOf(".", first + 1);
  if (second < 0)
    return {
      reason: `「.」が${first < 0 ? 0 : 1}個（接続.グループ.タグの2個以上が必要）`,
    };
  const parts: [string, string, string] = [
    name.slice(0, first),
    name.slice(first + 1, second),
    name.slice(second + 1),
  ];
  const problem = checkParts(parts);
  return problem ? { reason: problem } : { parts };
}

function quote(cell: string) {
  return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}
/** Same as the Hub export: UTF-8 BOM, CRLF line ends, RFC 4180 quoting. */
export function serializeHubCsv(rows: readonly (readonly string[])[]) {
  return (
    "\uFEFF" + rows.map((row) => row.map(quote).join(",")).join("\r\n") + "\r\n"
  );
}

export interface HubTagCsvSkip {
  equipmentCode: string;
  slotName: string;
  externalName: string;
  reason: string;
}
export interface HubTagCsvExport {
  csv: string;
  /** Data rows written (one per distinct external name). */
  rows: number;
  /** Distinct names left out because the tag list already has them. */
  registered: number;
  /** Assigned slots left out because their name cannot be split. */
  invalid: HubTagCsvSkip[];
  /** False when no tag list was given: every name is written, unchecked. */
  checked: boolean;
  /** Rows whose dataType is blank (number slots, mixed types): the user fills it. */
  untyped: number;
}
interface Use {
  code: string;
  name: string;
  slotName: string;
  type: SlotType;
}

/**
 * Hub registration CSV of every adopted and assigned slot, in equipment then
 * slot order. With a tag list, names it already has are left out. One row per
 * distinct name; its comment names the first use and counts the others.
 */
export function hubTagCsv(
  project: Project,
  index: CatalogIndex | null,
): HubTagCsvExport {
  const types = new Map(
    (project.equipmentTypes ?? []).map((type) => [type.id, type]),
  );
  const uses = new Map<string, Use[]>();
  const invalid: HubTagCsvSkip[] = [];
  const registered = new Set<string>();
  for (const item of project.equipment ?? []) {
    const slots = types.get(item.typeId)?.slots ?? [];
    for (const slot of slots) {
      const name = item.bindings.find(
        (row) => row.slotName === slot.name,
      )?.externalName;
      if (typeof name !== "string") continue;
      if (index?.get(name)?.length) {
        registered.add(name);
        continue;
      }
      const split = splitHubName(name);
      if ("reason" in split) {
        invalid.push({
          equipmentCode: item.code,
          slotName: slot.name,
          externalName: name,
          reason: split.reason,
        });
        continue;
      }
      const use = {
        code: item.code,
        name: item.name,
        slotName: slot.name,
        type: slot.type,
      };
      const list = uses.get(name);
      if (list) list.push(use);
      else uses.set(name, [use]);
    }
  }
  const rows: string[][] = [[...HUB_TAG_CSV_COLUMNS]];
  let untyped = 0;
  for (const [name, list] of uses) {
    const [connection, group, tag] = (
      splitHubName(name) as { parts: [string, string, string] }
    ).parts;
    const first = list[0];
    const types = new Set(list.map((use) => hubDataType(use.type)));
    // Slots of different types sharing a name leave the choice to the user.
    const dataType = types.size === 1 ? [...types][0] : "";
    if (!dataType) untyped += 1;
    const comment = `${first.code} ${first.name} / ${first.slotName}${
      list.length > 1 ? ` ほか${list.length - 1}件` : ""
    }`;
    const cells: Record<Column, string> = {
      connection,
      group,
      name: tag,
      address: "",
      dataType,
      stringLength: "",
      stringEncoding: "",
      unit: "",
      decimals: "",
      rawLo: "",
      rawHi: "",
      engLo: "",
      engHi: "",
      enabled: "true",
      writable: "false",
      tagKind: "plc",
      expression: "",
      retain: "false",
      comment: Array.from(textCell(comment)).slice(0, MAX_COMMENT).join(""),
    };
    rows.push(HUB_TAG_CSV_COLUMNS.map((column) => cells[column]));
  }
  return {
    csv: serializeHubCsv(rows),
    rows: uses.size,
    registered: registered.size,
    invalid,
    checked: index !== null,
    untyped,
  };
}

/** Default file name; characters a file system rejects become `_`. */
export function hubTagCsvFileName(projectName: string) {
  // eslint-disable-next-line no-control-regex
  const safe = projectName.replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_").trim();
  return `hub-tags-${safe || "project"}.csv`;
}
