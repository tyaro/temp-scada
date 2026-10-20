import { selectionUnits, unitBounds } from "../geometric-groups";
import type { Screen, SymbolDefinition } from "../project";

/** Keep normalized width sums accurate for large selections, including zero gaps. */
function accumulator() {
  let sum = 0,
    error = 0;
  return (value: number) => {
    const corrected = value - error;
    const next = sum + corrected;
    error = next - sum - corrected;
    sum = next;
    return sum;
  };
}

/** Geometry only: fixed endpoints, stable center order, whole groups as units. */
export function distributeGaps(
  owner: Screen | SymbolDefinition,
  ids: readonly string[],
  axis: "x" | "y",
): "finish" | "unchanged" {
  if (axis !== "x" && axis !== "y")
    throw new Error("隙間を均等化する方向が不正です");
  const dimension = axis === "x" ? "width" : "height";
  const entries = selectionUnits(owner, ids).map((objects) => {
    const bounds = unitBounds(objects);
    return { objects, bounds, center: bounds[axis] + bounds[dimension] / 2 };
  });
  if (entries.length < 3)
    throw new Error("隙間を均等化する単位を3件以上選択してください");
  if (entries.some((entry) => !Number.isFinite(entry.center)))
    throw new Error("配置の中心は有限の座標にしてください");
  // selectionUnits already uses draw order. Stable sort retains it when centers tie.
  entries.sort((a, b) => a.center - b.center);
  const first = entries[0],
    last = entries.at(-1)!;
  const scale = entries.reduce(
    (value, entry) =>
      Math.max(
        value,
        Math.abs(entry.bounds[axis]),
        Math.abs(entry.bounds[axis] + entry.bounds[dimension]),
        entry.bounds[dimension],
      ),
    1,
  );
  const start = first.bounds[axis] / scale,
    end = (last.bounds[axis] + last.bounds[dimension]) / scale;
  const addTotal = accumulator();
  const total = entries.reduce(
    (_, entry) => addTotal(entry.bounds[dimension] / scale),
    0,
  );
  const available = end - start - total;
  const tolerance =
    Number.EPSILON * Math.max(1, Math.abs(start), Math.abs(end), total) * 8;
  if (available < -tolerance)
    throw new Error(
      "両端の間に収まりません。図形を広げてから隙間を均等化してください",
    );
  const gap = Math.max(0, available) / (entries.length - 1);
  const addPrefix = accumulator();
  let prefix = addPrefix(first.bounds[dimension] / scale),
    changed = false;
  for (let index = 1; index < entries.length - 1; index++) {
    const entry = entries[index],
      target = (start + prefix + gap * index) * scale;
    const delta = target - entry.bounds[axis];
    if (!Number.isFinite(target) || !Number.isFinite(delta))
      throw new Error("均等化後の位置は有限の座標にしてください");
    if (
      Math.abs(delta) >
      Number.EPSILON *
        Math.max(1, Math.abs(target), Math.abs(entry.bounds[axis])) *
        8
    ) {
      for (const object of entry.objects) object[axis] += delta;
      changed = true;
    }
    prefix = addPrefix(entry.bounds[dimension] / scale);
  }
  return changed ? "finish" : "unchanged";
}
