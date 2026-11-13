import type { TableCell, TableShape } from "./project";

/** 表の大きさの上限（schema と Rust の検査と同じ値）。 */
export const TABLE_LIMITS = {
  rows: 100,
  columns: 32,
  cellText: 256,
  weight: 1000,
  borderWidth: 32,
} as const;

const COLOR = /^#[0-9a-fA-F]{6}$/;
/** schema の maxLength・Rust と同じく、文字数は Unicode のコードポイントで数える。 */
const codePoints = (text: string) => [...text].length;
const CELL_TEXT = /^[^\t\n\r]*$/;

/**
 * 行・列の数と、cells の行列の形が一致すること（schema では表せない）。
 * 列幅・行の高さは比で、表の枠の幅・高さを比で分ける。
 */
export function validateTableShape(shape: TableShape) {
  const { rows, columns, cells } = shape;
  if (rows.length < 1 || rows.length > TABLE_LIMITS.rows)
    throw new Error(`表の行は1〜${TABLE_LIMITS.rows}行にしてください`);
  if (columns.length < 1 || columns.length > TABLE_LIMITS.columns)
    throw new Error(`表の列は1〜${TABLE_LIMITS.columns}列にしてください`);
  for (const weight of [...rows, ...columns])
    if (!Number.isFinite(weight) || weight <= 0 || weight > TABLE_LIMITS.weight)
      throw new Error(
        `表の列幅・行の高さは0より大きく${TABLE_LIMITS.weight}以下の比にしてください`,
      );
  if (
    cells.length !== rows.length ||
    cells.some((row) => row.length !== columns.length)
  )
    throw new Error("表のセルの数を行と列の数に合わせてください");
  for (const row of cells)
    for (const cell of row) {
      if (
        typeof cell.text !== "string" ||
        !CELL_TEXT.test(cell.text) ||
        codePoints(cell.text) > TABLE_LIMITS.cellText
      )
        throw new Error(
          `表のセルの文字は改行・タブを含まない${TABLE_LIMITS.cellText}文字以内にしてください`,
        );
      if (
        (cell.fill !== undefined && !COLOR.test(cell.fill)) ||
        (cell.color !== undefined && !COLOR.test(cell.color))
      )
        throw new Error("表のセルの色は #rrggbb で指定してください");
    }
}

/** 比 `weights` で `length` を分けたときの各区切りの位置（先頭0・末尾length）。 */
export function tableEdges(weights: readonly number[], length: number) {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const edges = [0];
  let acc = 0;
  for (const weight of weights) {
    acc += weight;
    edges.push((acc / total) * length);
  }
  edges[edges.length - 1] = length;
  return edges;
}

export interface TableCellBox {
  row: number;
  column: number;
  x: number;
  y: number;
  width: number;
  height: number;
  cell: TableCell;
}

/** 描画用のセルの位置（ローカル座標）。 */
export function tableCellBoxes(
  shape: TableShape,
  width: number,
  height: number,
): TableCellBox[] {
  const xs = tableEdges(shape.columns, width);
  const ys = tableEdges(shape.rows, height);
  return shape.cells.flatMap((row, r) =>
    row.map((cell, c) => ({
      row: r,
      column: c,
      x: xs[c],
      y: ys[r],
      width: xs[c + 1] - xs[c],
      height: ys[r + 1] - ys[r],
      cell,
    })),
  );
}

function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  // 表計算ソフトからの貼付けは末尾に改行が付く。
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * タブ区切り（行は改行）の文字から、セルの文字の行列を作る。
 * 列の数は最も長い行に合わせ、足りないセルは空にする。
 */
export function parseTableText(text: string): string[][] {
  const grid = splitLines(text).map((line) => line.split("\t"));
  const columns = Math.max(...grid.map((row) => row.length));
  if (grid.length > TABLE_LIMITS.rows)
    throw new Error(`表の行は${TABLE_LIMITS.rows}行までです`);
  if (columns > TABLE_LIMITS.columns)
    throw new Error(`表の列は${TABLE_LIMITS.columns}列までです`);
  for (const row of grid)
    for (const cell of row)
      if (codePoints(cell) > TABLE_LIMITS.cellText)
        throw new Error(
          `表のセルの文字は${TABLE_LIMITS.cellText}文字以内にしてください`,
        );
  return grid.map((row) => [
    ...row,
    ...Array<string>(columns - row.length).fill(""),
  ]);
}

