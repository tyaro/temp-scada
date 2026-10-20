import type { LayerFolder } from "./project";
export type FolderDirection = "up" | "down";
/** A folder's tree order is independent of placement paint order and parent membership. */
export function folderNeighbour(
  folders: readonly LayerFolder[],
  id: string,
  direction: FolderDirection,
) {
  if (direction !== "up" && direction !== "down")
    throw new Error("フォルダーの並べ替え方向が不正です。");
  const folder = folders.find((folder) => folder.id === id);
  if (!folder) throw new Error("フォルダーが見つかりません");
  const siblings = folders
    .filter((item) => item.parentId === folder.parentId)
    .sort((a, b) => a.order - b.order);
  const index = siblings.findIndex((item) => item.id === id);
  return siblings[index + (direction === "up" ? -1 : 1)];
}
