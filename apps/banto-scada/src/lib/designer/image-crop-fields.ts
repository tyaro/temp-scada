import { normalizeImageCrop, type ImageExtent } from "../image-crop";
import { parseNumericProperty } from "./numeric-properties";
import { cropWithAspect } from "./image-crop-gesture";
export function imageCropFromForm(
  data: Pick<FormData, "get">,
  source: ImageExtent,
  locked?: { aspect: number; axis: "width" | "height" },
) {
  const number = (name: string) =>
    parseNumericProperty(String(data.get(name))) / 100;
  const next = {
    x: number("cropX"),
    y: number("cropY"),
    width: locked?.axis === "height" ? 1 : number("cropWidth"),
    height: locked?.axis === "width" ? 1 : number("cropHeight"),
  };
  return normalizeImageCrop(
    source,
    locked ? cropWithAspect(source, next, locked.aspect, locked.axis) : next,
  );
}
