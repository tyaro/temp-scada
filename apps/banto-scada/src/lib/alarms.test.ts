import { describe, expect, it } from "vitest";
import sample from "../../../../examples/read-presentation.project.json";
import cases from "../../../../examples/alarm-definition-cases.json";
import { parseProject, serializeProject, type Project } from "./project";
import { applyCommand } from "./editor";
import {
  newAlarmDefinition,
  validateAlarmTagType,
  validateAlarms,
  type AlarmDefinition,
} from "./alarms";
import {
  alarmDefinitionFormCommand,
  alarmDefinitionFormValues,
} from "./designer/forms/alarm-definition-form";

function buildCase(item: (typeof cases)[number]): string {
  const value = structuredClone(sample) as any;
  if (item.alarms !== null) value.alarms = item.alarms;
  return JSON.stringify(value);
}
const ID_A = "0199f6a1-0000-7000-8000-0000000000a1";
const ID_B = "0199f6a1-0000-7000-8000-0000000000b2";
const base = () => parseProject(JSON.stringify(sample));
const form = (values: Record<string, string>) => ({
  get: (key: string) => values[key] ?? null,
});

describe("shared alarm definition contract", () => {
  for (const item of cases)
    it(item.name, () => {
      const parse = () => parseProject(buildCase(item));
      if (!item.valid) {
        expect(parse).toThrow((item as any).error ?? "");
        return;
      }
      const project = parse();
      expect(parseProject(serializeProject(project))).toEqual(project);
      const catalog = (item as any).catalog as
        { externalName: string; type: string }[] | undefined;
      if (!catalog) return;
      const check = () =>
        project.alarms!.definitions.forEach((row) =>
          validateAlarmTagType(row, catalog),
        );
      if ((item as any).validWithCatalog) check();
      else expect(check).toThrow((item as any).error);
    });
});

describe("alarm commands", () => {
  const edit = (
    project: Project,
    command: Parameters<typeof applyCommand>[1],
  ) => applyCommand(project, command, "edit");

  it("adds, duplicates, toggles, removes and drops empty settings", () => {
    let project = base();
    const threshold = newAlarmDefinition(project, "threshold", ID_A);
    project = edit(project, {
      type: "add-alarm-definition",
      definition: threshold,
    });
    expect(project.alarms).toEqual({ definitions: [threshold] });
    project = edit(project, {
      type: "duplicate-alarm-definition",
      definitionId: ID_A,
      id: ID_B,
    });
    expect(project.alarms!.definitions.map((row) => row.name)).toEqual([
      "新しい警報",
      "新しい警報 コピー",
    ]);
    expect(project.alarms!.definitions[1].id).toBe(ID_B);
    project = edit(project, {
      type: "update-alarm-definition",
      definition: { ...project.alarms!.definitions[1], enabled: false },
    });
    expect(project.alarms!.definitions[1].enabled).toBe(false);
    project = edit(project, { type: "set-alarm-blink", blinkUnacked: true });
    project = edit(project, {
      type: "remove-alarm-definition",
      definitionId: ID_A,
    });
    project = edit(project, {
      type: "remove-alarm-definition",
      definitionId: ID_B,
    });
    expect(project.alarms).toEqual({ blinkUnacked: true, definitions: [] });
    project = edit(project, { type: "set-alarm-blink", blinkUnacked: false });
    expect(project).not.toHaveProperty("alarms");
  });

  it("shortens long names without splitting a surrogate pair", () => {
    let project = base();
    // 95 文字の後に絵文字（UTF-16 では 2 単位）を置き、合計 100 文字にする。
    const name = "a".repeat(95) + "🔥" + "bcde";
    project = edit(project, {
      type: "add-alarm-definition",
      definition: { ...newAlarmDefinition(project, "threshold", ID_A), name },
    });
    for (const id of [ID_B, "0199f6a1-0000-7000-8000-0000000000c3"])
      project = edit(project, {
        type: "duplicate-alarm-definition",
        definitionId: ID_A,
        id,
      });
    const names = project.alarms!.definitions.map((row) => row.name);
    expect(names.slice(1)).toEqual([
      "a".repeat(95) + "🔥 コ 2",
      "a".repeat(95) + "🔥 コピー",
    ]);
    for (const copy of names)
      expect(Array.from(copy).length).toBeLessThanOrEqual(100);
    // 保存した Project がそのまま読み直せる（不正なサロゲートが残らない）。
    expect(parseProject(serializeProject(project)).alarms).toEqual(
      project.alarms,
    );
  });

  it("rejects an update that breaks the limit order", () => {
    const project = edit(base(), {
      type: "add-alarm-definition",
      definition: newAlarmDefinition(base(), "threshold", ID_A),
    });
    const broken = structuredClone(project.alarms!.definitions[0]);
    if (broken.source.kind !== "threshold") throw new Error("kind");
    broken.source.limits.l = { value: 200, severity: "low" };
    expect(() =>
      edit(project, { type: "update-alarm-definition", definition: broken }),
    ).toThrow("HH ≥ H > L ≥ LL");
  });
});

