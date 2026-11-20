import type { EditCommand } from "../../editor";
import { isAreaShape, type ScreenObject, type ShapeLabel } from "../../project";
import {
  defaultShapeLabel,
  parseShapeLabel,
  SHAPE_LABEL_DEFAULT_STYLE,
} from "../../shape-label";
import { normalizeTextNewlines } from "../../text-content";
import { parseNumericProperty } from "../numeric-properties";

export interface ShapeLabelInput {
  data: Pick<FormData, "get">;
  objectId?: string;
  targetKey?: string;
}
export interface ShapeLabelContext {
  generation: number;
  screenId: string;
  definition: boolean;
  selected: ScreenObject | undefined;
  /** キャンバスの背景（`labelCanvasBackground`）。未指定の既定の文字色を確定時の塗りで決める。 */
  background: string;
}

/** フォームの基準値。label が無い間は新しく作るときの既定値を出す（#305 L2）。 */
export function shapeLabelFormValues(
  object: ScreenObject,
  background: string,
): Record<string, string> {
  const label: Omit<ShapeLabel, "text"> & { text?: string } =
    isAreaShape(object.shape) && object.shape.label
      ? object.shape.label
      : defaultShapeLabel(object, background);
  return {
    labelText: label.text ?? "",
    labelFontSize: String(label.style.fontSize),
    labelFontWeight: label.style.fontWeight,
    labelAlign: label.style.align,
    // 保存で wrap を省いた label は、折返しなし（Text と同じ解釈）。
    labelWrap:
      label.text === undefined
        ? SHAPE_LABEL_DEFAULT_STYLE.wrap
        : (label.style.wrap ?? "none"),
    labelColor: label.color.toLowerCase(),
    // label が無い間、色の欄を触っていなければ "1"。確定時の塗り・不透明度で既定の色を決め直す。
    labelColorAuto: label.text === undefined ? "1" : "",
  };
}

/** フォーム全体を読み、Project・履歴・draft を変えずにコマンドを作る（一括の事前検証でも使う）。 */
export function shapeLabelCommand(
  input: ShapeLabelInput,
  context: ShapeLabelContext,
): EditCommand {
  const { data } = input;
  const { selected } = context;
  if (
    !selected ||
    input.targetKey !==
      `${context.generation}:${context.screenId}:${context.definition}` ||
    selected.id !== input.objectId ||
    !isAreaShape(selected.shape)
  )
    throw new Error("文字の適用先が変更されています。選択し直してください。");
  const text = normalizeTextNewlines(String(data.get("labelText") ?? ""));
  const update = (label: ShapeLabel | null): EditCommand => ({
    type: "update",
    screenId: context.screenId,
    objectId: selected.id,
    patch: { label },
  });
  // 文言を空にして確定すると label を消す（書式の欄は見ない）。
  if (!text) return update(null);
  let fontSize: number;
  try {
    fontSize = parseNumericProperty(String(data.get("labelFontSize") ?? ""));
  } catch {
    throw new Error("文字サイズは0より大きく512以下にしてください");
  }
  const saved = selected.shape.label;
  const wrap = String(data.get("labelWrap") ?? "");
  return update(
    parseShapeLabel({
      text,
      style: {
        fontSize,
        fontWeight: String(data.get("labelFontWeight") ?? ""),
        align: String(data.get("labelAlign") ?? ""),
        // 保存で wrap を省いた label は、欄が「折返しなし」のままなら省いたまま保つ。
        ...(saved && saved.style.wrap === undefined && wrap === "none"
          ? {}
          : { wrap }),
      },
      // 新しく作る label で色の欄を触っていなければ、確定時の塗りで既定の色を選ぶ（塗りと一括適用したとき、
      // 旧い塗り向けの色を残さない）。色の欄は小文字で返すので、大文字の hex で保存された同じ色は保存のまま保つ。
      color:
        !saved && data.get("labelColorAuto") === "1"
          ? defaultShapeLabel(selected, context.background).color
          : ((color) =>
              saved && saved.color.toLowerCase() === color.toLowerCase()
                ? saved.color
                : color)(String(data.get("labelColor") ?? "")),
    }),
  );
}
