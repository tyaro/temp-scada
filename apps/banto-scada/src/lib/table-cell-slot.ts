import type { EquipmentSlot } from "./equipment";
import type { TableCell } from "./project";
import {
  slotPresentation,
  type SlotPresentation,
  type SlotStatus,
} from "./slot-presentation";
import { definedSlotState, slotStateText } from "./slot-state";
import { slotStateColor } from "./state-color";
import { formatSlotText } from "./tag-presentation";

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
