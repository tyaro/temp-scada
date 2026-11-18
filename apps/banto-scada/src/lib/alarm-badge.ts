import {
  ALARM_LIMIT_KEYS,
  leadingChars,
  type AlarmDefinition,
  type AlarmLimitKey,
} from "./alarms";
import type { AlarmBadgeShape, Project } from "./project";

/**
 * 警報の小札の純関数（検査・既定値・選択肢）。仕様: docs/design/graphics/alarm-badge.md
 * 検査は Rust（crates/scada-model/src/alarms.rs の validate_badges）と同じ規則。
 * Symbol 定義の中に置けないことは schema が受け持つ。
 */

/** 小札が指す condition の id。しきい値は `${定義の id}:${限界}`、bit は定義の id。 */
export function alarmBadgeConditionId(
  shape: Pick<AlarmBadgeShape, "alarmId" | "limit">,
): string {
  return shape.limit ? `${shape.alarmId}:${shape.limit}` : shape.alarmId;
}

/** 小札が指す定義と限界が Project にあるか。違反は Error。 */
export function validateAlarmBadgeTarget(
  shape: Pick<AlarmBadgeShape, "alarmId" | "limit">,
  definitions: readonly AlarmDefinition[],
): AlarmDefinition {
  const definition = definitions.find((row) => row.id === shape.alarmId);
  if (!definition)
    throw new Error("警報の小札が指す警報の定義が見つかりません");
  if (definition.source.kind === "threshold") {
    if (!shape.limit)
      throw new Error(
        "しきい値の警報を指す小札には限界（HH・H・L・LL）を選んでください",
      );
    if (!definition.source.limits[shape.limit])
      throw new Error("警報の小札が指す限界が警報の定義にありません");
  } else if (shape.limit)
    throw new Error("bit の警報を指す小札には限界を付けられません");
  return definition;
}

/**
 * 貼り付ける小札が貼付け先の定義を指せるか。定義は id で照合し、clipboard の
 * 定義は取り込まない（名前は文言にだけ使う）。指せなければ Error。
 */
export function assertAlarmBadgePasteTarget(
  shape: Pick<AlarmBadgeShape, "alarmId" | "limit">,
  copied: readonly AlarmDefinition[],
  destination: readonly AlarmDefinition[],
): void {
  try {
    validateAlarmBadgeTarget(shape, destination);
  } catch {
    const name =
      copied.find((row) => row.id === shape.alarmId)?.name ?? shape.alarmId;
    const label = shape.limit ? `${name} ${shape.limit.toUpperCase()}` : name;
    throw new Error(
      `貼り付け先の Project に、警報の小札が指す警報「${label}」の定義がありません。警報の定義は id で照合します。コピー元の Project か、その定義を引き継いだ Project へ貼り付けるか、小札を除いてコピーしてください。`,
    );
  }
}

/** 画面の直下の小札をすべて確かめる（parseProject から呼ぶ）。 */
export function validateAlarmBadges(project: Project): void {
  const definitions = project.alarms?.definitions ?? [];
  for (const screen of project.screens)
    for (const object of screen.objects)
      if (object.shape.type === "alarmBadge")
        validateAlarmBadgeTarget(object.shape, definitions);
}

/** 小札が指せる (定義, 限界) の組。しきい値は定義にある限界を hh→h→l→ll の順で。 */
export interface AlarmBadgeTarget {
  alarmId: string;
  limit?: AlarmLimitKey;
  /** select の値。condition id と同じ形。 */
  value: string;
  /** 「T-01 温度 HH」のような表示名。 */
  label: string;
}
export function alarmBadgeTargets(
  definitions: readonly AlarmDefinition[],
): AlarmBadgeTarget[] {
  return definitions.flatMap((definition): AlarmBadgeTarget[] => {
    const source = definition.source;
    if (source.kind === "bit")
      return [
        {
          alarmId: definition.id,
          value: definition.id,
          label: definition.name,
        },
      ];
    return ALARM_LIMIT_KEYS.filter((limit) => source.limits[limit]).map(
      (limit) => ({
        alarmId: definition.id,
        limit,
        value: `${definition.id}:${limit}`,
        label: `${definition.name} ${limit.toUpperCase()}`,
      }),
    );
  });
}

/** 小札が指す先の表示名（定義が無ければ undefined）。 */
export function alarmBadgeTargetLabel(
  shape: Pick<AlarmBadgeShape, "alarmId" | "limit">,
  definitions: readonly AlarmDefinition[],
): string | undefined {
  const definition = definitions.find((row) => row.id === shape.alarmId);
  if (!definition) return undefined;
  return shape.limit
    ? `${definition.name} ${shape.limit.toUpperCase()}`
    : definition.name;
}

/** 小札の既定の文字。しきい値は限界名（HH など）、bit は「ALM」。 */
export function defaultAlarmBadgeText(target: AlarmBadgeTarget): string {
  return target.limit ? target.limit.toUpperCase() : "ALM";
}

/** 追加のときの形。定義が無ければ Error（パレットのボタンは無効にしている）。 */
export function newAlarmBadgeShape(
  project: Pick<Project, "alarms">,
): AlarmBadgeShape {
  const target = alarmBadgeTargets(project.alarms?.definitions ?? [])[0];
  if (!target) throw new Error(ALARM_BADGE_NO_DEFINITIONS);
  return {
    type: "alarmBadge",
    alarmId: target.alarmId,
    ...(target.limit ? { limit: target.limit } : {}),
    text: leadingChars(defaultAlarmBadgeText(target), 200),
    style: { fontSize: 12, fontWeight: "bold" },
  };
}

export const ALARM_BADGE_NO_DEFINITIONS = "警報の定義がありません";
