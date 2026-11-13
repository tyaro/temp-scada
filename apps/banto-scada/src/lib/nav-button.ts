import type { NavButtonShape, NavTarget, Project } from "./project";
import { frameScreenIds } from "./operator-frame";

/**
 * 画面切替ボタンの純関数。仕様: docs/design/graphics/nav-button.md
 * 行き先の画面の存在は Project の検査（Rust / TS）が受け持つ。
 */

const COLOR = /^#[0-9a-fA-F]{6}$/;

/** Inspector からの内容を検査する。`project` を渡すと行き先の画面の存在も確かめる。 */
export function validateNavButtonShape(
  shape: NavButtonShape,
  project?: Pick<Project, "screens" | "operatorFrame">,
): void {
  const target = shape.target;
  if (target !== undefined) {
    if (target.kind === "screen") {
      if (typeof target.screenId !== "string" || !target.screenId)
        throw new Error("画面切替ボタンの行き先の画面を選択してください");
      if (project && !project.screens.some((s) => s.id === target.screenId))
        throw new Error("画面切替ボタンの行き先の画面が見つかりません");
      if (project && frameScreenIds(project.operatorFrame).has(target.screenId))
        throw new Error(
          "ヘッダー・フッターの画面は画面切替ボタンの行き先にできません",
        );
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

/** 運転表示の履歴の状態。プレビューは履歴を持たない（渡さない）。 */
export interface NavHistoryState {
  readonly canBack: boolean;
  readonly canForward: boolean;
}

/**
 * 表示確認で押したときの動き。編集中・未設定は undefined。戻る・進むは履歴を渡され、
 * その向きへ動けるときだけ返す（プレビューは履歴を渡さないので押せない）。
 */
export function navButtonAction(
  shape: Pick<NavButtonShape, "target">,
  preview: boolean,
  history?: NavHistoryState,
): NavTarget | undefined {
  const target = shape.target;
  if (!preview || !target) return undefined;
  if (target.kind === "screen") return target;
  if (target.kind === "back") return history?.canBack ? target : undefined;
  return history?.canForward ? target : undefined;
}

/** 押せないボタン（未設定、履歴で動けない戻る・進む）は表示確認で薄く表示する。 */
export function navButtonDisabled(
  shape: Pick<NavButtonShape, "target">,
  preview: boolean,
  history?: NavHistoryState,
): boolean {
  return preview && !navButtonAction(shape, preview, history);
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
