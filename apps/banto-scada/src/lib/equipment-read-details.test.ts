import { expect, it } from "vitest";
import { render } from "svelte/server";
import fixtures from "../../../../examples/read-slot-view-cases.json";
import sample from "../../../../examples/symbol-slots.project.json";
import { parseProject } from "./project";
import {
  createReadSlotSession,
  equipmentReadContext,
} from "./read-slot-session";
import { equipmentReadDetails } from "./equipment-read-details";
import EquipmentReadDetails from "./designer/EquipmentReadDetails.svelte";

it.each(fixtures)(
  "equipment details preserve typed result: $name",
  (fixture) => {
    const project = parseProject(JSON.stringify(sample));
    for (const item of project.equipment!) item.bindings = [];
    const row = fixture.view.slots[0],
      id = project.equipment![0].id;
    project.equipment![0].bindings = [
      { slotName: row.key.slotName, externalName: row.externalName },
    ];
    const session = createReadSlotSession(project);
    const frame = session.receive(session.generation, fixture.view).frame;
    const context = equipmentReadContext(project, frame);
    const details = equipmentReadDetails(id, context)!;
    expect(details.rows[0].display.text).toBe(fixture.display);
    expect(
      render(EquipmentReadDetails, {
        props: { equipmentId: id, equipmentContext: context },
      }).body,
    ).toContain(fixture.display);
    session.reset(project);
    expect(equipmentReadDetails(id, context)!.rows[0].display.state).toBe(
      "disconnected",
    );
    expect(
      equipmentReadDetails(
        id,
        equipmentReadContext(parseProject(JSON.stringify(project)), frame),
      )!.rows[0].display.state,
    ).toBe("disconnected");
  },
);
it("uses declaration order and includes adopted null and unused roles, with explicit empty and missing results", () => {
  const project = parseProject(JSON.stringify(sample));
  const item = project.equipment![0],
    type = project.equipmentTypes!.find((t) => t.id === item.typeId)!;
  item.bindings = [...type.slots]
    .reverse()
    .map((slot) => ({ slotName: slot.name, externalName: null }));
  const details = equipmentReadDetails(item.id, project)!;
  expect(details.rows.map((row) => row.name)).toEqual(
    type.slots.map((slot) => slot.name),
  );
  expect(details.rows.every((row) => row.display.state === "unassigned")).toBe(
    true,
  );
  expect(details.unavailable).toBe(type.slots.length);
  item.bindings = [];
  expect(equipmentReadDetails(item.id, project)!.rows).toEqual([]);
  expect(
    render(EquipmentReadDetails, {
      props: { equipmentId: item.id, equipmentContext: project },
    }).body,
  ).toContain("採用した読取slotはありません");
  expect(equipmentReadDetails("missing", project)).toBeUndefined();
});
