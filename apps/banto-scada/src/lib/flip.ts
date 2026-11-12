import type { ScreenObject } from "./project";
import { normalizeRotation } from "./rotation";

/** Text keeps reading direction and Trend keeps its axes; neither can be mirrored. */
export function canFlip(object: Pick<ScreenObject, "shape">): boolean {
  return (
    object.shape.type !== "text" &&
    object.shape.type !== "trend" &&
    object.shape.type !== "screenView"
  );
}

/** Saved form: the key exists only while true. */
export function setFlip(
  object: ScreenObject,
  key: "flipX" | "flipY",
  value: boolean,
): void {
  if (typeof value !== "boolean")
    throw new Error("反転はbooleanで指定してください");
  if (value && !canFlip(object))
    throw new Error("文字・トレンド・画面埋込は反転できません");
  if (value) object[key] = true;
  else delete object[key];
}

/**
 * Mirror on screen around each placement's pivot. With M = R(r)·F, a screen
 * mirror H gives H·R(r)·F = R(-r)·H·F, so the axis toggles and the angle negates.
 */
export function flipPlacements(objects: ScreenObject[], axis: "x" | "y"): void {
  if (axis !== "x" && axis !== "y") throw new Error("反転の向きが不正です");
  if (objects.some((object) => !canFlip(object)))
    throw new Error("文字・トレンド・画面埋込は反転できません");
  const key = axis === "x" ? "flipX" : "flipY";
  for (const object of objects) {
    setFlip(object, key, object[key] !== true);
    object.rotation = normalizeRotation(-object.rotation);
  }
}
