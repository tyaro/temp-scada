import type { EditCommand } from "../../editor";
export function groupNameFormCommand(
  input: { data: Pick<FormData, "get">; targetKey?: string; groupId?: string },
  context: { generation: number; screenId: string; groupId?: string },
): EditCommand {
  if (
    !context.groupId ||
    input.groupId !== context.groupId ||
    input.targetKey !== `${context.generation}:${context.screenId}`
  )
    throw new Error("グループ名の編集対象が変更されています");
  const value = input.data.get("name");
  if (typeof value !== "string")
    throw new Error("グループ名を入力してください");
  return {
    type: "rename-group",
    screenId: context.screenId,
    groupId: context.groupId,
    name: value.trim() || undefined,
  };
}
