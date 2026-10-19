import type { Project, Screen } from "../project";
import { projectScreenReferences } from "../screen-references";
import type { ScreenCommand } from "./commands";
import {
  newId,
  registerAsset,
  renewOwnerIds,
  screenName,
} from "./model-helpers";
import { unhandledCommand } from "./unhandled-command";

/** Only reorder at an edge bypasses finish, preserving the existing no-op path. */
export function applyScreenCommand(
  next: Project,
  command: ScreenCommand,
): "finish" | "unchanged" {
  if (command.type === "create-screen") {
    next.screens.push({
      id: newId(),
      name: screenName(command.name),
      width: command.width,
      height: command.height,
      background: command.background ?? "#ffffff",
      objects: [],
      folders: [],
      groups: [],
    });
    return "finish";
  }
  const targetScreen = next.screens.find((s) => s.id === command.screenId);
  if (!targetScreen) throw new Error("画面が見つかりません");
  const screen = targetScreen;
  if (command.type === "set-background-image") {
    if (command.image === null) {
      if (command.asset)
        throw new Error("背景解除と資産登録は同時に指定できません");
      delete targetScreen!.backgroundImage;
    } else {
      const image = structuredClone(command.image);
      if (command.asset) {
        if (command.asset.id !== image.assetId)
          throw new Error("背景画像と登録資産のIDが一致しません");
        image.assetId = registerAsset(next, command.asset);
      }
      targetScreen!.backgroundImage = image;
    }
    return "finish";
  }
  if (command.type === "update-screen") {
    if (command.background !== undefined)
      Object.assign(screen, { background: command.background });
    Object.assign(screen, {
      name: screenName(command.name),
      width: command.width,
      height: command.height,
    });
    return "finish";
  }
  if (command.type === "reorder-screen") {
    const from = next.screens.findIndex((item) => item.id === screen.id);
    const to =
      command.direction === "up"
        ? Math.max(0, from - 1)
        : Math.min(next.screens.length - 1, from + 1);
    if (from === to) return "unchanged";
    const [item] = next.screens.splice(from, 1);
    next.screens.splice(to, 0, item);
    return "finish";
  }
  if (command.type === "duplicate-screen") {
    const copy = renewOwnerIds(JSON.parse(JSON.stringify(screen)) as Screen);
    copy.name = screen.name.slice(0, 196) + " コピー";
    next.screens.push(copy);
    return "finish";
  }
  if (command.type === "remove-screen") {
    if (next.screens.length === 1)
      throw new Error("最後の画面は削除できません");
    const uses = projectScreenReferences(next).byTarget.get(screen.id) ?? [];
    if (uses.length) {
      const names = uses.slice(0, 5).map((ref) => {
        const owner = next.screens.find((s) => s.id === ref.screenId)!;
        const object = owner.objects.find((o) => o.id === ref.objectId)!;
        return `${owner.name}／${object.name ?? "埋込画面"}`;
      });
      throw new Error(
        `この画面は埋込表示で使用中です：${names.join("、")}${uses.length > 5 ? " ほか" : ""}。先に参照配置を削除または変更してください。`,
      );
    }
    next.screens = next.screens.filter((s) => s.id !== screen.id);
    return "finish";
  }
  return unhandledCommand(command);
}
