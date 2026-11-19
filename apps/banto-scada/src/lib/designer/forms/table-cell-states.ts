import type { TableShape } from "../../project";
import type { TableCellState } from "../../table";
import { DEFAULT_BOOL_DISPLAY, parseBoolDisplay } from "./bool-display";

/**
 * Inspector の「セルの状態表示」（Issue #303 第2段）。選べるセル全部の値を
 * 「セルごとの欄の名前 → 値」の JSON にして、表のフォームの hidden の入力 1 つ
 * （`TABLE_CELL_STATES_FIELD`）に持つ。実の入力欄は選んだセルの分だけ作り、
 * その変更で JSON を書き換える（大きな表で欄が数万になるのを避ける）。下書きは
 * ほかの欄と同じく drafts.track が hidden の入力から保ち、「変更を適用」で
 * 他の欄と一緒に 1 履歴にする。
 */

/** 全セルの状態表示の下書き（JSON）を持つ hidden の入力の名前。 */
export const TABLE_CELL_STATES_FIELD = "tableCellStates";

/** 下書きの JSON を読む（空や壊れた値は空の下書き）。 */
export function readTableCellStateDraft(text: string): Record<string, string> {
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

/** 下書きの JSON の 1 欄を書き換える（ほかの欄の並びは保つ）。 */
export function writeTableCellStateDraft(
  text: string,
  field: string,
  value: string,
): string {
  return JSON.stringify({ ...readTableCellStateDraft(text), [field]: value });
}

/** 状態表示を編集できるセル（0 始まりの位置と、選択肢の名前）。 */
export interface TableCellStateCandidate {
  row: number;
  column: number;
  label: string;
}

/** セルごとの欄の名前（下書きの JSON の項目名）。 */
export function tableCellStateField(
  row: number,
  column: number,
  key: string,
): string {
  return `tableCell:${row}:${column}:${key}`;
}

/**
 * 選択肢: 画面の表は binding のあるセル、Symbol 定義の表は slotBinding のある
 * セル（「行:列 · タグ名／slot 名」、1 始まり）。保存済みの表から作る。
 */
export function tableCellStateCandidates(
  shape: TableShape,
  definition: boolean,
): TableCellStateCandidate[] {
  return shape.cells.flatMap((cells, row) =>
    cells.flatMap((cell, column) => {
      const name = definition
        ? cell.slotBinding?.slotName
        : cell.binding?.externalName;
      return name === undefined
        ? []
        : [{ row, column, label: `${row + 1}:${column + 1} · ${name}` }];
    }),
  );
}

/** フォームの初期値（drafts.track に渡す。hidden の入力 1 つ分）。 */
export function tableCellStateValues(
  shape: TableShape,
  definition: boolean,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const { row, column } of tableCellStateCandidates(shape, definition)) {
    const cell = shape.cells[row][column];
    const field = (key: string) => tableCellStateField(row, column, key);
    values[field("stateTarget")] = cell.stateTarget ?? "text";
    if (definition) continue;
    const shown = cell.boolDisplay ?? DEFAULT_BOOL_DISPLAY;
    values[field("boolDisplayMode")] = cell.boolDisplay
      ? "enabled"
      : "disabled";
    values[field("trueText")] = shown.true.text;
    values[field("trueColor")] = shown.true.color;
    values[field("falseText")] = shown.false.text;
    values[field("falseColor")] = shown.false.color;
    values[field("unknownColor")] = shown.unknownColor;
  }
  return { [TABLE_CELL_STATES_FIELD]: JSON.stringify(values) };
}

/**
 * フォームの下書きの JSON からセルごとの状態表示を読む（rows × columns の位置で対応させる）。
 * 欄のないセルは undefined。使えないセルの値を外すのは buildTableCells が行う。
 */
export function parseTableCellStates(
  data: Pick<FormData, "get">,
  rows: number,
  columns: number,
  definition: boolean,
): (TableCellState | undefined)[][] {
  const stored = readTableCellStateDraft(
    String(data.get(TABLE_CELL_STATES_FIELD) ?? ""),
  );
  const draft = { get: (name: string) => stored[name] ?? null };
  return Array.from({ length: rows }, (_, row) =>
    Array.from({ length: columns }, (_, column) => {
      const field = (key: string) => tableCellStateField(row, column, key);
      const target = draft.get(field("stateTarget"));
      if (target === null) return undefined;
      const where = `セルの状態表示の${row + 1}行${column + 1}列`;
      if (target !== "text" && target !== "fill")
        throw new Error(`${where}の状態の色の使い先を選択してください。`);
      let boolDisplay;
      if (!definition)
        try {
          boolDisplay = parseBoolDisplay(draft, field) ?? undefined;
        } catch (error) {
          throw new Error(
            `${where}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      return {
        ...(boolDisplay ? { boolDisplay } : {}),
        // 文字は既定（項目なし）なので保存しない。
        ...(target === "fill" ? { stateTarget: "fill" as const } : {}),
      };
    }),
  );
}
