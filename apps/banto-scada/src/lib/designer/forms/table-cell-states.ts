import type { TableShape } from "../../project";
import type { TableCellState } from "../../table";
import { DEFAULT_BOOL_DISPLAY, parseBoolDisplay } from "./bool-display";

/**
 * Inspector の「セルの状態表示」（Issue #303 第2段）。表のフォームの中に、選べる
 * セルごとの入力欄を名前を分けて置き、選んだセルの欄だけを見せる。下書きは
 * ほかの欄と同じく drafts.track が保ち、「変更を適用」で他の欄と一緒に 1 履歴にする。
 */

/** 状態表示を編集できるセル（0 始まりの位置と、選択肢の名前）。 */
export interface TableCellStateCandidate {
  row: number;
  column: number;
  label: string;
}

/** セルごとの入力欄の名前。 */
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

/** フォームの初期値（drafts.track に渡す）。 */
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
  return values;
}

/**
 * フォームからセルごとの状態表示を読む（rows × columns の位置で対応させる）。
 * 欄のないセルは undefined。使えないセルの値を外すのは buildTableCells が行う。
 */
export function parseTableCellStates(
  data: Pick<FormData, "get">,
  rows: number,
  columns: number,
  definition: boolean,
): (TableCellState | undefined)[][] {
  return Array.from({ length: rows }, (_, row) =>
    Array.from({ length: columns }, (_, column) => {
      const field = (key: string) => tableCellStateField(row, column, key);
      const target = data.get(field("stateTarget"));
      if (target === null) return undefined;
      const where = `セルの状態表示の${row + 1}行${column + 1}列`;
      if (target !== "text" && target !== "fill")
        throw new Error(`${where}の状態の色の使い先を選択してください。`);
      let boolDisplay;
      if (!definition)
        try {
          boolDisplay = parseBoolDisplay(data, field) ?? undefined;
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
