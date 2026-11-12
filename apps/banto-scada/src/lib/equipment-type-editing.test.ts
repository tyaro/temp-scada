import { it, expect } from "vitest";
import sample from "../../../../examples/symbol-slots.project.json";
import { equipmentTypeFormCommand } from "./designer/forms/equipment-type";
import { parseProject, serializeProject } from "./project";
import { applyCommand } from "./editor";
const project = parseProject(JSON.stringify(sample));
const slots = [{ name: "pressure", type: "number", direction: "read" }];
function input(typeId = "", encoded = JSON.stringify(slots)) {
  const data = new FormData();
  data.set("name", "圧力計");
  data.set("slots", encoded);
  return {
    connected: true,
    typeId,
    targetKey: `3:${project.manifest.projectId}:${typeId || "new"}`,
    data,
  };
}
it("builds one command containing the name and complete structure; refuses stale targets", () => {
  const source = input();
  expect(equipmentTypeFormCommand(source, project, 3)).toEqual({
    type: "create-equipment-type",
    name: "圧力計",
    slots,
  });
  const id = project.equipmentTypes![0].id;
  expect(equipmentTypeFormCommand(input(id), project, 3)).toEqual({
    type: "update-equipment-type",
    typeId: id,
    name: "圧力計",
    slots,
  });
  for (const changed of [
    { ...source, connected: false },
    { ...source, targetKey: "wrong" },
    input("missing"),
  ])
    expect(() => equipmentTypeFormCommand(changed, project, 3)).toThrow();
  expect(() => equipmentTypeFormCommand(source, project, 4)).toThrow();
});
it.each([
  "oops",
  JSON.stringify([{ name: "pressure\n", type: "number", direction: "read" }]),
  "null",
  "{}",
  JSON.stringify([{ name: "write", type: "bool", direction: "write" }]),
  JSON.stringify([{ name: "", type: "bool", direction: "read" }]),
  JSON.stringify([...slots, ...slots]),
  JSON.stringify(
    Array.from({ length: 65 }, (_, i) => ({ ...slots[0], name: `role${i}` })),
  ),
])("refuses invalid or oversized row structure: %s", (encoded) => {
  expect(() =>
    equipmentTypeFormCommand(input("", encoded), project, 3),
  ).toThrow();
});
it("keeps adopted null slots protected and rejects changes without a partial type rename", () => {
  const id = project.equipmentTypes![0].id;
  const before = serializeProject(project);
  expect(() =>
    applyCommand(
      project,
      equipmentTypeFormCommand(input(id), project, 3),
      "edit",
    ),
  ).toThrow("採用中slot");
  expect(serializeProject(project)).toBe(before);
});
it("keeps state and bool displays and allowUnassigned through the form and the edit", () => {
  const stateful = [
    {
      name: "status",
      type: "state",
      direction: "read",
      stateDisplay: {
        source: "bits",
        rows: [{ match: 3, text: "故障", color: "#dc2626" }],
        otherwise: { text: "停止", color: "#64748b" },
      },
    },
    {
      name: "fault",
      type: "bool",
      direction: "read",
      allowUnassigned: true,
      boolDisplay: {
        true: { text: "故障", color: "#dc2626" },
        false: { text: "", color: "#64748b" },
      },
    },
  ];
  const command = equipmentTypeFormCommand(
    input(
      "",
      JSON.stringify([...stateful, { ...slots[0], allowUnassigned: false }]),
    ),
    project,
    3,
  );
  expect(command).toEqual({
    type: "create-equipment-type",
    name: "圧力計",
    slots: [...stateful, slots[0]],
  });
  const next = applyCommand(project, command, "edit");
  expect(next.equipmentTypes!.at(-1)!.slots).toEqual([...stateful, slots[0]]);
});
it("keeps a tag suffix as typed, drops an empty one and refuses a blank or long one", () => {
  const command = equipmentTypeFormCommand(
    input(
      "",
      JSON.stringify([
        { ...slots[0], tagSuffix: " .Pressure " },
        { name: "running", type: "bool", direction: "read", tagSuffix: "" },
      ]),
    ),
    project,
    3,
  );
  const saved = [
    { ...slots[0], tagSuffix: " .Pressure " },
    { name: "running", type: "bool", direction: "read" },
  ];
  expect(command).toMatchObject({ slots: saved });
  const next = applyCommand(project, command, "edit");
  expect(next.equipmentTypes!.at(-1)!.slots).toEqual(saved);
  expect(parseProject(serializeProject(next))).toEqual(next);
  for (const [tagSuffix, reason] of [
    [" 　", /空白だけ/],
    ["x".repeat(513), /512文字以内/],
    [1, /入力が不正/],
  ] as const)
    expect(() =>
      equipmentTypeFormCommand(
        input("", JSON.stringify([{ ...slots[0], tagSuffix }])),
        project,
        3,
      ),
    ).toThrow(reason);
});
it("rejects state rows the schema or the duplicate check refuses, in the form and when applied", () => {
  for (const [rows, formReason, applyReason] of [
    [[{ match: 32, text: "x", color: "#000000" }], /0〜31/, /31/],
    [
      [
        { match: 1, text: "a", color: "#000000" },
        { match: 1, text: "b", color: "#000000" },
      ],
      /同じビットの行が上にあります/,
      /重複/,
    ],
  ] as const) {
    const slots = [
      {
        name: "status",
        type: "state" as const,
        direction: "read" as const,
        stateDisplay: {
          source: "bits" as const,
          rows: rows.map((row) => ({ ...row })),
          otherwise: { text: "", color: "#64748b" },
        },
      },
    ];
    expect(() =>
      equipmentTypeFormCommand(input("", JSON.stringify(slots)), project, 3),
    ).toThrow(formReason);
    // A command that bypasses the form is still refused by the domain.
    expect(() =>
      applyCommand(
        project,
        { type: "create-equipment-type", name: "状態", slots },
        "edit",
      ),
    ).toThrow(applyReason);
  }
});
