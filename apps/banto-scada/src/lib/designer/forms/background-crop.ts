import type { EditCommand } from "../../editor";
import type { BackgroundImage, ImageAsset } from "../../project";
import { imageCropFromForm } from "../image-crop-fields";
export function backgroundCropCommand(
  input: {
    data: Pick<FormData, "get">;
    connected: boolean;
    targetKey?: string;
    assetId?: string;
  },
  context: {
    generation: number;
    screenId: string;
    definition: boolean;
    image?: BackgroundImage;
    asset?: ImageAsset;
  },
): EditCommand {
  if (
    !input.connected ||
    context.definition ||
    input.targetKey !== `${context.generation}:${context.screenId}` ||
    !context.image ||
    !context.asset ||
    input.assetId !== context.image.assetId ||
    context.asset.id !== context.image.assetId
  )
    throw new Error("背景の切出し対象が変わりました。選択し直してください。");
  const image = { ...context.image };
  const crop = imageCropFromForm(input.data, context.asset);
  if (crop) image.crop = crop;
  else delete image.crop;
  return { type: "set-background-image", screenId: context.screenId, image };
}
