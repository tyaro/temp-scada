import {
  parseProject,
  serializeProject,
  referencedAssets,
  type Project,
} from "./project";
import { projectContent } from "./save-state";
import {
  isProjectCommand,
  isSymbolCommand,
  isScreenCommand,
  isObjectCommand,
  type EditCommand,
} from "./editor/commands";
import { applyProjectCommand } from "./editor/project-handler";
import { applySymbolCommand } from "./editor/symbol-handler";
import { applyScreenCommand } from "./editor/screen-handler";
import { applyObjectCommand } from "./editor/object-handler";
import { unhandledCommand } from "./editor/unhandled-command";
export { newId, symbolUsage } from "./editor/model-helpers";
export { isObjectCommand } from "./editor/commands";
export type {
  AddKind,
  ObjectPatch,
  OutlineStylePatch,
  AlignMode,
  ObjectCommand,
  EditCommand,
} from "./editor/commands";

/** Changes are validated on a copy; failures leave the original Project untouched. */
export function applyCommand(
  project: Project,
  command: EditCommand,
  mode: "edit" | "preview",
): Project {
  if (mode !== "edit") throw new Error("表示プレビューでは編集できません");
  const next = parseProject(serializeProject(project));
  if (isProjectCommand(command)) {
    applyProjectCommand(next, command);
    return finish(project, next);
  }
  if (isSymbolCommand(command)) {
    applySymbolCommand(next, command);
    return finish(project, next);
  }
  if (isScreenCommand(command)) {
    const result = applyScreenCommand(next, command);
    return result === "unchanged" ? project : finish(project, next);
  }
  if (isObjectCommand(command)) {
    const result = applyObjectCommand(
      next,
      command,
      project.manifest.projectId,
    );
    return result === "unchanged" ? project : finish(project, next);
  }
  return unhandledCommand(command);
}
function finish(project: Project, next: Project): Project {
  const usedAssets = referencedAssets(next);
  next.assets = next.assets.filter((asset) => usedAssets.has(asset.id));

  if (next.symbols.some((s) => s.objects.length === 0))
    throw new Error("Symbol 定義には図形を 1 つ以上残してください");
  // Validate first; invalid values must never disappear into a no-op comparison.
  serializeProject(next);
  if (projectContent(next) === projectContent(project)) return project;
  next.manifest.projectRevision++;
  return parseProject(JSON.stringify(next));
}
