import {
  getBounds,
  type Project,
  type Screen,
  type SymbolDefinition,
  type ScreenObject,
} from "../project";
import { parseClipboard } from "../clipboard";
import type { PasteCommand } from "./commands";
import { newId, registerAsset, renewOwnerIds } from "./model-helpers";

export function applyPasteCommand(
  next: Project,
  screen: Screen | SymbolDefinition,
  command: PasteCommand,
  originalProjectId: string,
  definitionId?: string,
): void {
  const fragment = parseClipboard(command.text);
  const objects = fragment.project.screens[0].objects;
  const groups = fragment.project.screens[0].groups;
  if (definitionId && groups.length)
    throw new Error("Symbol定義内へのグループ貼り付けには対応していません");
  if (
    definitionId &&
    objects.some(
      (o) =>
        o.shape.type === "symbol" ||
        o.shape.type === "image" ||
        o.shape.type === "screenView" ||
        (o.shape.type === "text" && o.shape.binding),
    )
  )
    throw new Error(
      "Symbol定義には画像・埋込画面・Symbol配置・タグ付きTextを貼り付けできません",
    );
  if (
    !Number.isFinite(command.center.x) ||
    !Number.isFinite(command.center.y) ||
    !Number.isFinite(command.offset ?? 0)
  )
    throw new Error("貼り付け先は有限の座標にしてください");
  const sameWorkspace =
    fragment.origin === command.origin &&
    fragment.project.manifest.projectId === originalProjectId;
  const screenReferences = new Map<string, string>();
  const importedScreens: Screen[] = [];
  for (const source of fragment.project.screens.slice(1)) {
    const live = sameWorkspace
      ? next.screens.find((s) => s.id === source.id)
      : undefined;
    if (live) screenReferences.set(source.id, live.id);
    else {
      const copy = renewOwnerIds(JSON.parse(JSON.stringify(source)) as Screen);
      importedScreens.push(copy);
      screenReferences.set(source.id, copy.id);
    }
  }
  // Stop snapshot dependency expansion at reused live screens.
  const importedObjects = [
    ...objects,
    ...importedScreens.flatMap((source) => source.objects),
  ];
  const references = new Map<string, string>();
  const importedSymbols: SymbolDefinition[] = [];
  for (const object of importedObjects)
    if (
      object.shape.type === "symbol" &&
      !references.has(object.shape.symbolId)
    ) {
      const symbolId = object.shape.symbolId;
      const source = fragment.project.symbols.find((s) => s.id === symbolId)!;
      const live = sameWorkspace
        ? next.symbols.find((s) => s.id === source.id)
        : undefined;
      if (live) references.set(source.id, live.id);
      else {
        const copy = renewOwnerIds(
          JSON.parse(JSON.stringify(source)) as SymbolDefinition,
        );
        importedSymbols.push(copy);
        references.set(source.id, copy.id);
      }
    }
  const usedAssets = new Set(
    [
      ...importedObjects,
      ...importedSymbols.flatMap((definition) => definition.objects),
    ].flatMap((object) =>
      object.shape.type === "image" ? [object.shape.assetId] : [],
    ),
  );
  for (const source of importedScreens)
    if (source.backgroundImage) usedAssets.add(source.backgroundImage.assetId);
  const assetReferences = new Map<string, string>();
  for (const asset of fragment.project.assets.filter((asset) =>
    usedAssets.has(asset.id),
  )) {
    const existing = next.assets.find((a) => a.sha256 === asset.sha256);
    const incoming = { ...asset, id: existing?.id ?? newId() };
    assetReferences.set(asset.id, registerAsset(next, incoming));
  }
  function remapReferences(object: ScreenObject) {
    if (object.shape.type === "symbol")
      object.shape.symbolId = references.get(object.shape.symbolId)!;
    if (object.shape.type === "image")
      object.shape.assetId = assetReferences.get(object.shape.assetId)!;
    if (object.shape.type === "screenView")
      object.shape.screenId = screenReferences.get(object.shape.screenId)!;
  }
  for (const definition of importedSymbols) {
    for (const object of definition.objects) remapReferences(object);
    next.symbols.push(definition);
  }
  for (const source of importedScreens) {
    for (const object of source.objects) remapReferences(object);
    if (source.backgroundImage)
      source.backgroundImage.assetId = assetReferences.get(
        source.backgroundImage.assetId,
      )!;
    next.screens.push(source);
  }
  const bounds = objects.map((o) => {
    const b = getBounds(o);
    return {
      left: o.x + b.x,
      top: o.y + b.y,
      right: o.x + b.x + b.width,
      bottom: o.y + b.y + b.height,
    };
  });
  const dx =
    command.center.x -
    (Math.min(...bounds.map((b) => b.left)) +
      Math.max(...bounds.map((b) => b.right))) /
      2 +
    (command.offset ?? 0);
  const dy =
    command.center.y -
    (Math.min(...bounds.map((b) => b.top)) +
      Math.max(...bounds.map((b) => b.bottom))) /
      2 +
    (command.offset ?? 0);
  const order = Math.max(-1, ...screen.objects.map((o) => o.order)) + 1;
  const placementIds = new Map(objects.map((object) => [object.id, newId()]));
  if ("groups" in screen)
    screen.groups.push(
      ...groups.map((group) => ({
        ...group,
        id: newId(),
        memberIds: group.memberIds.map((id) => placementIds.get(id)!),
      })),
    );
  [...objects]
    .sort((a, b) => a.order - b.order)
    .forEach((object, index) => {
      const copy = JSON.parse(JSON.stringify(object)) as ScreenObject;
      copy.id = placementIds.get(object.id)!;
      copy.order = order + index;
      delete copy.folderId;
      copy.x += dx;
      copy.y += dy;
      remapReferences(copy);
      screen.objects.push(copy);
    });
}
