import { expect, it } from "vitest";
import sample from "../../../../examples/bool-colors.project.json";
import fixtures from "../../../../examples/read-slot-view-cases.json";
import { parseProject, type Screen } from "./project";
import {
  createReadSlotSession,
  equipmentReadContext,
} from "./read-slot-session";
import { slotStatusRows, slotStatusCounts } from "./slot-status-summary";
const fresh = () => parseProject(JSON.stringify(sample));
it("counts used roles per placement, retaining hidden Text and excluding unused declarations", () => {
  const project = fresh(),
    definition = project.symbols[0];
  definition.readSlots!.push({
    name: "unused",
    type: "bool",
    direction: "read",
  });
  const text = definition.objects[5];
  text.visible = false;
  text.opacity = 0;
  text.colorAlpha = 0;
  const copy = structuredClone(text);
  copy.id = "0199f600-0000-7000-8000-000000000511";
  definition.objects.push(copy);
  const rows = slotStatusRows(
    project.screens[0],
    project.screens,
    project.symbols,
    project,
  );
  expect(rows).toHaveLength(6);
  expect(new Set(rows.map((row) => row.key)).size).toBe(6);
  expect(rows.filter((row) => row.slotName === "running")).toHaveLength(3);
  expect(slotStatusCounts(rows)).toEqual({
    total: 6,
    unavailable: 6,
    simulated: 0,
  });
  expect(rows.map((row) => row.display.state)).toEqual([
    "unassigned",
    "unadopted",
    "disconnected",
    "unassigned",
    "unbound",
    "unbound",
  ]);
  const editing = slotStatusRows(
    definition,
    project.screens,
    project.symbols,
    project,
  );
  expect(editing).toHaveLength(2);
  expect(editing.every((row) => row.display.state === "unbound")).toBe(true);
});
it("uses visible placement paths, keeps duplicate View paths distinct and stops at one level", () => {
  const project = fresh(),
    source = project.screens[0];
  const view = (id: string) => ({
    id,
    order: 0,
    x: 0,
    y: 0,
    rotation: 0,
    width: 960,
    height: 540,
    shape: {
      type: "screenView" as const,
      screenId: source.id,
      fit: "contain" as const,
    },
  });
  const first = view("0199f600-0000-7000-8000-000000000520"),
    second = view("0199f600-0000-7000-8000-000000000521");
  second.order = 1;
  const host: Screen = {
    id: "0199f600-0000-7000-8000-000000000522",
    name: "Host",
    background: "#ffffff",
    width: 960,
    height: 540,
    folders: [],
    groups: [],
    objects: [first, second],
  };
  let rows = slotStatusRows(
    host,
    [...project.screens, host],
    project.symbols,
    project,
  );
  expect(rows).toHaveLength(12);
  expect(new Set(rows.map((row) => row.key)).size).toBe(12);
  expect(rows.every((row) => row.path.length === 3)).toBe(true);
  (first as typeof first & { visible?: boolean }).visible = false;
  source.objects[0].visible = false;
  rows = slotStatusRows(
    host,
    [...project.screens, host],
    project.symbols,
    project,
  );
  expect(rows).toHaveLength(4);
  expect(rows.every((row) => row.key.includes(second.id))).toBe(true);
  // A malformed cycle passed directly to this collector cannot recurse indefinitely.
  source.objects.push({
    ...view("0199f600-0000-7000-8000-000000000523"),
    shape: { type: "screenView", screenId: host.id, fit: "contain" },
  });
  expect(
    slotStatusRows(host, [...project.screens, host], project.symbols, project),
  ).toHaveLength(4);
});
it("counts false and zero as Good, preserves SIM/quality and drops reset/old-frame values", () => {
  const project = fresh();
  for (const equipment of project.equipment!) equipment.bindings = [];
  project.equipment![0].bindings = [
    { slotName: "running", externalName: "Demo.Value" },
    { slotName: "current", externalName: "Demo.Number" },
  ];
  const session = createReadSlotSession(project),
    payload = structuredClone(fixtures[0].view);
  const number = structuredClone(fixtures[2].view.slots[0]);
  number.externalName = "Demo.Number";
  payload.slots.push(number as any);
  const good = session.receive(session.generation, payload).frame;
  const rows = (frame = session.frame) =>
    slotStatusRows(
      project.screens[0],
      project.screens,
      project.symbols,
      equipmentReadContext(project, frame),
    );
  expect(
    rows(good)
      .slice(0, 2)
      .map((row) => row.display.text),
  ).toEqual(["false", "0"]);
  expect(slotStatusCounts(rows(good))).toEqual({
    total: 6,
    unavailable: 4,
    simulated: 0,
  });
  for (const row of payload.slots) row.provenance!.valueSource = "simulation";
  session.receive(session.generation, payload);
  expect(slotStatusCounts(rows())).toEqual({
    total: 6,
    unavailable: 4,
    simulated: 2,
  });
  const bad: any = structuredClone(payload);
  bad.slots[0].reading = { state: "resolved", quality: "bad", value: null };
  session.receive(session.generation, bad);
  expect(slotStatusCounts(rows())).toEqual({
    total: 6,
    unavailable: 5,
    simulated: 2,
  });
  expect(rows()[0].display.text).toBe("SIM · -- · Bad");
  expect(rows(good)[0].display.state).toBe("disconnected");
  session.reset(project);
  expect(slotStatusCounts(rows())).toEqual({
    total: 6,
    unavailable: 6,
    simulated: 0,
  });
  expect(rows()[0].display).not.toHaveProperty("provenance");
});
