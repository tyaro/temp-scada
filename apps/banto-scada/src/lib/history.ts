import { applyCommand, type EditCommand } from "./editor";
import { parseProject, serializeProject, type Project } from "./project";
export interface EditHistory {
  past: string[];
  future: string[];
}
export const HISTORY_LIMIT = 50;
export function emptyHistory(): EditHistory {
  return { past: [], future: [] };
}
export function recordEdit(
  project: Project,
  history: EditHistory,
  command: EditCommand,
  mode: "edit" | "preview",
) {
  const next = applyCommand(project, command, mode);
  if (next === project) return { project, history };
  return {
    project: next,
    history: {
      past: [...history.past, serializeProject(project)].slice(-HISTORY_LIMIT),
      future: [],
    },
  };
}
/** Undo / Redo は内容を復元するが、保存 generation は過去へ巻き戻さない。 */
export function travelHistory(
  project: Project,
  history: EditHistory,
  direction: "undo" | "redo",
  mode: "edit" | "preview",
) {
  if (mode !== "edit")
    throw new Error("表示プレビューでは履歴を変更できません");
  const source = direction === "undo" ? history.past : history.future;
  if (source.length === 0) return { project, history };
  const restored = parseProject(source.at(-1)!);
  if (restored.manifest.projectId !== project.manifest.projectId)
    throw new Error("別の Project の履歴は使えません");
  restored.manifest.projectRevision = project.manifest.projectRevision + 1;
  const next = parseProject(serializeProject(restored));
  const current = serializeProject(project);
  return {
    project: next,
    history:
      direction === "undo"
        ? {
            past: history.past.slice(0, -1),
            future: [...history.future, current].slice(-HISTORY_LIMIT),
          }
        : {
            past: [...history.past, current].slice(-HISTORY_LIMIT),
            future: history.future.slice(0, -1),
          },
  };
}
