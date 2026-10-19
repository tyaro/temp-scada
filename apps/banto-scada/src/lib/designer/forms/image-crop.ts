import type { EditCommand } from "../../editor";
import type { ScreenObject, ImageAsset } from "../../project";
import { imageCropFromForm } from "../image-crop-fields";

export interface ImageCropInput {
  data: Pick<FormData, "get">;
  objectId?: string;
  targetKey?: string;
  assetId?: string;
}
export interface ImageCropContext {
  generation: number;
  screenId: string;
  definition: boolean;
  selected: ScreenObject | undefined;
  assets: readonly ImageAsset[];
}
export function imageCropCommand(
  input: ImageCropInput,
  context: ImageCropContext,
): EditCommand {
  const selected = context.selected;
  if (
    context.definition ||
    selected?.shape.type !== "image" ||
    input.objectId !== selected.id ||
    input.targetKey !==
      `${context.generation}:${context.screenId}:${context.definition}` ||
    input.assetId !== selected.shape.assetId
  )
    throw new Error("トリミングの対象が変わりました。選択し直してください。");
  const asset = context.assets.find(
    (a) => selected.shape.type === "image" && a.id === selected.shape.assetId,
  )!;
  return {
    type: "set-image-crop",
    screenId: context.screenId,
    objectId: selected.id,
    crop: imageCropFromForm(input.data, asset) ?? null,
  };
}
