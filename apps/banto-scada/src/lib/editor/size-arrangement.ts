import { getBounds, type ScreenObject } from "../project";
import type { SelectionCommand } from "./commands";
/** Prepare every result before mutating any placement. Centers and rotations stay local. */
export function setSelectionSize(
  objects: ScreenObject[],
  command: Extract<SelectionCommand, { type: "set-size" }>,
): void {
  const { width, height } = command;
  if (width === undefined && height === undefined)
    throw new Error("統一する幅または高さを指定してください");
  for (const size of [width, height])
    if (
      size !== undefined &&
      (typeof size !== "number" || !Number.isFinite(size) || size <= 0)
    )
      throw new Error("幅・高さは0より大きい有限の数値で指定してください");
  const changes = objects.map((object) => {
    if (!("width" in object))
      throw new Error(
        "線・配管を含む選択には幅・高さを統一できません。対象を選び直してください",
      );
    const w = width ?? object.width,
      h = height ?? object.height;
    const next = {
      ...object,
      width: w,
      height: h,
      x:
        width === undefined || w === object.width
          ? object.x
          : object.x + (object.width - w) / 2,
      y:
        height === undefined || h === object.height
          ? object.y
          : object.y + (object.height - h) / 2,
    };
    // A finite result can still lose a small world center through catastrophic cancellation.
    for (const axis of ["x", "y"] as const) {
      const dimension = axis === "x" ? "width" : "height";
      const before = object[axis] + object[dimension] / 2,
        after = next[axis] + next[dimension] / 2;
      const tolerance = Math.max(
        1e-7,
        Number.EPSILON * Math.max(1, Math.abs(before)) * 8,
      );
      if (
        !Number.isFinite(before) ||
        !Number.isFinite(after) ||
        Math.abs(after - before) > tolerance
      )
        throw new Error(
          "指定したサイズでは配置の中心を保持できません。小さい寸法を指定してください",
        );
    }
    const bounds = getBounds(next);
    if (
      ![
        next.x,
        next.y,
        next.x + w / 2,
        next.y + h / 2,
        ...Object.values(bounds),
        next.x + bounds.x,
        next.y + bounds.y,
        next.x + bounds.x + bounds.width,
        next.y + bounds.y + bounds.height,
      ].every(Number.isFinite)
    )
      throw new Error("サイズ変更後の描画範囲が有限の範囲を超えています");
    return { object, next };
  });
  for (const { object, next } of changes)
    Object.assign(object, {
      x: next.x,
      y: next.y,
      width: next.width,
      height: next.height,
    });
}
