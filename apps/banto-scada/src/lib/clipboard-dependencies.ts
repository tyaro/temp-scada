import type { Project, ScreenObject } from "./project";

/** The Project validator still owns embedding depth/cycles. This only collects a closure. */
export function clipboardDependencies(
  project: Project,
  objects: readonly ScreenObject[],
) {
  const screens = new Set<string>(),
    symbols = new Set<string>(),
    assets = new Set<string>();
  function placements(items: readonly ScreenObject[]) {
    for (const { shape } of items) {
      if (shape.type === "image") assets.add(shape.assetId);
      if (shape.type === "symbol" && !symbols.has(shape.symbolId)) {
        symbols.add(shape.symbolId);
        const definition = project.symbols.find(
          (symbol) => symbol.id === shape.symbolId,
        );
        if (!definition) throw new Error("Symbolの参照先が見つかりません。");
        placements(definition.objects);
      }
      if (shape.type === "screenView" && !screens.has(shape.screenId)) {
        screens.add(shape.screenId);
        const source = project.screens.find(
          (screen) => screen.id === shape.screenId,
        );
        if (!source) throw new Error("埋込画面の参照先が見つかりません。");
        if (source.backgroundImage) assets.add(source.backgroundImage.assetId);
        placements(source.objects);
      }
    }
  }
  placements(objects);
  return { screens, symbols, assets };
}
