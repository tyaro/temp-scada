import type { EditCommand } from "../../editor";

export interface MoveFormContext {
  screenId: string;
  selectedIds: readonly string[];
}
export function moveFormCommand(
  data: Pick<FormData, "get">,
  context: MoveFormContext,
): EditCommand {
  return {
    type: "move-many",
    screenId: context.screenId,
    objectIds: [...context.selectedIds],
    dx: Number(data.get("dx")),
    dy: Number(data.get("dy")),
  };
}
