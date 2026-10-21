import type {
  Project,
  Screen,
  SymbolDefinition,
  ScreenObject,
} from "../project";
import { parseImageFit } from "../image-fit";
import { imageCropViewBox, normalizeImageCrop } from "../image-crop";
import type {
  ObjectCommand,
  ImagePlacementCommand,
  ImageEditCommand,
} from "./commands";
import { newId, registerAsset } from "./model-helpers";
import { unhandledCommand } from "./unhandled-command";

export function isImageEditCommand(
  command: ObjectCommand,
): command is ImageEditCommand {
  return (
    command.type === "replace-image" ||
    command.type === "set-image-crop" ||
    command.type === "set-image-fit" ||
    command.type === "reset-image-ratio"
  );
}

/** Runs at the existing placement position, before selection lock checks. */
export function applyImagePlacement(
  next: Project,
  screen: Screen | SymbolDefinition,
  command: ImagePlacementCommand,
): void {
  const assetId = registerAsset(next, command.asset);
  screen.objects.push({
    id: newId(),
    order: Math.max(-1, ...screen.objects.map((o) => o.order)) + 1,
    rotation: 0,
    fill: "#000000",
    ...command.frame,
    shape: { type: "image", assetId, fit: "contain" },
  });
}

/** Called only after owner, placement lock, and object lookup checks. */
export function applyImageEdit(
  next: Project,
  object: ScreenObject,
  command: ImageEditCommand,
): void {
  if (command.type === "replace-image") {
    if (object.shape.type !== "image")
      throw new Error("画像配置だけを差し替えられます。");
    const assetId = registerAsset(next, command.asset);
    if (assetId !== object.shape.assetId) delete object.shape.crop;
    object.shape.assetId = assetId;
  } else if (command.type === "set-image-fit") {
    if (object.shape.type !== "image")
      throw new Error("画像配置だけ表示方式を変更できます。");
    object.shape.fit = parseImageFit(command.fit);
  } else if (command.type === "set-image-crop") {
    if (object.shape.type !== "image")
      throw new Error("画像配置だけをトリミングできます。");
    const asset = next.assets.find(
      (a) => object.shape.type === "image" && a.id === object.shape.assetId,
    )!;
    const crop = normalizeImageCrop(asset, command.crop ?? undefined);
    if (crop) object.shape.crop = crop;
    else delete object.shape.crop;
  } else if (command.type === "reset-image-ratio") {
    if (!("width" in object) || object.shape.type !== "image")
      throw new Error("画像配置だけを元比率に戻せます");
    const assetId = object.shape.assetId;
    const asset = next.assets.find((a) => a.id === assetId)!;
    const source = imageCropViewBox(asset, object.shape.crop);
    const height = object.width * (source.height / source.width);
    object.y += (object.height - height) / 2;
    object.height = height;
  } else return unhandledCommand(command);
}
