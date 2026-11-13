import type {
  NumericFormat,
  TableCell,
  TableShape,
  TagBinding,
} from "./project";
import {
  MAX_FORMAT_DECIMALS,
  MAX_UNIT_LENGTH,
} from "./designer/forms/numeric-format";

/** 表の大きさの上限（schema と Rust の検査と同じ値）。 */
export const TABLE_LIMITS = {
  rows: 100,
  columns: 32,
  cellText: 256,
  weight: 1000,
  borderWidth: 32,
  externalName: 1024,
} as const;

const COLOR = /^#[0-9a-fA-F]{6}$/;
/** C0/C1 の制御文字と行・段落の区切り（schema の単位と同じ）。 */
function hasControl(text: string) {
  return [...text].some((char) => {
    const code = char.codePointAt(0)!;
    return (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029
    );
  });
}
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
      if (cell.binding !== undefined) {
        if (!/\S/.test(cell.binding.externalName))
          throw new Error("表のセルのタグの外部名を入れてください");
        if (!CELL_TEXT.test(cell.binding.externalName))
          throw new Error("表のセルのタグの外部名にタブ・改行は使えません");
      }
      if (cell.format !== undefined && cell.binding === undefined)
        throw new Error("表のセルの書式はタグのあるセルだけに付けられます");
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
 * 文字の表に重ねる行列（タブ区切り）を読む。空のセルは undefined。
 * 文字の表より大きい表は誤り。各セルは既定で trim してから `read` に渡す
 * （`keepSpaces` なら前後の空白を保つ。空白だけのセルは空として扱う）。
 */
function parseTableGrid<T>(
  text: string,
  rows: number,
  columns: number,
  label: string,
  read: (token: string, where: string) => T,
  keepSpaces = false,
): (T | undefined)[][] {
  const lines = text.trim() === "" ? [] : splitLines(text);
  if (lines.length > rows)
    throw new Error(`${label}の行が表の行（${rows}行）より多くなっています`);
  const grid = lines.map((line) => line.split("\t"));
  if (grid.some((row) => row.length > columns))
    throw new Error(`${label}の列が表の列（${columns}列）より多くなっています`);
  return Array.from({ length: rows }, (_, r) =>
    Array.from({ length: columns }, (_, c) => {
      const raw = grid[r]?.[c] ?? "";
      const token = keepSpaces ? raw : raw.trim();
      return raw.trim() === ""
        ? undefined
        : read(token, `${label}の${r + 1}行${c + 1}列「${token}」`);
    }),
  );
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
  return parseTableGrid(text, rows, columns, label, (token, where) => {
    if (!COLOR.test(token))
      throw new Error(`${where}は #rrggbb で書いてください`);
    return token.toLowerCase();
  });
}

/** セルのタグ（外部名）の行列。外部名は trim せずそのまま保つ。空白だけのセルは結合なし。 */
export function parseTableTags(
  text: string,
  rows: number,
  columns: number,
): (TagBinding | undefined)[][] {
  return parseTableGrid(
    text,
    rows,
    columns,
    "セルのタグ",
    (token, where) => {
      if (codePoints(token) > TABLE_LIMITS.externalName)
        throw new Error(
          `${where}は${TABLE_LIMITS.externalName}文字以内にしてください`,
        );
      return { externalName: token };
    },
    true,
  );
}

/**
 * セルの書式の行列。各セルは「小数桁;単位」。最初の `;` で分け、左が空なら
 * 小数桁なし（0〜6の整数のみ）、右が空なら単位なし。空のセルは書式なし。
 */
export function parseTableFormats(
  text: string,
  rows: number,
  columns: number,
): (NumericFormat | undefined)[][] {
  return parseTableGrid(text, rows, columns, "セルの書式", (token, where) => {
    const at = token.indexOf(";");
    if (at < 0)
      throw new Error(`${where}は「小数桁;単位」の形で書いてください`);
    const decimalsText = token.slice(0, at).trim();
    const unit = token.slice(at + 1).trim();
    const format: NumericFormat = {};
    if (decimalsText !== "") {
      const decimals = /^\d+$/.test(decimalsText) ? Number(decimalsText) : NaN;
      if (!(decimals <= MAX_FORMAT_DECIMALS))
        throw new Error(
          `${where}の小数桁は0〜${MAX_FORMAT_DECIMALS}の整数にしてください`,
        );
      format.decimals = decimals;
    }
    if (unit !== "") {
      if (codePoints(unit) > MAX_UNIT_LENGTH)
        throw new Error(
          `${where}の単位は${MAX_UNIT_LENGTH}文字以内にしてください`,
        );
      if (hasControl(unit))
        throw new Error(`${where}の単位に制御文字は使えません`);
      format.unit = unit;
    }
    return format;
  });
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
      !/^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(token) ||
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

/** 入力欄用: セルごとの文字をタブ区切りにし、末尾の空のセル・行を落とす。 */
function formatTableGrid(
  shape: TableShape,
  token: (cell: TableCell) => string,
): string {
  const lines = shape.cells.map((row) => row.map(token).join("\t"));
  while (lines.length > 0 && /^\t*$/.test(lines[lines.length - 1])) lines.pop();
  return lines.map((line) => line.replace(/\t+$/, "")).join("\n");
}

/** 入力欄用: セルの色をタブ区切りにする。色が1つもなければ空。 */
export function formatTableColors(
  shape: TableShape,
  key: "fill" | "color",
): string {
  return formatTableGrid(shape, (cell) => cell[key] ?? "");
}

/** 入力欄用: セルのタグ（外部名）をタブ区切りにする。 */
export function formatTableTags(shape: TableShape): string {
  return formatTableGrid(shape, (cell) => cell.binding?.externalName ?? "");
}

/** 入力欄用: セルの書式を「小数桁;単位」でタブ区切りにする。 */
export function formatTableFormats(shape: TableShape): string {
  return formatTableGrid(shape, (cell) =>
    cell.format === undefined
      ? ""
      : `${cell.format.decimals ?? ""};${cell.format.unit ?? ""}`,
  );
}

export function formatTableWeights(weights: readonly number[]): string {
  return weights.every((weight) => weight === 1) ? "" : weights.join(", ");
}

/**
 * 文字・色・タグ・書式の行列から cells を組み立てる（値のない key は保存しない）。
 * タグのないセルの書式は誤り。
 */
export function buildTableCells(
  texts: string[][],
  fills: (string | undefined)[][],
  colors: (string | undefined)[][],
  tags: (TagBinding | undefined)[][] = [],
  formats: (NumericFormat | undefined)[][] = [],
): TableCell[][] {
  return texts.map((row, r) =>
    row.map((text, c) => {
      const binding = tags[r]?.[c];
      const format = formats[r]?.[c];
      if (format && !binding)
        throw new Error(
          `セルの書式の${r + 1}行${c + 1}列はタグのないセルです。書式はタグのあるセルだけに付けてください`,
        );
      return {
        text,
        ...(fills[r]?.[c] ? { fill: fills[r][c] } : {}),
        ...(colors[r]?.[c] ? { color: colors[r][c] } : {}),
        ...(binding ? { binding } : {}),
        ...(format && Object.keys(format).length ? { format } : {}),
      };
    }),
  );
}

/** 表の結合したセルのタグ（行優先の順）。 */
export function tableCellBindings(shape: TableShape): TagBinding[] {
  return shape.cells.flatMap((row) =>
    row.flatMap((cell) => (cell.binding ? [cell.binding] : [])),
  );
}
