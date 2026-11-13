import type { OperatorFrame } from "../project";

/**
 * 運転表示の枠の配置と開始画面。純関数。仕様: docs/design/graphics/operator-frame.md
 */

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface OperatorLayout {
  /** 設計の座標から窓の画素への倍率（主画面の1単位が何画素か）。 */
  readonly scale: number;
  /** 窓の中の、枠と主画面を合わせた全体（画素）。 */
  readonly frame: Box;
  /** 全体の左上を原点にした各領域（画素）。 */
  readonly header?: Box;
  readonly main: Box;
  readonly footer?: Box;
}

const valid = (size: Size | undefined): size is Size =>
  !!size &&
  Number.isFinite(size.width) &&
  Number.isFinite(size.height) &&
  size.width > 0 &&
  size.height > 0;

/**
 * ヘッダー・フッターを主画面の幅に合わせて拡大縮小し（縦横比は保つ）、上・主画面・下と縦に並べた全体を
 * 窓に収める（contain、中央寄せ）。窓が空のときは倍率 0。
 */
export function operatorLayout(
  viewport: Size,
  main: Size,
  header?: Size,
  footer?: Size,
): OperatorLayout {
  const headerHeight = valid(header)
    ? (header.height * main.width) / header.width
    : 0;
  const footerHeight = valid(footer)
    ? (footer.height * main.width) / footer.width
    : 0;
  const designHeight = headerHeight + main.height + footerHeight;
  const scale =
    valid(viewport) && valid(main)
      ? Math.min(viewport.width / main.width, viewport.height / designHeight)
      : 0;
  const width = main.width * scale,
    height = designHeight * scale;
  const frame = {
    x: Math.max(0, (viewport.width - width) / 2),
    y: Math.max(0, (viewport.height - height) / 2),
    width,
    height,
  };
  return {
    scale,
    frame,
    header: valid(header)
      ? { x: 0, y: 0, width, height: headerHeight * scale }
      : undefined,
    main: {
      x: 0,
      y: headerHeight * scale,
      width,
      height: main.height * scale,
    },
    footer: valid(footer)
      ? {
          x: 0,
          y: (headerHeight + main.height) * scale,
          width,
          height: footerHeight * scale,
        }
      : undefined,
  };
}

/**
 * 運転表示の開始画面。枠の開始画面があればそれ、なければ入口を押したときの Designer の画面。
 * Designer の画面がヘッダー・フッターの画面なら、枠に使っていない最初の画面にする。
 */
export function operatorStartScreen(
  frame: OperatorFrame | undefined,
  screens: readonly { id: string }[],
  designerScreenId: string,
): string | undefined {
  const exists = (id: string | undefined): id is string =>
    !!id && screens.some((s) => s.id === id);
  if (exists(frame?.startScreenId)) return frame.startScreenId;
  const framed = [frame?.headerScreenId, frame?.footerScreenId];
  if (exists(designerScreenId) && !framed.includes(designerScreenId))
    return designerScreenId;
  return (
    screens.find((s) => !framed.includes(s.id))?.id ??
    (exists(designerScreenId) ? designerScreenId : screens[0]?.id)
  );
}
