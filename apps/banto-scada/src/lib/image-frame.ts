/** Frame placement uses the visible intersection, never upscales the original. */
export function initialImageFrame(
  source: { width: number; height: number },
  screen: { width: number; height: number },
  visible: { x: number; y: number; width: number; height: number },
) {
  const left = Math.max(0, visible.x),
    top = Math.max(0, visible.y),
    right = Math.min(screen.width, visible.x + visible.width),
    bottom = Math.min(screen.height, visible.y + visible.height);
  const intersects = right > left && bottom > top;
  const area = intersects
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : { x: 0, y: 0, ...screen };
  const scale = Math.min(
    1,
    (area.width * 0.8) / source.width,
    (area.height * 0.8) / source.height,
  );
  const width = source.width * scale,
    height = source.height * scale;
  return {
    x: area.x + (area.width - width) / 2,
    y: area.y + (area.height - height) / 2,
    width,
    height,
  };
}
