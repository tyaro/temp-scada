import type { Project } from "./project";
export interface SymbolUsage {
  name?: string;
  symbolId: string;
  screenId: string;
  screenName: string;
  objectId: string;
  order: number;
  x: number;
  y: number;
}
/** 保存しない参照一覧。画面順と配置の重なり順で、完全一致の定義 ID を探す。 */
export function symbolUsages(
  project: Project,
  symbolId: string,
): SymbolUsage[] {
  return project.screens.flatMap((screen) =>
    [...screen.objects]
      .sort((a, b) => a.order - b.order)
      .filter(
        (object) =>
          object.shape.type === "symbol" && object.shape.symbolId === symbolId,
      )
      .map((object) => ({
        ...(object.name ? { name: object.name } : {}),
        symbolId,
        screenId: screen.id,
        screenName: screen.name,
        objectId: object.id,
        order: object.order,
        x: object.x,
        y: object.y,
      })),
  );
}
