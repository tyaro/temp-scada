import type { ScreenObject } from "./project";

export type PaintAlphaChannel = "fill" | "stroke";
export type PaintAlphaPatch = Partial<Record<PaintAlphaChannel, number>>;

/** Shared by the inspector and the command; no partial selection is supported. */
export function paintAlphaTarget(
  objects: readonly ScreenObject[],
  channel: PaintAlphaChannel,
): { reason: string; common: number | null } {
  if (!objects.length)
    return { reason: "図形を選択してください", common: null };
  const values: number[] = [];
  for (const object of objects) {
    const shape = object.shape;
    if (shape.type !== "rectangle" && shape.type !== "ellipse")
      return {
        reason: "矩形・楕円だけを選択してください。一部だけの変更はしません。",
        common: null,
      };
    if (channel === "fill") {
      if (!shape.paint.fill.enabled || shape.paint.fill.paint.type !== "solid")
        return {
          reason: "全対象で単色塗りが有効な場合に変更できます。",
          common: null,
        };
      values.push(shape.paint.fill.paint.alpha);
    } else {
      if (!shape.paint.stroke)
        return {
          reason: "全対象に既存の枠線がある場合に変更できます。",
          common: null,
        };
      values.push(shape.paint.stroke.alpha ?? 1);
    }
  }
  return {
    reason: "",
    common: values.every((value) => value === values[0]) ? values[0] : null,
  };
}

export function setPaintAlpha(objects: ScreenObject[], patch: PaintAlphaPatch) {
  if (
    !patch ||
    typeof patch !== "object" ||
    Array.isArray(patch) ||
    Object.keys(patch).some((key) => key !== "fill" && key !== "stroke") ||
    (patch.fill === undefined && patch.stroke === undefined)
  )
    throw new Error("変更する塗り・枠線の不透明度を指定してください");
  for (const channel of ["fill", "stroke"] as const) {
    const value = patch[channel];
    if (value === undefined) continue;
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1
    )
      throw new Error(
        "塗り・枠線の不透明度は0〜100%の有限の数値で指定してください",
      );
    const target = paintAlphaTarget(objects, channel);
    if (target.reason) throw new Error(target.reason);
  }
  // Both channels and all placements are validated before the first mutation.
  for (const object of objects) {
    const shape = object.shape;
    if (shape.type !== "rectangle" && shape.type !== "ellipse") continue;
    if (
      patch.fill !== undefined &&
      shape.paint.fill.paint.type === "solid" &&
      shape.paint.fill.paint.alpha !== patch.fill
    )
      shape.paint.fill.paint.alpha = patch.fill;
    if (
      patch.stroke !== undefined &&
      shape.paint.stroke &&
      (shape.paint.stroke.alpha ?? 1) !== patch.stroke
    )
      shape.paint.stroke.alpha = patch.stroke;
  }
}
