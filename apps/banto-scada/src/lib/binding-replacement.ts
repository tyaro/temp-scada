import { bindingReferences, type BindingUsage } from "./binding-references";
import { groupFor } from "./geometric-groups";
import { parseProject, serializeProject, type Project } from "./project";

export interface BindingReplacementRequest {
  from: string;
  to: string;
  /** Exact validated Project including revision; UI must also guard workspace generation. */
  expectedProject: string;
}
export interface BindingReplacementPreview extends BindingReplacementRequest {
  usages: BindingUsage[];
  existingDestinationUsages: BindingUsage[];
  blocked: { screenId: string; objectId: string; reason: string }[];
  changed: boolean;
}

/** Exact saved-name matching, independent of the reference list's search filter. */
export function previewBindingReplacement(
  project: Project,
  from: string,
  to: string,
): BindingReplacementPreview {
  const expectedProject = serializeProject(project);
  const references = bindingReferences(project);
  const usages =
    references.find((ref) => ref.externalName === from)?.usages ?? [];
  if (!usages.length) throw new Error("置換元のタグ参照が見つかりません");
  const candidate = parseProject(expectedProject);
  const blocked: BindingReplacementPreview["blocked"] = [];
  for (const screen of candidate.screens) {
    for (const object of screen.objects) {
      if (
        object.shape.type !== "text" ||
        object.shape.binding?.externalName !== from
      )
        continue;
      if (object.locked || groupFor(screen, object.id))
        blocked.push({
          screenId: screen.id,
          objectId: object.id,
          reason: object.locked
            ? "ロックを解除してください"
            : "グループを解除してから編集してください",
        });
      object.shape.binding.externalName = to;
    }
  }
  // Reuse the current saved-name and whole-Project contract, without trimming names.
  serializeProject(candidate);
  return {
    from,
    to,
    expectedProject,
    usages,
    existingDestinationUsages:
      from === to
        ? []
        : (references.find((ref) => ref.externalName === to)?.usages ?? []),
    blocked,
    changed: from !== to,
  };
}

/** Mutates only the editor's validated candidate; never trusts a caller-supplied target list. */
export function applyBindingReplacement(
  candidate: Project,
  request: BindingReplacementRequest,
): void {
  if (serializeProject(candidate) !== request.expectedProject)
    throw new Error("Projectが変更されました。置換の差分を再確認してください");
  const preview = previewBindingReplacement(
    candidate,
    request.from,
    request.to,
  );
  if (!preview.changed) return;
  if (preview.blocked.length)
    throw new Error(
      "変更できない配置を含むため全件を置換できません: " +
        preview.blocked
          .map((item) => `${item.screenId}/${item.objectId}: ${item.reason}`)
          .join("、"),
    );
  for (const screen of candidate.screens)
    for (const object of screen.objects)
      if (
        object.shape.type === "text" &&
        object.shape.binding?.externalName === request.from
      )
        object.shape.binding.externalName = request.to;
}
