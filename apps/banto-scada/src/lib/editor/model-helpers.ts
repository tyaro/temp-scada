import {
  getBounds,
  type Project,
  type Point,
  type SymbolDefinition,
  type ScreenObject,
  type Screen,
  type ImageAsset,
} from "../project";

export function symbolUsage(project: Project, symbolId: string): number {
  return project.screens
    .flatMap((s) => s.objects)
    .filter((o) => o.shape.type === "symbol" && o.shape.symbolId === symbolId)
    .length;
}

/** RFC 9562 UUID v7。ID は順序として使わない。 */
export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let time = Date.now();
  for (let i = 5; i >= 0; i--) {
    bytes[i] = time % 256;
    time = Math.floor(time / 256);
  }
  bytes[6] = (bytes[6] & 15) | 112;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function copySymbol(definition: SymbolDefinition): SymbolDefinition {
  const copy = renewOwnerIds(
    JSON.parse(JSON.stringify(definition)) as SymbolDefinition,
  );
  copy.name = definition.name.slice(0, 196) + " コピー";
  return copy;
}
export function renewOwnerIds<T extends Screen | SymbolDefinition>(copy: T): T {
  copy.id = newId();
  const folders = new Map(copy.folders.map((folder) => [folder.id, newId()]));
  for (const folder of copy.folders) {
    folder.id = folders.get(folder.id)!;
    if (folder.parentId) folder.parentId = folders.get(folder.parentId)!;
  }
  const placements = new Map(
    copy.objects.map((object) => [object.id, newId()]),
  );
  if ("groups" in copy)
    for (const group of copy.groups) {
      group.id = newId();
      group.memberIds = group.memberIds.map((id) => placements.get(id)!);
    }
  for (const object of copy.objects) {
    object.id = placements.get(object.id)!;
    remapStateColor(object, placements);
    if (object.folderId) object.folderId = folders.get(object.folderId)!;
  }
  return copy;
}
export function screenName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("画面名を入力してください");
  return trimmed;
}
export function centerObject(object: ScreenObject, center?: Point) {
  if (!center) return;
  if (!Number.isFinite(center.x) || !Number.isFinite(center.y))
    throw new Error("配置先は有限の座標にしてください");
  const bounds = getBounds(object);
  object.x = center.x - bounds.x - bounds.width / 2;
  object.y = center.y - bounds.y - bounds.height / 2;
}

export function registerAsset(project: Project, asset: ImageAsset): string {
  const existing = project.assets.find((a) => a.sha256 === asset.sha256);
  if (existing) {
    if (
      ["mime", "byteLength", "width", "height"].some(
        (key) =>
          existing[key as keyof ImageAsset] !== asset[key as keyof ImageAsset],
      )
    )
      throw new Error("画像hashと資産宣言が一致しません");
    return existing.id;
  }
  project.assets.push(structuredClone(asset));
  return asset.id;
}

/** Selection copies remap a copied source; a follower-only copy keeps its local source. */
export function remapStateColor(
  object: ScreenObject,
  ids: ReadonlyMap<string, string>,
) {
  if ("stateColor" in object.shape && object.shape.stateColor) {
    object.shape.stateColor.textId =
      ids.get(object.shape.stateColor.textId) ?? object.shape.stateColor.textId;
  }
}
