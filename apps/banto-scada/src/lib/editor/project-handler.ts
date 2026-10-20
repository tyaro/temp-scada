import { applyEquipmentCommand } from "./equipment-handler";
import type { Project } from "../project";
import type { ProjectCommand } from "./commands";

/** Mutates only the candidate. Validation and revision updates belong to applyCommand. */
export function applyProjectCommand(
  next: Project,
  command: ProjectCommand,
): void {
  switch (command.type) {
    case "update-project": {
      const name = command.name.trim();
      if (!name) throw new Error("プロジェクト名を入力してください");
      next.manifest.name = name;
      return;
    }
    default:
      return applyEquipmentCommand(next, command);
  }
}
