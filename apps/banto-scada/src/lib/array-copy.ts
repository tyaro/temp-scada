export interface ArrayCopySettings {
  columns: number;
  rows: number;
  stepX: number;
  stepY: number;
}
export const ARRAY_CELL_LIMIT = 100;
/** Counts include the original cell; step is a pitch, not a gap. */
export function validateArrayCopy(
  settings: ArrayCopySettings,
  sourceCount: number,
  existingCount: number,
  limit: number,
) {
  const { columns, rows, stepX, stepY } = settings;
  if (
    !Number.isInteger(columns) ||
    columns < 1 ||
    !Number.isInteger(rows) ||
    rows < 1 ||
    columns * rows < 2 ||
    columns * rows > ARRAY_CELL_LIMIT
  )
    throw new Error(
      "行数・列数は1以上の整数、合計は元の配置を含め2〜100組にしてください",
    );
  if (!Number.isFinite(stepX) || !Number.isFinite(stepY))
    throw new Error("配列の間隔は有限の数値にしてください");
  if ((columns > 1 && stepX === 0) || (rows > 1 && stepY === 0))
    throw new Error("複数並べる方向の間隔は0以外にしてください");
  const added = sourceCount * (columns * rows - 1);
  if (
    !Number.isSafeInteger(sourceCount) ||
    sourceCount < 1 ||
    !Number.isSafeInteger(added) ||
    existingCount + added > limit
  )
    throw new Error(
      `配列複製後の配置が上限${limit}件を超えます。行数・列数を減らしてください`,
    );
  if (
    !Number.isFinite(stepX * (columns - 1)) ||
    !Number.isFinite(stepY * (rows - 1))
  )
    throw new Error("配列の移動量が有限の範囲を超えています");
  return added;
}
