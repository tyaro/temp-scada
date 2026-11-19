import type { EquipmentSlot } from "./equipment";
import type { TableCell } from "./project";
import {
  slotPresentation,
  type SlotPresentation,
  type SlotStatus,
} from "./slot-presentation";
import {
  definedSlotState,
  slotStateText,
  type SlotStateEvaluation,
} from "./slot-state";
import { slotStateColor } from "./state-color";
import { presentScreenBool } from "./screen-bool-display";
import {
  formatSlotText,
  presentNumeric,
  type TagReadings,
} from "./tag-presentation";

/** 表のセルが読む slot の読取と、機器種別の slot の定義（なければ undefined）。 */
export interface ResolvedTableSlot {
  display: SlotPresentation;
  slot?: EquipmentSlot;
}
/** slot 名から読取と定義を返す（Symbol 配置ごとに ObjectPainting が作る）。 */
export type TableSlotResolver = (slotName: string) => ResolvedTableSlot;

export interface TableCellSlotView {
  slotName: string;
  text: string;
  /** 読取の状態（定義された状態が不明ならその理由）。 */
  state: SlotStatus;
  label: string;
  /** 状態の色（`stateColors` のあるセルだけ）。undefined は通常の色。 */
  stateColor?: string;
}

/**
 * slot に結合した表のセルの表示。slot に結合した Text と同じ規則で、
 * 機器種別の slot に状態の定義があり、既知（または Good でも状態にできない）なら
 * 状態の文字、それ以外は書式付きの読取の文字。`stateColors` のあるセルは
 * Text の状態の色と同じ規則で色を決める。
 */
export function tableCellSlotView(
  cell: TableCell,
  resolve?: TableSlotResolver,
): TableCellSlotView | undefined {
  const slotName = cell.slotBinding?.slotName;
  if (slotName === undefined) return undefined;
  const { display, slot } = resolve?.(slotName) ?? {
    display: slotPresentation("unbound"),
  };
  const evaluation = definedSlotState(slot, display);
  const defined =
    evaluation && (evaluation.state === "known" || display.state === "good")
      ? evaluation
      : undefined;
  return {
    slotName,
    text: defined
      ? slotStateText(defined)
      : formatSlotText(display, cell.format),
    state: defined?.state === "unknown" ? defined.reason : display.state,
    label:
      defined?.state === "known" && defined.none
        ? "未割付（なしとして表示）"
        : defined?.state === "unknown"
          ? slotPresentation(defined.reason).label
          : display.label,
    stateColor: cell.stateColors
      ? slotStateColor(cell.stateColors.unknownColor, slot, display)
      : undefined,
  };
}

/** 表のセル 1 つの描画（文字・文字色・塗り・属性）。 */
export interface TableCellView {
  text: string;
  /** `data-table-cell-state`（結合のないセルは undefined）。 */
  state?: string;
  /** ツールチップ（結合のないセルは undefined）。 */
  title?: string;
  textFill: string;
  /** セルの塗り（undefined は塗らない）。 */
  rectFill?: string;
  /** 状態の色の使い先が塗りのセル（`data-table-cell-state-fill`）。 */
  stateFill: boolean;
}

export interface TableCellContext {
  readings?: TagReadings;
  slots?: TableSlotResolver;
  /** セルに文字色がないときの色（配置の色）。 */
  textColor: string;
  /** 単色の Symbol 配置の色（文字だけに効き、塗りは変えない）。 */
  color?: string;
}

/**
 * 表のセルの描画。slot のセルは `tableCellSlotView`、`boolDisplay` のある
 * 画面の表のセルは画面直下の Text と同じ `presentScreenBool`、ほかのタグの
 * セルは書式付きの読取。状態の色は `stateTarget` が `"fill"` なら塗りへ
 * （文字色は状態に関わらず固定、既知で色のない状態はセルの塗りに戻す）、
 * それ以外は文字色へ使う。
 */
export function tableCellView(
  cell: TableCell,
  context: TableCellContext,
): TableCellView {
  const binding = cell.binding;
  const reading = binding
    ? context.readings?.get(binding.externalName)
    : undefined;
  const presentation = binding
    ? presentNumeric(reading, cell.format)
    : undefined;
  const screenBool =
    binding && cell.boolDisplay
      ? presentScreenBool(cell.boolDisplay, reading)
      : undefined;
  const slotView = tableCellSlotView(cell, context.slots);
  const stateful = Boolean(screenBool || (slotView && cell.stateColors));
  const stateColor = screenBool ? screenBool.color : slotView?.stateColor;
  const stateFill = stateful && cell.stateTarget === "fill";
  const normalText = context.color ?? cell.color ?? context.textColor;
  return {
    text: slotView?.text ?? screenBool?.text ?? presentation?.text ?? cell.text,
    state:
      slotView?.state ??
      (screenBool
        ? screenBool.evaluation.state === "known"
          ? String(reading?.state === "resolved" && reading.boolValue)
          : screenBool.evaluation.reason
        : presentation?.state),
    title: slotView
      ? `${slotView.slotName} · ${slotView.label}`
      : binding && presentation
        ? `${binding.externalName} · ${
            screenBool?.evaluation.state === "unknown"
              ? screenBoolUnknownLabel(screenBool.evaluation.reason)
              : presentation.label
          }`
        : undefined,
    textFill: stateFill ? normalText : (stateColor ?? normalText),
    rectFill: stateFill ? (stateColor ?? cell.fill) : cell.fill,
    stateFill,
  };
}

/**
 * bool の表示のセルが取得不能のときのツールチップの状態名。読取が Good の
 * 数値タグでも「Good」と出さず、表示の文字（`-- · 型不一致`）と揃える。
 */
function screenBoolUnknownLabel(
  reason: Extract<SlotStateEvaluation, { state: "unknown" }>["reason"],
): string {
  return reason === "typeMismatch"
    ? "型不一致"
    : slotPresentation(reason).label;
}
