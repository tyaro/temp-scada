import type { EditCommand } from "../../editor";

export interface ScreenFormContext {
  screenId: string;
  definitionId?: string;
}
export function screenFormCommand(
  data: Pick<FormData, "get">,
  context: ScreenFormContext,
): EditCommand {
  return {
    ...(context.definitionId
      ? { type: "update-symbol" as const, symbolId: context.definitionId }
      : {
          type: "update-screen" as const,
          screenId: context.screenId,
          background: String(data.get("background")),
        }),
    name: String(data.get("name")),
    width: Number(data.get("width")),
    height: Number(data.get("height")),
  };
}
