import type { EditCommand } from "../../editor";
import type { BackgroundImage } from "../../project";
import { parseNumericProperty } from "../numeric-properties";

export interface BackgroundImageInput {
  data: Pick<FormData, "get">;
  targetKey?: string;
}
export interface BackgroundImageContext {
  generation: number;
  screenId: string;
  definition: boolean;
  image: BackgroundImage | undefined;
}

export function backgroundImageCommand(
  input: BackgroundImageInput,
  context: BackgroundImageContext,
): EditCommand {
  if (
    context.definition ||
    input.targetKey !== `${context.generation}:${context.screenId}` ||
    !context.image
  )
    throw new Error("背景画像の編集対象が変わりました。");
  return {
    type: "set-background-image",
    screenId: context.screenId,
    image: {
      ...context.image,
      fit: String(input.data.get("fit")) as "contain",
      opacity: parseNumericProperty(String(input.data.get("opacity"))) / 100,
    },
  };
}
