import type {
  EquipmentSlot,
  SlotStateDisplay,
  SlotStateLabel,
} from "./equipment";

/** Editing helpers for the state definitions of an equipment-type slot (A4). */

export const STATE_ROW_LIMIT = 64;
const WORD_MIN = -2147483648;
const WORD_MAX = 4294967295;
const COLOR = /^#[0-9a-fA-F]{6}$/;
// Line and paragraph separators are built from codes so the source stays one line.
const LINE_BREAK = new RegExp(
  "[\r\n" + String.fromCharCode(0x2028, 0x2029) + "]",
);
/** Colors offered in turn when a row is added. */
const ROW_COLORS = ["#16a34a", "#dc2626", "#f59e0b", "#2563eb", "#9333ea"];
export const NONE_COLOR = "#64748b";

export function emptyStateDisplay(): SlotStateDisplay {
  return {
    source: "value",
    rows: [],
    otherwise: { text: "", color: NONE_COLOR },
  };
}

export function defaultBoolDisplay(): NonNullable<
  EquipmentSlot["boolDisplay"]
> {
  return {
    true: { text: "運転", color: "#16a34a" },
    false: { text: "停止", color: NONE_COLOR },
  };
}

/**
 * A typical motor definition, so a new state slot starts from something
 * readable. With bits the fault row comes first because the top row wins.
 */
export function exampleStateDisplay(
  source: SlotStateDisplay["source"],
): SlotStateDisplay {
  return source === "bits"
    ? {
        source,
        rows: [
          { match: 2, text: "故障", color: "#dc2626" },
          { match: 0, text: "運転", color: "#16a34a" },
        ],
        otherwise: { text: "停止", color: NONE_COLOR },
      }
    : {
        source,
        rows: [
          { match: 0, text: "停止", color: NONE_COLOR },
          { match: 1, text: "運転", color: "#16a34a" },
          { match: 2, text: "故障", color: "#dc2626" },
        ],
        otherwise: { text: "不明", color: "#f59e0b" },
      };
}

/** The next unused value (one past the largest) or the lowest unused bit. */
export function nextMatch(display: SlotStateDisplay): number | undefined {
  const used = new Set(
    display.rows.map((row) => row.match).filter(Number.isInteger),
  );
  if (display.source === "bits") {
    for (let bit = 0; bit <= 31; bit++) if (!used.has(bit)) return bit;
    return undefined;
  }
  if (!used.size) return 0;
  const next = Math.max(...used) + 1;
  return next <= WORD_MAX ? next : undefined;
}

export function addStateRow(display: SlotStateDisplay): SlotStateDisplay {
  const match = nextMatch(display);
  if (match === undefined || display.rows.length >= STATE_ROW_LIMIT)
    return display;
  const color = ROW_COLORS[display.rows.length % ROW_COLORS.length];
  return { ...display, rows: [...display.rows, { match, text: "", color }] };
}

export function moveStateRow(
  display: SlotStateDisplay,
  index: number,
  offset: -1 | 1,
): SlotStateDisplay {
  const target = index + offset;
  if (target < 0 || target >= display.rows.length) return display;
  const rows = [...display.rows];
  [rows[index], rows[target]] = [rows[target], rows[index]];
  return { ...display, rows };
}

export function labelProblem(label: SlotStateLabel): string | undefined {
  if (typeof label.text !== "string" || label.text.length > 64)
    return "文字は64文字以内にしてください";
  if (LINE_BREAK.test(label.text)) return "文字に改行は入れられません";
  if (typeof label.color !== "string" || !COLOR.test(label.color))
    return "色は#rrggbbで指定してください";
  return undefined;
}

/** The problem of one row, in the words shown next to it. */
export function stateRowProblem(
  display: SlotStateDisplay,
  index: number,
): string | undefined {
  const row = display.rows[index];
  if (typeof row.match !== "number" || !Number.isInteger(row.match))
    return display.source === "bits"
      ? "ビットは0〜31の整数で入れてください"
      : "値は整数で入れてください";
  if (display.source === "bits" && (row.match < 0 || row.match > 31))
    return "ビットは0〜31です";
  if (row.match < WORD_MIN || row.match > WORD_MAX)
    return `値は${WORD_MIN}〜${WORD_MAX}です`;
  if (display.rows.findIndex((other) => other.match === row.match) !== index)
    return display.source === "bits"
      ? "同じビットの行が上にあります"
      : "同じ値の行が上にあります";
  return labelProblem(row);
}

/** The first problem of a slot's display definitions, prefixed with where it is. */
export function slotDisplayError(slot: EquipmentSlot): string | undefined {
  if (slot.boolDisplay) {
    for (const key of ["true", "false"] as const) {
      const problem = labelProblem(slot.boolDisplay[key]);
      if (problem) return `${slot.name}の${key}: ${problem}`;
    }
  }
  const display = slot.stateDisplay;
  if (!display) return undefined;
  if (display.rows.length > STATE_ROW_LIMIT)
    return `${slot.name}: 状態の行は${STATE_ROW_LIMIT}件以下にしてください`;
  for (let index = 0; index < display.rows.length; index++) {
    const problem = stateRowProblem(display, index);
    if (problem) return `${slot.name}の行${index + 1}: ${problem}`;
  }
  const problem = labelProblem(display.otherwise);
  return problem ? `${slot.name}の該当なし: ${problem}` : undefined;
}
