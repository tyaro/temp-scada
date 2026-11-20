import type { EditCommand } from "../../editor";
import type { AlarmDefinition } from "../../alarms";
import type { ScreenObject } from "../../project";

/**
 * 数値の Text の「警報の色」フォームの純関数。
 * 仕様: docs/design/graphics/alarm-value-color.md の「編集（Inspector）」。
 */

export const ALARM_COLOR_NO_DEFINITIONS = "警報の定義がありません";

/** フォームを出すか。画面直下のタグ結合の Text で boolDisplay が無い、または解除のため alarmColor を持つもの。 */
export function showsAlarmColorForm(
  shape: ScreenObject["shape"],
  inDefinition: boolean,
): boolean {
  return (
    shape.type === "text" &&
    !inDefinition &&
    !!shape.binding &&
    (!shape.boolDisplay || !!shape.alarmColor)
  );
}

export interface AlarmColorOption {
  value: string;
  label: string;
}
export interface AlarmColorGroup {
  label: string;
  options: AlarmColorOption[];
}

/** 結合しているタグの定義を先に、ほかのタグの定義を後に。空の群は出さない。 */
export function alarmColorGroups(
  definitions: readonly AlarmDefinition[],
  externalName: string | undefined,
): AlarmColorGroup[] {
  const option = (row: AlarmDefinition): AlarmColorOption => ({
    value: row.id,
    label: row.enabled ? row.name : `${row.name}（無効）`,
  });
  const same = definitions.filter((row) => row.source.tag === externalName);
  const other = definitions.filter((row) => row.source.tag !== externalName);
  return [
    { label: "このタグの警報", options: same.map(option) },
    { label: "ほかのタグの警報", options: other.map(option) },
  ].filter((group) => group.options.length);
}

export interface AlarmColorInput {
  data: Pick<FormData, "get">;
  objectId?: string;
  targetKey?: string;
}
export interface AlarmColorContext {
  generation: number;
  screenId: string;
  definition: boolean;
  selected: ScreenObject | undefined;
}

/** 1 確定 1 Undo。空は解除（null）。 */
export function alarmColorCommand(
  input: AlarmColorInput,
  context: AlarmColorContext,
): EditCommand {
  const selected = context.selected;
  if (
    input.targetKey !==
      `${context.generation}:${context.screenId}:${context.definition}` ||
    selected?.id !== input.objectId ||
    selected?.shape.type !== "text" ||
    context.definition ||
    !selected.shape.binding
  )
    throw new Error(
      "警報の色の適用先が変更されています。選択し直してください。",
    );
  const alarmId = String(input.data.get("alarmId") ?? "").trim();
  return {
    type: "update",
    screenId: context.screenId,
    objectId: selected.id,
    patch: { alarmColor: alarmId ? { alarmId } : null },
  };
}
