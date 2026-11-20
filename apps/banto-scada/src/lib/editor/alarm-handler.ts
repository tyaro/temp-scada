import { leadingChars, normalizeAlarms, uniqueAlarmName } from "../alarms";
import type { Project } from "../project";
import { validateAlarmBadgeTarget } from "../alarm-badge";
import { alarmReferences, validateAlarmColorTarget } from "../alarm-references";
import type { ProjectCommand } from "./commands";

type AlarmCommand = Extract<
  ProjectCommand,
  {
    type:
      | "add-alarm-definition"
      | "update-alarm-definition"
      | "duplicate-alarm-definition"
      | "remove-alarm-definition"
      | "set-alarm-blink";
  }
>;

/** 候補の Project だけを変える。検査は applyCommand（parseProject）に任せる。 */
export function applyAlarmCommand(next: Project, command: AlarmCommand): void {
  const alarms = next.alarms ?? { definitions: [] };
  const definitions = alarms.definitions;
  const index = (id: string) => {
    const at = definitions.findIndex((row) => row.id === id);
    if (at < 0) throw new Error("警報の定義が見つかりません");
    return at;
  };
  switch (command.type) {
    case "add-alarm-definition":
      definitions.push(structuredClone(command.definition));
      break;
    case "update-alarm-definition":
      definitions[index(command.definition.id)] = structuredClone(
        command.definition,
      );
      break;
    case "duplicate-alarm-definition": {
      const at = index(command.definitionId);
      const copy = structuredClone(definitions[at]);
      copy.id = command.id;
      copy.name = uniqueAlarmName(
        definitions,
        `${leadingChars(copy.name, 96)} コピー`,
      );
      definitions.splice(at + 1, 0, copy);
      break;
    }
    case "remove-alarm-definition":
      definitions.splice(index(command.definitionId), 1);
      break;
    case "set-alarm-blink":
      alarms.blinkUnacked = command.blinkUnacked;
      break;
  }
  const normalized = normalizeAlarms(alarms);
  if (normalized) next.alarms = normalized;
  else delete next.alarms;
  // 小札・数値の文字が指す定義（小札は限界も）を消す変更は、parseProject の検査より先に
  // 使用中の配置を示して止める。数値の文字は定義の id だけを見るので、種類・限界の変更では
  // 壊れない。数値の文字が壊れるとき（定義の削除）は小札と 1 つの一覧で示す。
  // 仕様: docs/design/graphics/alarm-value-color.md「参照の保護と clipboard」
  const current = next.alarms?.definitions ?? [];
  const broken = next.screens.flatMap((screen) =>
    alarmReferences(screen.objects).flatMap((reference) => {
      try {
        if (reference.kind === "badge")
          validateAlarmBadgeTarget(reference.object.shape, current);
        else validateAlarmColorTarget({ alarmId: reference.alarmId }, current);
        return [];
      } catch {
        const fallback =
          reference.kind === "badge" ? "警報の小札" : "数値の文字";
        return [
          {
            kind: reference.kind,
            label: `${screen.name}／${reference.object.name ?? fallback}`,
          },
        ];
      }
    }),
  );
  const list = (rows: typeof broken) =>
    `${rows
      .slice(0, 5)
      .map((row) => row.label)
      .join("、")}${rows.length > 5 ? " ほか" : ""}`;
  if (broken.some((row) => row.kind === "valueColor"))
    throw new Error(
      `この警報は使用中です：${list(broken)}。先に小札・数値の文字から外すか、指す警報を変えてください。`,
    );
  if (broken.length)
    throw new Error(
      `この警報は警報の小札で使用中です：${list(broken)}。先に小札を削除するか、小札が指す警報を変えてください。`,
    );
}
