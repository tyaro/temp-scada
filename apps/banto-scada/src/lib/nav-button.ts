import type { NavButtonShape, NavTarget, Project } from "./project";

/**
 * 画面切替ボタンの純関数。仕様: docs/design/graphics/nav-button.md
 * 行き先の画面の存在は Project の検査（Rust / TS）が受け持つ。
 */

const COLOR = /^#[0-9a-fA-F]{6}$/;

/** Inspector からの内容を検査する。`project` を渡すと行き先の画面の存在も確かめる。 */
export function validateNavButtonShape(
  shape: NavButtonShape,
  project?: Pick<Project, "screens">,
): void {
  const target = shape.target;
  if (target !== undefined) {
    if (target.kind === "screen") {
      if (typeof target.screenId !== "string" || !target.screenId)
        throw new Error("画面切替ボタンの行き先の画面を選択してください");
      if (project && !project.screens.some((s) => s.id === target.screenId))
        throw new Error("画面切替ボタンの行き先の画面が見つかりません");
    } else if (target.kind !== "back" && target.kind !== "forward")
      throw new Error("画面切替ボタンの行き先を選択してください");
  }
  if (typeof shape.label !== "string" || shape.label.length > 200)
    throw new Error("ボタンの文字は200文字以内にしてください");
  if (/[\r\n]|\p{Zl}|\p{Zp}/u.test(shape.label))
    throw new Error("ボタンの文字は1行にしてください");
  if (
    !Number.isFinite(shape.fontSize) ||
    shape.fontSize <= 0 ||
    shape.fontSize > 512
  )
    throw new Error("文字サイズは0より大きく512以下にしてください");
  for (const color of [
    shape.fill,
    shape.textColor,
    shape.currentFill,
    shape.currentTextColor,
  ])
    if (color !== undefined && !COLOR.test(color))
      throw new Error("色は#と6桁の16進数で指定してください");
}

/** 行き先が表示中の画面か。戻る・進む・未設定は強調しない。 */
export function navButtonIsCurrent(
  shape: Pick<NavButtonShape, "target">,
  currentScreenId: string | undefined,
): boolean {
  return (
    shape.target?.kind === "screen" &&
    currentScreenId !== undefined &&
    shape.target.screenId === currentScreenId
  );
}

/** 表示する塗りと文字色。現在の画面の色が無いときは通常の色を使う。 */
export function navButtonColors(
  shape: NavButtonShape,
  current: boolean,
): { fill: string; textColor: string } {
  return current
    ? {
        fill: shape.currentFill ?? shape.fill,
        textColor: shape.currentTextColor ?? shape.textColor,
      }
    : { fill: shape.fill, textColor: shape.textColor };
}

/**
 * プレビューで押したときに移る画面。編集中・未設定・戻る・進む（履歴は運転表示で扱う）は移らない。
 */
export function navButtonDestination(
  shape: Pick<NavButtonShape, "target">,
  preview: boolean,
): string | undefined {
  return preview && shape.target?.kind === "screen"
    ? shape.target.screenId
    : undefined;
}

/** プレビューで押せないボタン（未設定・戻る・進む）は薄く表示する。 */
export function navButtonDisabled(
  shape: Pick<NavButtonShape, "target">,
  preview: boolean,
): boolean {
  return preview && shape.target?.kind !== "screen";
}

/** 行き先の説明（レイヤー・Inspector・読み上げ用）。 */
export function navTargetLabel(
  target: NavTarget | undefined,
  screens: readonly { id: string; name: string }[],
): string {
  if (!target) return "行き先未設定";
  if (target.kind === "back") return "戻る";
  if (target.kind === "forward") return "進む";
  return (
    screens.find((s) => s.id === target.screenId)?.name ?? "見つからない画面"
  );
}
