export type ImageFit = "contain" | "cover" | "stretch";
export function parseImageFit(value: unknown): ImageFit {
  if (value !== "contain" && value !== "cover" && value !== "stretch")
    throw new Error("画像の表示方式を選択してください。");
  return value;
}
export function imageAspectRatio(fit: ImageFit) {
  return fit === "stretch"
    ? "none"
    : fit === "cover"
      ? "xMidYMid slice"
      : "xMidYMid meet";
}
