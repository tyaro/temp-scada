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
