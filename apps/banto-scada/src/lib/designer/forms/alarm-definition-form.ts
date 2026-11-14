import type { EditCommand } from "../../editor";
import {
  ALARM_LIMIT_KEYS,
  MAX_ALARM_DELAY_MS,
  validateAlarmTagType,
  type AlarmAckMode,
  type AlarmDefinition,
  type AlarmLimit,
  type AlarmSeverity,
} from "../../alarms";

type Fields = Pick<FormData, "get">;
const text = (data: Fields, key: string) => String(data.get(key) ?? "").trim();

function number(data: Fields, key: string, label: string) {
  const raw = text(data, key);
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value))
    throw new Error(`${label}は数で入力してください`);
  return value;
}
function delay(data: Fields, key: string, label: string) {
  const value = number(data, key, label);
  if (
    value !== undefined &&
    (!Number.isInteger(value) || value < 0 || value > MAX_ALARM_DELAY_MS)
  )
    throw new Error(
      `${label}は 0〜${MAX_ALARM_DELAY_MS} ms の整数にしてください`,
    );
  return value;
}

/** 詳細フォームの値を、検査を通る形の定義のコマンドにする。種類と有効は `base` のまま。 */
export function alarmDefinitionFormCommand(
  data: Fields,
  base: AlarmDefinition,
  tags?: readonly { externalName: string; type: string }[],
): EditCommand {
  const name = text(data, "name");
  if (!name) throw new Error("警報の名前を入力してください");
  // タグの外部名は前後の空白も名前の一部なので、そのまま保存する（空かどうかだけ trim で見る）。
  const tag = String(data.get("tag") ?? "");
  if (!tag.trim()) throw new Error("タグの外部名を入力してください");
  const definition: AlarmDefinition = {
    id: base.id,
    name,
    enabled: base.enabled,
    source:
      base.source.kind === "bit"
        ? { kind: "bit", tag, activeWhen: text(data, "activeWhen") !== "false" }
        : { kind: "threshold", tag, limits: {} },
  };
  if (definition.source.kind === "threshold") {
    for (const key of ALARM_LIMIT_KEYS) {
      const value = number(data, `${key}.value`, `${key.toUpperCase()} の値`);
      if (value === undefined) continue;
      const limit: AlarmLimit = {
        value,
        severity: (text(data, `${key}.severity`) || "medium") as AlarmSeverity,
      };
      const message = text(data, `${key}.message`);
      if (message) limit.message = message;
      definition.source.limits[key] = limit;
    }
    if (!Object.keys(definition.source.limits).length)
      throw new Error("限界（HH／H／L／LL）を 1 つ以上入力してください");
    const deadband = number(data, "deadband", "deadband");
    if (deadband !== undefined) definition.source.deadband = deadband;
  } else {
    definition.severity = (text(data, "severity") || "high") as AlarmSeverity;
    const message = text(data, "message");
    if (message) definition.message = message;
  }
  const onDelayMs = delay(data, "onDelayMs", "発生の遅延");
  if (onDelayMs !== undefined) definition.onDelayMs = onDelayMs;
  const offDelayMs = delay(data, "offDelayMs", "復帰の遅延");
  if (offDelayMs !== undefined) definition.offDelayMs = offDelayMs;
  const ackMode = text(data, "ackMode") as AlarmAckMode;
  if (ackMode && ackMode !== "manual") definition.ackMode = ackMode;
  if (tags) validateAlarmTagType(definition, tags);
  return { type: "update-alarm-definition", definition };
}

/** 詳細フォームの確定値（drafts.track に渡す）。 */
export function alarmDefinitionFormValues(
  definition: AlarmDefinition,
): Record<string, string> {
  const values: Record<string, string> = {
    name: definition.name,
    tag: definition.source.tag,
    onDelayMs: definition.onDelayMs?.toString() ?? "",
    offDelayMs: definition.offDelayMs?.toString() ?? "",
    ackMode: definition.ackMode ?? "manual",
  };
  if (definition.source.kind === "threshold") {
    for (const key of ALARM_LIMIT_KEYS) {
      const limit = definition.source.limits[key];
      values[`${key}.value`] = limit?.value.toString() ?? "";
      values[`${key}.severity`] = limit?.severity ?? "medium";
      values[`${key}.message`] = limit?.message ?? "";
    }
    values.deadband = definition.source.deadband?.toString() ?? "";
  } else {
    values.activeWhen = String(definition.source.activeWhen);
    values.severity = definition.severity ?? "high";
    values.message = definition.message ?? "";
  }
  return values;
}