/**
 * セルの色の行列（タブ区切り）。空のセルは色なし。文字の表より大きい色の表は誤り。
 */
export function parseTableColors(
  text: string,
  rows: number,
  columns: number,
  label: string,
): (string | undefined)[][] {
  const lines = text.trim() === "" ? [] : splitLines(text);
  if (lines.length > rows)
    throw new Error(`${label}の行が表の行（${rows}行）より多くなっています`);
  const grid = lines.map((line) => line.split("\t"));
  if (grid.some((row) => row.length > columns))
    throw new Error(`${label}の列が表の列（${columns}列）より多くなっています`);
  return Array.from({ length: rows }, (_, r) =>
    Array.from({ length: columns }, (_, c) => {
      const token = (grid[r]?.[c] ?? "").trim();
      if (token === "") return undefined;
      if (!COLOR.test(token))
        throw new Error(
          `${label}の${r + 1}行${c + 1}列「${token}」は #rrggbb で書いてください`,
        );
      return token.toLowerCase();
    }),
  );
}

/**
 * 列幅・行の高さの比（カンマか空白で区切る）。空欄はすべて1。
 * 数が足りなければ1で補い、多ければ後ろを捨てる（行・列を減らしたとき）。
 */
export function parseTableWeights(
  text: string,
  count: number,
  label: string,
): number[] {
  const tokens = text
    .split(/[\s,、]+/)
    .map((token) => token.trim())
    .filter((token) => token !== "");
  const weights = tokens.map((token) => {
    const value = Number(token);
    if (
      !/^[+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(token) ||
      !Number.isFinite(value) ||
      value <= 0 ||
      value > TABLE_LIMITS.weight
    )
      throw new Error(
        `${label}「${token}」は0より大きく${TABLE_LIMITS.weight}以下の数にしてください`,
      );
    return value;
  });
  return Array.from({ length: count }, (_, i) => weights[i] ?? 1);
}

/** 入力欄用: セルの文字をタブ区切りにする。 */
export function formatTableText(shape: TableShape): string {
  const text = shape.cells
    .map((row) => row.map((cell) => cell.text).join("\t"))
    .join("\n");
  // 1列の表の最後の行が空だと末尾が改行になり、読み込みで貼付けの改行として
  // 捨てられる。改行を1つ足して、行の数を保つ。
  return shape.cells.length > 1 && text.endsWith("\n") ? `${text}\n` : text;
}

/** 入力欄用: セルの色をタブ区切りにする。色が1つもなければ空。 */
export function formatTableColors(
  shape: TableShape,
  key: "fill" | "color",
): string {
  if (!shape.cells.some((row) => row.some((cell) => cell[key]))) return "";
  const lines = shape.cells.map((row) =>
    row.map((cell) => cell[key] ?? "").join("\t"),
  );
  while (lines.length > 0 && /^\t*$/.test(lines[lines.length - 1])) lines.pop();
  return lines.map((line) => line.replace(/\t+$/, "")).join("\n");
}

export function formatTableWeights(weights: readonly number[]): string {
  return weights.every((weight) => weight === 1) ? "" : weights.join(", ");
}

/** 文字・色の行列から cells を組み立てる（色のない key は保存しない）。 */
export function buildTableCells(
  texts: string[][],
  fills: (string | undefined)[][],
  colors: (string | undefined)[][],
): TableCell[][] {
  return texts.map((row, r) =>
    row.map((text, c) => ({
      text,
      ...(fills[r]?.[c] ? { fill: fills[r][c] } : {}),
      ...(colors[r]?.[c] ? { color: colors[r][c] } : {}),
    })),
  );
}
