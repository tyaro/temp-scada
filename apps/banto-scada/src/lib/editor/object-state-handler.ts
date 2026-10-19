import type { Screen, SymbolDefinition } from "../project";
import type { ObjectStateCommand } from "./commands";
import { unhandledCommand } from "./unhandled-command";

/** State changes and their no-ops run before the ordinary placement lock guard. */
export function applyObjectStateCommand(
  screen: Screen | SymbolDefinition,
  command: ObjectStateCommand,
): "finish" | "unchanged" {
  if (command.type === "set-visibility") {
    const object = screen.objects.find(
      (object) => object.id === command.objectId,
    );
    if (!object) throw new Error("配置が見つかりません");
    if (typeof command.visible !== "boolean")
      throw new Error("表示状態はbooleanで指定してください");
    if ((object.visible !== false) === command.visible) return "unchanged";
    if (command.visible) delete object.visible;
    else object.visible = false;
    return "finish";
  }
  if (command.type === "set-lock") {
    const object = screen.objects.find(
      (object) => object.id === command.objectId,
    );
    if (!object) throw new Error("配置が見つかりません");
    if (typeof command.locked !== "boolean")
      throw new Error("ロック状態はbooleanで指定してください");
    if (!!object.locked === command.locked) return "unchanged";
    if (command.locked) object.locked = true;
    else delete object.locked;
    return "finish";
  }
  return unhandledCommand(command);
}
