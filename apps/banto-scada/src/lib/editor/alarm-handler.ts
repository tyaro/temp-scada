import { leadingChars, normalizeAlarms, uniqueAlarmName } from "../alarms";
import type { Project } from "../project";
import { validateAlarmBadgeTarget } from "../alarm-badge";
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
  // 小札が指す定義・限界を消す変更は、parseProject の検査より先に使用中の小札を示して止める。
  const broken = next.screens.flatMap((screen) =>
    screen.objects.flatMap((object) => {
      if (object.shape.type !== "alarmBadge") return [];
      try {
        validateAlarmBadgeTarget(object.shape, next.alarms?.definitions ?? []);
        return [];
      } catch {
        return [`${screen.name}／${object.name ?? "警報の小札"}`];
      }
    }),
  );
  if (broken.length)
    throw new Error(
      `この警報は警報の小札で使用中です：${broken.slice(0, 5).join("、")}${broken.length > 5 ? " ほか" : ""}。先に小札を削除するか、小札が指す警報を変えてください。`,
    );
}
