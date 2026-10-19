import { normalizeImageCrop, type ImageExtent } from "../image-crop";
import { parseNumericProperty } from "./numeric-properties";
export function imageCropFromForm(
  data: Pick<FormData, "get">,
  source: ImageExtent,
) {
  const number = (name: string) =>
    parseNumericProperty(String(data.get(name))) / 100;
  return normalizeImageCrop(source, {
    x: number("cropX"),
    y: number("cropY"),
    width: number("cropWidth"),
    height: number("cropHeight"),
  });
}
