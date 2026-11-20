import type { AlarmDefinition } from "./alarms";
import type { Project, ScreenObject } from "./project";

/**
 * 警報の定義を指す配置（警報の小札・`alarmColor` を持つ数値の Text）を集める。
 * 使用中の表示（`editor/alarm-handler.ts`）と clipboard の添える定義（`clipboard.ts`）の共通部分。
 * 指す先の検査は種類ごとに別（小札: `alarm-badge.ts`、数値の文字: 下の関数）。
 * 仕様: docs/design/graphics/alarm-value-color.md「参照の保護と clipboard」
 */
export type AlarmReference =
  | {
      kind: "badge";
      alarmId: string;
      object: ScreenObject & { shape: { type: "alarmBadge" } };
    }
  | {
      kind: "valueColor";
      alarmId: string;
      object: ScreenObject & { shape: { type: "text" } };
    };

/** 配置の並びのまま、警報の定義を指すものを返す。 */
export function alarmReferences(
  objects: readonly ScreenObject[],
): AlarmReference[] {
  return objects.flatMap((object): AlarmReference[] => {
    const shape = object.shape;
    if (shape.type === "alarmBadge")
      return [
        {
          kind: "badge",
          alarmId: shape.alarmId,
          object: object as ScreenObject & { shape: typeof shape },
        },
      ];
    if (shape.type === "text" && shape.alarmColor)
      return [
        {
          kind: "valueColor",
          alarmId: shape.alarmColor.alarmId,
          object: object as ScreenObject & { shape: typeof shape },
        },
      ];
    return [];
  });
}

/** 配置が指す警報の定義の id（同じ定義は 1 件）。 */
export function referencedAlarmIds(
  objects: readonly ScreenObject[],
): Set<string> {
  return new Set(alarmReferences(objects).map((row) => row.alarmId));
}

/** 数値の Text の `alarmColor` が指す定義が Project にあるか。無ければ Error。 */
export function validateAlarmColorTarget(
  color: { alarmId: string },
  definitions: readonly AlarmDefinition[],
): AlarmDefinition {
  const definition = definitions.find((row) => row.id === color.alarmId);
  if (!definition)
    throw new Error("数値の警報の色が指す警報の定義が見つかりません");
  return definition;
}

/**
 * 貼り付ける数値の Text が貼付け先の定義を指せるか。定義は id で照合し、clipboard の
 * 定義は取り込まない（名前は文言にだけ使う）。指せなければ Error。
 */
export function assertAlarmColorPasteTarget(
  color: { alarmId: string },
  copied: readonly AlarmDefinition[],
  destination: readonly AlarmDefinition[],
): void {
  if (destination.some((row) => row.id === color.alarmId)) return;
  const name =
    copied.find((row) => row.id === color.alarmId)?.name ?? color.alarmId;
  throw new Error(
    `貼り付け先の Project に、数値の文字が指す警報「${name}」の定義がありません。警報の定義は id で照合します。コピー元の Project か、その定義を引き継いだ Project へ貼り付けるか、数値の文字の警報の色を外してコピーしてください。`,
  );
}

/** 画面の直下の数値の Text の `alarmColor` をすべて確かめる（parseProject から呼ぶ）。 */
export function validateAlarmColors(project: Project): void {
  const definitions = project.alarms?.definitions ?? [];
  for (const screen of project.screens)
    for (const object of screen.objects)
      if (object.shape.type === "text" && object.shape.alarmColor)
        validateAlarmColorTarget(object.shape.alarmColor, definitions);
}
