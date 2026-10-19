import type { Screen, SymbolDefinition, ScreenObject } from "../project";
import type {
  ObjectCommand,
  FolderStructureCommand,
  FolderAssignmentCommand,
} from "./commands";
import { newId } from "./model-helpers";
import { unhandledCommand } from "./unhandled-command";

export function isFolderStructureCommand(
  command: ObjectCommand,
): command is FolderStructureCommand {
  return (
    command.type === "create-folder" ||
    command.type === "rename-folder" ||
    command.type === "move-folder" ||
    command.type === "remove-folder"
  );
}

/** Called before placement lock checks, as folder organization is independent. */
export function applyFolderStructureCommand(
  screen: Screen | SymbolDefinition,
  command: FolderStructureCommand,
): void {
  if (command.type === "create-folder") {
    if (
      command.parentId !== null &&
      !screen.folders.some((folder) => folder.id === command.parentId)
    )
      throw new Error("同じ所有先の親フォルダーが見つかりません");
    screen.folders.push({
      id: newId(),
      name: folderName(command.name),
      order: Math.max(-1, ...screen.folders.map((folder) => folder.order)) + 1,
      ...(command.parentId === null ? {} : { parentId: command.parentId }),
    });
    return;
  }
  const folder = screen.folders.find(
    (folder) => folder.id === command.folderId,
  );
  if (!folder) throw new Error("フォルダーが見つかりません");
  if (command.type === "rename-folder") folder.name = folderName(command.name);
  else if (command.type === "move-folder") {
    if (
      command.parentId !== null &&
      !screen.folders.some((item) => item.id === command.parentId)
    )
      throw new Error("同じ所有先の親フォルダーが見つかりません");
    if (command.parentId === null) delete folder.parentId;
    else folder.parentId = command.parentId;
  } else if (command.type === "remove-folder") {
    if (
      screen.folders.some((child) => child.parentId === folder.id) ||
      screen.objects.some((object) => object.folderId === folder.id)
    )
      throw new Error(
        "子フォルダーまたは配置があるため削除できません。空のフォルダーだけ削除できます。",
      );
    screen.folders = screen.folders.filter((item) => item.id !== folder.id);
  } else return unhandledCommand(command);
}

/** Receives the already validated and ordered selection, after placement lock checks. */
export function applyFolderAssignment(
  screen: Screen | SymbolDefinition,
  objects: ScreenObject[],
  command: FolderAssignmentCommand,
): void {
  if (
    command.folderId !== null &&
    !screen.folders.some((folder) => folder.id === command.folderId)
  )
    throw new Error("同じ所有先の所属フォルダーが見つかりません");
  for (const object of objects) {
    if (command.folderId === null) delete object.folderId;
    else object.folderId = command.folderId;
  }
}
function folderName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("フォルダー名を入力してください");
  return trimmed;
}
