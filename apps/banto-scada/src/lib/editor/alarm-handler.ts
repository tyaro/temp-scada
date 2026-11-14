import { leadingChars, normalizeAlarms, uniqueAlarmName } from "../alarms";
import type { Project } from "../project";
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
}
