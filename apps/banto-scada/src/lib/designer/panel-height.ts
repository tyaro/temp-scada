export const DEFAULT_REFERENCE_HEIGHT = 240;
export const MIN_REFERENCE_HEIGHT = 160;
export const MAX_REFERENCE_HEIGHT = 400;
export function parseReferenceHeight(value: string | null | undefined): number {
  if (value == null || !/^\d+$/.test(value)) return DEFAULT_REFERENCE_HEIGHT;
  const height = Number(value);
  return Number.isInteger(height) &&
    height >= MIN_REFERENCE_HEIGHT &&
    height <= MAX_REFERENCE_HEIGHT
    ? height
    : DEFAULT_REFERENCE_HEIGHT;
}
/** Keep at least 340px for the canvas, status and spacing; at most 40% for references. */
export function referenceHeightMaximum(available: number): number {
  return Math.max(
    MIN_REFERENCE_HEIGHT,
    Math.min(
      MAX_REFERENCE_HEIGHT,
      Math.floor(available * 0.4),
      Math.floor(available - 340),
    ),
  );
}
