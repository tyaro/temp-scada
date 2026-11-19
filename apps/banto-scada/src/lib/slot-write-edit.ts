import type { EquipmentSlot, SlotType, SlotWrite } from "./equipment";

/** Editing helpers for the operation (`write`) of an equipment-type slot (O1b). */

export const WRITE_BUTTON_LIMIT = 4;
export const WRITE_LABEL_MAX = 40;
export const WRITE_BUTTON_LABEL_MAX = 12;
const STATE_MAX = 2147483647;
// Same rule as the schema's slotWriteLabel: no surrounding space, no control
// characters or line/paragraph separators. Built from codes to stay one line.
const EDGE_SPACE = new RegExp(
  "^[\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000\\ufeff]|[\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000\\ufeff]$",
);
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]");
/** Half-width decimal only: optional "-", digits, optional fraction (§3). */
const DECIMAL = /^-?\d+(\.\d+)?$/;

/** A start that reads as an example and is valid as it is. */
export function defaultSlotWrite(type: SlotType): SlotWrite {
  if (type === "bool")
    return {
      label: "操作",
      buttons: [
        { label: "入", value: true },
        { label: "切", value: false },
      ],
    };
  if (type === "number") return { label: "設定", input: { min: 0, max: 100 } };
  return { label: "選択", buttons: [{ label: "0", value: 0 }] };
}

/** A typed number: the decimal it spells, or NaN while it is not one yet. */
export function parseWriteNumber(text: string): number {
  return DECIMAL.test(text) ? Number(text) : Number.NaN;
}

/** The next value a new button gets: the other bool, or one past the largest. */
export function nextButtonValue(
  type: SlotType,
  write: SlotWrite,
): boolean | number {
  const values = (write.buttons ?? []).map((button) => button.value);
  if (type === "bool") return !values.includes(true);
  const numbers = values.filter(
    (value): value is number => typeof value === "number" && isFinite(value),
  );
  const next = numbers.length ? Math.floor(Math.max(...numbers)) + 1 : 0;
  return type === "state" ? Math.min(Math.max(next, 0), STATE_MAX) : next;
}

export function writeLabelProblem(
  text: string,
  max: number,
): string | undefined {
  if (!text) return "見出しを入れてください";
  // The schema limit counts code points, not UTF-16 units.
  if ([...text].length > max) return `見出しは${max}文字以内にしてください`;
  if (EDGE_SPACE.test(text)) return "見出しの前後に空白は入れられません";
  if (CONTROL.test(text)) return "見出しに改行や制御文字は入れられません";
  return undefined;
}

export function buttonValueProblem(
  type: SlotType,
  value: unknown,
): string | undefined {
  if (type === "bool")
    return typeof value === "boolean" ? undefined : "値は true か false です";
  if (typeof value !== "number" || !isFinite(value))
    return type === "state"
      ? "値は整数で入れてください"
      : "値は半角の数で入れてください";
  if (
    type === "state" &&
    (!Number.isInteger(value) || value < 0 || value > STATE_MAX)
  )
    return `値は0〜${STATE_MAX}の整数です`;
  return undefined;
}

/** The first problem of a slot's operation, without the slot name. */
export function slotWriteProblem(
  type: SlotType,
  write: SlotWrite,
): string | undefined {
  const label = writeLabelProblem(write.label, WRITE_LABEL_MAX);
  if (label) return label;
  const buttons = write.buttons ?? [];
  if (!write.input && !buttons.length)
    return "ボタンか数値の入力を1つ以上置いてください";
  if (buttons.length > WRITE_BUTTON_LIMIT)
    return `ボタンは${WRITE_BUTTON_LIMIT}個以下にしてください`;
  for (const [index, button] of buttons.entries()) {
    const problem =
      writeLabelProblem(button.label, WRITE_BUTTON_LABEL_MAX) ??
      buttonValueProblem(type, button.value);
    if (problem) return `ボタン${index + 1}: ${problem}`;
    if (buttons.findIndex((other) => other.value === button.value) !== index)
      return `ボタン${index + 1}: 同じ値のボタンが上にあります`;
  }
  if (write.input) {
    if (type !== "number") return "数値の入力は number の slot だけです";
    const { min, max } = write.input;
    if (!isFinite(min) || !isFinite(max))
      return "入力の下限と上限は半角の数で入れてください";
    if (min > max) return "入力の下限が上限より大きいです";
  }
  return undefined;
}

/** The first problem of a slot's operation, prefixed with where it is. */
export function slotWriteError(slot: EquipmentSlot): string | undefined {
  if (!slot.write) return undefined;
  const problem = slotWriteProblem(slot.type, slot.write);
  return problem ? `${slot.name}の操作: ${problem}` : undefined;
}
