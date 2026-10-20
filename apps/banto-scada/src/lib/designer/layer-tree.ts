import {
  MAX_FOLDER_DEPTH,
  type LayerFolder,
  type ScreenObject,
  type GeometricGroup,
} from "../project";
type Owner = {
  folders: LayerFolder[];
  objects: ScreenObject[];
  groups?: GeometricGroup[];
};
export type LayerRow =
  | { kind: "folder"; folder: LayerFolder; depth: number; open: boolean }
  | {
      kind: "object";
      object: ScreenObject;
      depth: number;
      group?: GeometricGroup;
    };
export function folderAncestors(
  folders: LayerFolder[],
  id?: string,
): LayerFolder[] {
  const path: LayerFolder[] = [];
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  while (id) {
    const folder = byId.get(id);
    if (!folder || path.some((item) => item.id === id)) break;
    path.unshift(folder);
    id = folder.parentId;
  }
  return path;
}
export function folderPath(folders: LayerFolder[], id?: string): string {
  return folderAncestors(folders, id)
    .map((folder) => folder.name)
    .join(" / ");
}
export function layerTree(
  owner: Owner,
  query: string,
  closed: ReadonlySet<string>,
  label: (object: ScreenObject) => string,
) {
  const normalized = query.trim().toLocaleLowerCase();
  const objects = [...owner.objects].sort((a, b) => a.order - b.order);
  const folders = [...owner.folders].sort((a, b) => a.order - b.order);
  const matchingObjects = objects.filter(
    (object) =>
      !normalized ||
      `${label(object)} ${folderPath(folders, object.folderId)} ${owner.groups?.find((group) => group.memberIds.includes(object.id))?.name ?? ""}`
        .toLocaleLowerCase()
        .includes(normalized),
  );
  for (const group of owner.groups ?? [])
    if (matchingObjects.some((object) => group.memberIds.includes(object.id)))
      for (const object of objects)
        if (
          group.memberIds.includes(object.id) &&
          !matchingObjects.includes(object)
        )
          matchingObjects.push(object);
  matchingObjects.sort((a, b) => a.order - b.order);
  const included = new Set<string>();
  function include(id?: string) {
    for (const folder of folderAncestors(folders, id)) included.add(folder.id);
  }
  for (const object of matchingObjects) include(object.folderId);
  for (const folder of folders)
    if (
      !normalized ||
      folderPath(folders, folder.id).toLocaleLowerCase().includes(normalized)
    )
      include(folder.id);
  const rows: LayerRow[] = [];
  function visit(parentId: string | undefined, depth: number) {
    for (const folder of folders.filter(
      (folder) => folder.parentId === parentId && included.has(folder.id),
    )) {
      const open = !!normalized || !closed.has(folder.id);
      rows.push({ kind: "folder", folder, depth, open });
      if (open) visit(folder.id, depth + 1);
    }
    for (const object of matchingObjects.filter(
      (object) => object.folderId === parentId,
    )) {
      const group = owner.groups?.find((group) =>
        group.memberIds.includes(object.id),
      );
      if (group && object.id !== group.memberIds[0]) continue;
      rows.push({ kind: "object", object, depth, ...(group ? { group } : {}) });
    }
  }
  visit(undefined, 0);
  return { rows, matchingObjects };
}
export function folderDestinations(
  folders: LayerFolder[],
  movingId?: string,
  creating = false,
) {
  const descendants = movingId
    ? folders.filter((folder) =>
        folderAncestors(folders, folder.id).some(
          (ancestor) => ancestor.id === movingId,
        ),
      )
    : [];
  const descendantIds = new Set(descendants.map((folder) => folder.id));
  const movingDepth = movingId ? folderAncestors(folders, movingId).length : 0;
  const height = movingId
    ? Math.max(
        1,
        ...descendants.map(
          (folder) =>
            folderAncestors(folders, folder.id).length - movingDepth + 1,
        ),
      )
    : creating
      ? 1
      : 0;
  return [
    { id: "", label: "ルート（フォルダーなし）", disabled: false },
    ...[...folders]
      .sort((a, b) => a.order - b.order)
      .filter((folder) => !descendantIds.has(folder.id))
      .map((folder) => ({
        id: folder.id,
        label: `${folderPath(folders, folder.id)} · #${folder.order + 1}`,
        disabled:
          folderAncestors(folders, folder.id).length + height >
          MAX_FOLDER_DEPTH,
      })),
  ];
}

/** Empty string is root; undefined means mixed or no targets. */
export function commonFolderId(
  objects: ReadonlyArray<Pick<ScreenObject, "folderId">>,
): string | undefined {
  const folders = new Set(objects.map((object) => object.folderId ?? ""));
  return folders.size === 1 ? [...folders][0] : undefined;
}
