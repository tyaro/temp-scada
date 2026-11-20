/** Project の背景色から決める編集補助色。アプリのテーマには依存しない。 */
export function canvasColors(background: string) {
  const light =
    Number.parseInt(background.slice(1, 3), 16) * 0.2126 +
      Number.parseInt(background.slice(3, 5), 16) * 0.7152 +
      Number.parseInt(background.slice(5, 7), 16) * 0.0722 >
    150;
  return {
    grid: light ? "#475569" : "#94a3b8",
    selection: light ? "#2563eb" : "#fbbf24",
    newShape: light ? "#0f766e" : "#2dd4bf",
    newText: light ? "#0f172a" : "#2dd4bf",
  };
}

/** `#rrggbb`（`#rgb` も可）の WCAG 2 の相対輝度（0〜1）。 */
export function relativeLuminance(color: string): number {
  const hex =
    color.length === 4
      ? [...color.slice(1)].map((c) => c + c).join("")
      : color.slice(1, 7);
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/** WCAG 2 のコントラスト比（1〜21）。順序は問わない。 */
export function contrastRatio(a: string, b: string): number {
  const [high, low] = [relativeLuminance(a), relativeLuminance(b)].sort(
    (x, y) => y - x,
  );
  return (high + 0.05) / (low + 0.05);
}
