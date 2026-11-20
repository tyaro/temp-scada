import { canvasColors } from "./canvas-colors";
import { normalizeTextNewlines } from "./text-content";
import {
  isAreaShape,
  type Screen,
  type ScreenObject,
  type ShapeLabel,
  type ShapePaint,
  type SymbolDefinition,
  type TextStyle,
} from "./project";

/** 面の図形の文字（#305 L2）を Inspector で新しく作るときの書式の既定。wrap は省かずに保存する。 */
export const SHAPE_LABEL_DEFAULT_STYLE: Required<TextStyle> = {
  fontSize: 16,
  fontWeight: "normal",
  align: "center",
  wrap: "word",
};
/** 文字色の候補（明るい色・暗い色）。同じコントラスト比なら暗い色。 */
export const SHAPE_LABEL_LIGHT = "#ffffff";
export const SHAPE_LABEL_DARK = "#0f172a";
/** Symbol 定義の編集キャンバスの背景（Text の挿入と同じ）。 */
export const SYMBOL_DEFINITION_BACKGROUND = "#0b1220";
export const SHAPE_LABEL_MAX_LENGTH = 1000;

type Rgb = [number, number, number];
const rgb = (hex: string): Rgb => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
];
const channel = (value: number) => {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
/** WCAG 2 の相対輝度。成分は 0〜255 の実数でよい（重ねた色を丸めない）。 */
export const relativeLuminance = ([r, g, b]: Rgb) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const ratio = (a: number, b: number) =>
  (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** 輝度 `luminance` の色に対して、白と暗い色のうちコントラスト比が大きい方。同じ比なら暗い色。 */
export function labelColorForLuminance(luminance: number): string {
  const light = ratio(luminance, relativeLuminance(rgb(SHAPE_LABEL_LIGHT)));
  const dark = ratio(luminance, relativeLuminance(rgb(SHAPE_LABEL_DARK)));
  return light - dark > 1e-9 ? SHAPE_LABEL_LIGHT : SHAPE_LABEL_DARK;
}

/**
 * 新しく作る label の文字色の既定。塗りが有効な単色なら、塗りの色を α（塗りの α × 配置の
 * opacity）でキャンバスの背景に重ねた色に対して選ぶ。背後の別の配置は見ない。
 * それ以外（塗り無し・グラデーション・模様）は Text の挿入と同じ `canvasColors(背景).newText`。
 */
export function defaultShapeLabelColor(
  paint: ShapePaint,
  opacity: number | undefined,
  background: string,
): string {
  const fill = paint.fill.paint;
  if (!paint.fill.enabled || fill.type !== "solid")
    return canvasColors(background).newText;
  const alpha = fill.alpha * (opacity ?? 1);
  const front = rgb(fill.color),
    back = rgb(background);
  const seen = front.map((c, i) => c * alpha + back[i] * (1 - alpha)) as Rgb;
  return labelColorForLuminance(relativeLuminance(seen));
}

/** 画面なら画面の背景色、Symbol 定義なら定義の編集キャンバスの背景。 */
export const labelCanvasBackground = (owner: Screen | SymbolDefinition) =>
  "background" in owner ? owner.background : SYMBOL_DEFINITION_BACKGROUND;

/** label が無い配置に既定値の label を作るときの値（文言以外）。 */
export function defaultShapeLabel(
  object: ScreenObject,
  background: string,
): Omit<ShapeLabel, "text"> {
  const paint = isAreaShape(object.shape) ? object.shape.paint : undefined;
  return {
    style: { ...SHAPE_LABEL_DEFAULT_STYLE },
    color: paint
      ? defaultShapeLabelColor(paint, object.opacity, background)
      : canvasColors(background).newText,
  };
}

/**
 * 保存契約（project.schema.json の shapeLabel）と同じ検査を、日本語の理由つきで行う。
 * 文言は改行を正規化して返す。
 */
export function parseShapeLabel(value: unknown): ShapeLabel {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("図形の文字の値が不正です");
  const { text, style, color, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length)
    throw new Error("図形の文字に未知の項目があります");
  if (typeof text !== "string") throw new Error("文言を入力してください");
  const normalized = normalizeTextNewlines(text);
  if (!normalized) throw new Error("文言を入力してください");
  if ([...normalized].length > SHAPE_LABEL_MAX_LENGTH)
    throw new Error(`文言は${SHAPE_LABEL_MAX_LENGTH}文字以内にしてください`);
  if (!style || typeof style !== "object" || Array.isArray(style))
    throw new Error("文字の書式が不正です");
  const { fontSize, fontWeight, align, wrap, ...extra } = style as Record<
    string,
    unknown
  >;
  if (Object.keys(extra).length)
    throw new Error("文字の書式に未知の項目があります");
  if (
    typeof fontSize !== "number" ||
    !Number.isFinite(fontSize) ||
    fontSize <= 0 ||
    fontSize > 512
  )
    throw new Error("文字サイズは0より大きく512以下にしてください");
  if (fontWeight !== "normal" && fontWeight !== "bold")
    throw new Error("文字の太さを選択してください");
  if (align !== "left" && align !== "center" && align !== "right")
    throw new Error("文字揃えを選択してください");
  if (wrap !== undefined && wrap !== "none" && wrap !== "word")
    throw new Error("折返しを選択してください");
  if (typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color))
    throw new Error("文字色は#RRGGBBで指定してください");
  return {
    text: normalized,
    style: { fontSize, fontWeight, align, ...(wrap ? { wrap } : {}) },
    color,
  };
}
