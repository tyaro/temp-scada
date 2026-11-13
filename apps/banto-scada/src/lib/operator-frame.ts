import type { OperatorFrame, Project } from "./project";

/**
 * 運転表示の枠の純関数。仕様: docs/design/graphics/operator-frame.md
 * 画面の存在・別画面・行き先の制限は Project の検査（Rust / TS）と同じ規則。
 */

export const OPERATOR_FRAME_KEYS = [
  "startScreenId",
  "headerScreenId",
  "footerScreenId",
] as const;

/** 空の欄を落とす。中身がすべて空なら undefined（`operatorFrame` ごと保存しない）。 */
export function normalizeOperatorFrame(
  frame: Partial<Record<(typeof OPERATOR_FRAME_KEYS)[number], string>>,
): OperatorFrame | undefined {
  const out: OperatorFrame = {};
  for (const key of OPERATOR_FRAME_KEYS) {
    const value = frame[key];
    if (value) out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

/** 枠の検査。違反は Error。 */
export function validateOperatorFrame(
  frame: OperatorFrame | undefined,
  project: Pick<Project, "screens">,
): void {
  if (!frame) return;
  const ids = new Set(project.screens.map((s) => s.id));
  const used: string[] = [];
  for (const key of OPERATOR_FRAME_KEYS) {
    const id = frame[key];
    if (id === undefined) continue;
    if (!ids.has(id)) throw new Error("運転表示の枠の画面が見つかりません");
    if (used.includes(id))
      throw new Error(
        "運転表示の開始・ヘッダー・フッターは別の画面にしてください",
      );
    used.push(id);
  }
  const framed = frameScreenIds(frame);
  for (const screen of project.screens)
    for (const object of screen.objects)
      if (
        object.shape.type === "navButton" &&
        object.shape.target?.kind === "screen" &&
        framed.has(object.shape.target.screenId)
      )
        throw new Error(
          "ヘッダー・フッターの画面は画面切替ボタンの行き先にできません",
        );
}

/** 画面切替ボタンの行き先にできないヘッダー・フッターの画面 id。 */
export function frameScreenIds(frame: OperatorFrame | undefined): Set<string> {
  return new Set(
    [frame?.headerScreenId, frame?.footerScreenId].filter(
      (id): id is string => !!id,
    ),
  );
}

/** 枠での使われ方。削除の拒否の理由に使う。使われていなければ undefined。 */
export function operatorFrameRole(
  frame: OperatorFrame | undefined,
  screenId: string,
): string | undefined {
  if (frame?.startScreenId === screenId) return "開始画面";
  if (frame?.headerScreenId === screenId) return "ヘッダー画面";
  if (frame?.footerScreenId === screenId) return "フッター画面";
  return undefined;
}
