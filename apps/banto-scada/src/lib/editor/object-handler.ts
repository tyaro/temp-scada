import type { Project } from "../project";
import { isObjectCommand, type ObjectCommand } from "./commands";
import {
  isFolderStructureCommand,
  applyFolderStructureCommand,
} from "./folder-handler";
import { applyImagePlacement } from "./image-handler";
import { applyObjectStateCommand } from "./object-state-handler";
import { applyPasteCommand } from "./paste-handler";
import { applySelectionCommand } from "./selection-handler";
import {
  applyScreenViewPlacement,
  applyObjectCreation,
} from "./placement-handler";
import { applySingleObjectCommand } from "./single-object-handler";

/** Owns object routing and guard order; finish and the original Project stay outside. */
export function applyObjectCommand(
  next: Project,
  command: ObjectCommand,
  originalProjectId: string,
): "finish" | "unchanged" {
  const definitionId = isObjectCommand(command)
    ? command.definitionId
    : undefined;
  const targetScreen = next.screens.find((s) => s.id === command.screenId);
  const screen = definitionId
    ? next.symbols.find((s) => s.id === definitionId)
    : targetScreen;
  if (!screen) throw new Error("画面が見つかりません");
  if (command.type === "add-screen-view") {
    applyScreenViewPlacement(screen, command, definitionId);
    return "finish";
  }
  if (command.type === "add-image") {
    applyImagePlacement(next, screen, command, definitionId);
    return "finish";
  }
  if (isFolderStructureCommand(command)) {
    applyFolderStructureCommand(screen, command);
    return "finish";
  }
  if (command.type === "set-visibility" || command.type === "set-lock")
    return applyObjectStateCommand(screen, command);
  if (isObjectCommand(command)) {
    const ids =
      "objectIds" in command
        ? command.objectIds
        : "objectId" in command
          ? [command.objectId]
          : [];
    if (
      screen.objects.some((object) => object.locked && ids.includes(object.id))
    )
      throw new Error(
        "ロック中の配置を含むため変更できません。レイヤーでロックを解除してください。",
      );
  }
  if (command.type === "paste") {
    applyPasteCommand(next, screen, command, originalProjectId, definitionId);
    return "finish";
  }
  if (
    command.type === "set-folder" ||
    command.type === "distribute" ||
    command.type === "set-color" ||
    command.type === "set-line-style" ||
    command.type === "set-outline-style" ||
    command.type === "move-many" ||
    command.type === "duplicate-many" ||
    command.type === "remove-many" ||
    command.type === "align"
  ) {
    return applySelectionCommand(screen, command);
  }
  if (command.type === "add" || command.type === "add-symbol") {
    applyObjectCreation(next, screen, command, definitionId, targetScreen);
    return "finish";
  }
  return applySingleObjectCommand(next, screen, command, definitionId);
}
