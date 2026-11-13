import type { EditCommand } from "../../editor";
import { OPERATOR_FRAME_KEYS } from "../../operator-frame";

/** 「運転表示の設定」フォームから枠の設定コマンドを作る。空の選択は「なし」。 */
export function operatorFrameFormCommand(
  data: Pick<FormData, "get">,
): EditCommand {
  const frame: Record<string, string> = {};
  for (const key of OPERATOR_FRAME_KEYS) {
    const value = String(data.get(key) ?? "");
    if (value) frame[key] = value;
  }
  return { type: "set-operator-frame", frame };
}
