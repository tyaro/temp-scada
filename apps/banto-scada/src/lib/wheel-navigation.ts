/** WheelEvent units: pixels, lines (16 CSS px), or pages along the active axis. */
export function wheelPixels(delta: number, mode: number, page: number): number {
  if (!Number.isFinite(delta)) return 0;
  return delta * (mode === 1 ? 16 : mode === 2 ? page : 1);
}
/** Continuous, bounded zoom: 100 px upward is a 10% enlargement. */
export function wheelZoom(scale: number, delta: number): number {
  // Fit may be smaller than the manual minimum; zoom-out must not enlarge it.
  if (scale < 0.25 && delta >= 0) return scale;
  return Math.max(
    0.25,
    Math.min(
      4,
      scale *
        Math.exp((-Math.max(-600, Math.min(600, delta)) * Math.log(1.1)) / 100),
    ),
  );
}
