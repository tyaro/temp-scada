import type { EditCommand } from "../../editor";
import type { ScreenObject } from "../../project";
import { parseImageFit } from "../../image-fit";
export function imageFitCommand(
  input: {
    data: Pick<FormData, "get">;
    connected: boolean;
    objectId?: string;
    targetKey?: string;
  },
  context: {
    generation: number;
    screenId: string;
    definition: boolean;
    selected: ScreenObject | undefined;
  },
): EditCommand {
  if (
    !input.connected ||
    context.selected?.shape.type !== "image" ||
    input.objectId !== context.selected.id ||
    input.targetKey !==
      `${context.generation}:${context.screenId}:${context.definition}`
  )
    throw new Error(
      "画像の表示方式の対象が変わりました。選択し直してください。",
    );
  return {
    type: "set-image-fit",
    screenId: context.screenId,
    objectId: context.selected.id,
    fit: parseImageFit(input.data.get("imageFit")),
  };
}
