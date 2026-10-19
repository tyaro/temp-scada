import {
  getBounds,
  type Project,
  type Point,
  type SymbolDefinition,
  type ScreenObject,
  type Screen,
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
  for (const object of copy.objects) {
    object.id = newId();
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
