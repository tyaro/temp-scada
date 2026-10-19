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
  if (
    definitionId &&
    objects.some(
      (o) =>
        o.shape.type === "symbol" ||
        o.shape.type === "image" ||
        (o.shape.type === "text" && o.shape.binding),
    )
  )
    throw new Error(
      "Symbol定義には画像・Symbol配置・タグ付きTextを貼り付けできません",
    );
  if (
    !Number.isFinite(command.center.x) ||
    !Number.isFinite(command.center.y) ||
    !Number.isFinite(command.offset ?? 0)
  )
    throw new Error("貼り付け先は有限の座標にしてください");
  const assetReferences = new Map<string, string>();
  for (const asset of fragment.project.assets) {
    const existing = next.assets.find((a) => a.sha256 === asset.sha256);
    const incoming = { ...asset, id: existing?.id ?? newId() };
    assetReferences.set(asset.id, registerAsset(next, incoming));
  }
  const references = new Map<string, string>();
  for (const object of objects)
    if (
      object.shape.type === "symbol" &&
      !references.has(object.shape.symbolId)
    ) {
      const symbolId = object.shape.symbolId;
      const source = fragment.project.symbols.find((s) => s.id === symbolId)!;
      const live =
        fragment.origin === command.origin &&
        fragment.project.manifest.projectId === originalProjectId
          ? next.symbols.find((s) => s.id === source.id)
          : undefined;
      if (live) references.set(source.id, live.id);
      else {
        const copy = renewOwnerIds(
          JSON.parse(JSON.stringify(source)) as SymbolDefinition,
        );
        next.symbols.push(copy);
        references.set(source.id, copy.id);
      }
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
  [...objects]
    .sort((a, b) => a.order - b.order)
    .forEach((object, index) => {
      const copy = JSON.parse(JSON.stringify(object)) as ScreenObject;
      copy.id = newId();
      copy.order = order + index;
      delete copy.folderId;
      copy.x += dx;
      copy.y += dy;
      if (copy.shape.type === "symbol")
        copy.shape.symbolId = references.get(copy.shape.symbolId)!;
      if (copy.shape.type === "image")
        copy.shape.assetId = assetReferences.get(copy.shape.assetId)!;
      screen.objects.push(copy);
    });
}
