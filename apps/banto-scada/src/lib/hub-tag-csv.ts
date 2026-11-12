import { isBlankName, type CatalogIndex } from "./equipment-binding-table";
import type { SlotType } from "./equipment";
import type { Project } from "./project";
import type { TagCatalog } from "./designer/tag-catalog";

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

/** A connection and group pair the Hub tag list already has. */
export interface HubGroup {
  connection: string;
  group: string;
}
/**
 * Connection and group pairs from the tag list's explicit metadata: a group
 * under a parent group is `connection` / `group` (catalog-session.ts).
 */
export function hubGroups(catalog: TagCatalog): HubGroup[] {
  const names = new Map(catalog.groups.map((group) => [group.id, group.name]));
  return catalog.groups.flatMap((group) => {
    const connection =
      group.parentId === undefined ? undefined : names.get(group.parentId);
    return connection === undefined ? [] : [{ connection, group: group.name }];
  });
}
function checkParts(parts: string[]): string | null {
  if (parts.some((part) => isBlankName(part))) return "空の部分がある";
  if (parts.some((part) => part !== part.trim()))
    return "部分の前後に空白がある（Hubの取込みで削られる）";
  if (parts.some((part) => Array.from(part).length > MAX_PART))
    return `${MAX_PART}文字を超える部分がある`;
  return null;
}
/**
 * Splits a Hub external name `connection.group.tag` for the export only. Other
 * features never split external names (catalog-selection.md). A part may hold
 * dots in the Hub, so a known connection and group from the tag list decide
 * the split first; without one, only a name with exactly two dots is split.
 * A name whose parts cannot be told apart is not exported.
 */
export function splitHubName(
  name: string,
  groups: readonly HubGroup[] = [],
): { parts: [string, string, string] } | { reason: string } {
  if (name.includes(",") || CONTROL.test(name))
    return { reason: "カンマや制御文字を含む" };
  const known = new Map<string, [string, string, string]>();
  for (const { connection, group } of groups) {
    const head = `${connection}.${group}.`;
    if (name.startsWith(head) && name.length > head.length)
      known.set(JSON.stringify([connection, group]), [
        connection,
        group,
        name.slice(head.length),
      ]);
  }
  if (known.size > 1)
    return { reason: "タグ一覧の接続.グループに複数の分け方で一致する" };
  const parts = known.size
    ? [...known.values()][0]
    : (name.split(".") as [string, string, string]);
  if (parts.length !== 3)
    return {
      reason: `タグ一覧の接続.グループに一致せず、「.」が${parts.length - 1}個（2個なら分けられる）`,
    };
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
  groups: readonly HubGroup[] = [],
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
      const split = splitHubName(name, groups);
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
  for (const [name, list] of uses) {
    const [connection, group, tag] = (
      splitHubName(name, groups) as { parts: [string, string, string] }
    ).parts;
    const first = list[0];
    const types = new Set(list.map((use) => hubDataType(use.type)));
    const comment = `${first.code} ${first.name} / ${first.slotName}${
      list.length > 1 ? ` ほか${list.length - 1}件` : ""
    }`;
    const cells: Record<Column, string> = {
      connection,
      group,
      name: tag,
      address: "",
      // Slots of different types sharing a name leave the choice to the user.
      dataType: types.size === 1 ? [...types][0] : "",
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
      comment: Array.from(comment).slice(0, MAX_COMMENT).join(""),
    };
    rows.push(HUB_TAG_CSV_COLUMNS.map((column) => cells[column]));
  }
  return {
    csv: serializeHubCsv(rows),
    rows: uses.size,
    registered: registered.size,
    invalid,
    checked: index !== null,
  };
}

/** Default file name; characters a file system rejects become `_`. */
export function hubTagCsvFileName(projectName: string) {
  // eslint-disable-next-line no-control-regex
  const safe = projectName.replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_").trim();
  return `hub-tags-${safe || "project"}.csv`;
}
