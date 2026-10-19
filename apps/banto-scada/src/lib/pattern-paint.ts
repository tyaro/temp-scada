export type PatternKind = "hatch" | "crosshatch" | "dots";
/** One filled path per tile: crosshatch intersections receive foreground alpha only once. */
export function patternGeometry(
  kind: PatternKind,
  spacing: number,
  size: number,
) {
  if (!["hatch", "crosshatch", "dots"].includes(kind))
    throw new Error("パターンの種類を選択してください。");
  if (!Number.isFinite(spacing) || spacing < 2 || spacing > 1024)
    throw new Error("模様の間隔は2以上1024以下にしてください。");
  if (!Number.isFinite(size) || size <= 0 || size > Math.min(64, spacing / 2))
    throw new Error(
      "模様の太さは0より大きく、64と間隔の半分以下にしてください。",
    );
  const middle = spacing / 2,
    low = middle - size / 2,
    high = middle + size / 2;
  if (kind === "dots") {
    const radius = size / 2;
    return `M${low} ${middle}A${radius} ${radius} 0 1 0 ${high} ${middle}A${radius} ${radius} 0 1 0 ${low} ${middle}Z`;
  }
  const horizontal = `M0 ${low}H${spacing}V${high}H0Z`;
  return kind === "hatch"
    ? horizontal
    : `${horizontal}M${low} 0H${high}V${spacing}H${low}Z`;
}