describe("alarm definition form", () => {
  const threshold: AlarmDefinition = {
    id: ID_A,
    name: "T-101 温度",
    enabled: false,
    source: {
      kind: "threshold",
      tag: "PLANT.T101.PV",
      limits: {
        hh: { value: 95, severity: "high", message: "異常高" },
        l: { value: 5, severity: "low" },
      },
      deadband: 1,
    },
    onDelayMs: 500,
    ackMode: "autoOnReturn",
  };
  const bit: AlarmDefinition = {
    id: ID_B,
    name: "P-201 故障",
    enabled: true,
    source: { kind: "bit", tag: "PLANT.P201.FAULT", activeWhen: false },
    severity: "medium",
    message: "故障",
  };

  it("round-trips the committed values", () => {
    for (const definition of [threshold, bit])
      expect(
        alarmDefinitionFormCommand(
          form(alarmDefinitionFormValues(definition)),
          definition,
        ),
      ).toEqual({ type: "update-alarm-definition", definition });
  });

  it("drops empty limits and default ack mode", () => {
    const values = alarmDefinitionFormValues(threshold);
    values["l.value"] = "";
    values.deadband = "";
    values.ackMode = "manual";
    values.onDelayMs = " ";
    const command = alarmDefinitionFormCommand(form(values), threshold);
    expect(command).toEqual({
      type: "update-alarm-definition",
      definition: {
        id: ID_A,
        name: "T-101 温度",
        enabled: false,
        source: {
          kind: "threshold",
          tag: "PLANT.T101.PV",
          limits: { hh: { value: 95, severity: "high", message: "異常高" } },
        },
      },
    });
  });

  it("keeps the external tag name exactly, including surrounding spaces", () => {
    const values = alarmDefinitionFormValues(bit);
    const command = alarmDefinitionFormCommand(
      form({ ...values, tag: " PLANT.P201.FAULT " }),
      bit,
      [{ externalName: " PLANT.P201.FAULT ", type: "bit" }],
    );
    expect(command).toMatchObject({
      definition: { source: { tag: " PLANT.P201.FAULT " } },
    });
    expect(() =>
      alarmDefinitionFormCommand(form({ ...values, tag: "  " }), bit),
    ).toThrow("タグの外部名を入力");
  });

  it("reports input errors in Japanese", () => {
    const values = alarmDefinitionFormValues(threshold);
    expect(() =>
      alarmDefinitionFormCommand(form({ ...values, name: " " }), threshold),
    ).toThrow("名前を入力");
    expect(() =>
      alarmDefinitionFormCommand(
        form({ ...values, "hh.value": "", "l.value": "" }),
        threshold,
      ),
    ).toThrow("1 つ以上");
    expect(() =>
      alarmDefinitionFormCommand(
        form({ ...values, "hh.value": "abc" }),
        threshold,
      ),
    ).toThrow("HH の値は数で");
    expect(() =>
      alarmDefinitionFormCommand(
        form({ ...values, offDelayMs: "600001" }),
        threshold,
      ),
    ).toThrow("0〜600000");
    const wide = alarmDefinitionFormCommand(
      form({ ...values, "hh.value": "9007199254740993" }),
      threshold,
    );
    expect(() =>
      validateAlarms({
        definitions: [(wide as { definition: AlarmDefinition }).definition],
      }),
    ).toThrow("±9007199254740991");
    expect(() =>
      alarmDefinitionFormCommand(form(alarmDefinitionFormValues(bit)), bit, [
        { externalName: "PLANT.P201.FAULT", type: "f32" },
      ]),
    ).toThrow("bit 型");
  });
});
