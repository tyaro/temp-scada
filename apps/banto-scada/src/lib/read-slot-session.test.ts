import { expect, it } from "vitest";
import { render } from "svelte/server";
import fixtures from "../../../../examples/read-slot-view-cases.json";
import sample from "../../../../examples/symbol-slots.project.json";
import { parseProject } from "./project";
import {
  createReadSlotSession,
  equipmentReadContext,
  type ReadSlotFrame,
} from "./read-slot-session";
import { resolveSymbolSlot } from "./symbol-slots";
import ScreenPainting from "./ScreenPainting.svelte";

function setup(fixture = fixtures[0]) {
  const project = parseProject(JSON.stringify(sample));
  for (const equipment of project.equipment!) equipment.bindings = [];
  const row = fixture.view.slots[0];
  project.equipment![0].bindings = [
    { slotName: row.key.slotName, externalName: row.externalName },
  ];
  const session = createReadSlotSession(project);
  const read = (frame = session.frame) =>
    resolveSymbolSlot(
      project.symbols[0],
      row.key.slotName,
      project.equipment![0].id,
      equipmentReadContext(project, frame),
    );
  return { project, session, read };
}
it.each(fixtures)("Rust read-slot fixture: $name", (fixture) => {
  const { session, read } = setup(fixture);
  const result = session.receive(session.generation, fixture.view);
  expect(result.accepted).toBe(true);
  expect(read(result.frame).text).toBe(fixture.display);
  expect(read().provenance ?? null).toEqual(fixture.view.slots[0].provenance);
});
it("ignores old tokens while resetting identical IDs and revisions and invalidates old frames", () => {
  const { project, session, read } = setup();
  const token = session.generation,
    first = session.receive(token, fixtures[0].view).frame;
  expect(read(first).text).toBe("false");
  const copy = parseProject(JSON.stringify(project));
  const foreign = resolveSymbolSlot(
    copy.symbols[0],
    "running",
    copy.equipment![0].id,
    equipmentReadContext(copy, first),
  );
  expect(foreign.state).toBe("disconnected");
  const reset = session.reset(project);
  expect(reset.generation).not.toBe(token);
  expect(read(first).state).toBe("disconnected");
  expect(read(reset.frame).state).toBe("disconnected");
  const second = session.receive(reset.generation, fixtures[1].view).frame;
  expect(read(second).text).toBe("true");
  const ignored = session.receive(token, { bad: "old payload" });
  expect(ignored).toEqual({ accepted: false, frame: second });
  expect(read().text).toBe("true");
  expect(read({ kind: "read-slot-frame" } as ReadSlotFrame).state).toBe(
    "disconnected",
  );
});
it("owns its plan, accepted payload and provenance without caller mutations changing displayed values", () => {
  const { project, session, read } = setup();
  const payload = structuredClone(fixtures[0].view);
  session.receive(session.generation, payload);
  (payload.slots[0].reading as any).value.value = true;
  payload.slots[0].provenance!.valueSource = "simulation";
  const presentation = read();
  expect(presentation.text).toBe("false");
  presentation.provenance!.valueSource = "db";
  expect(read().provenance!.valueSource).toBe("real");
  project.equipment![0].bindings[0].externalName = "replacement";
  expect(read().state).toBe("invalid");
  project.manifest.projectRevision++;
  expect(read().state).toBe("disconnected");
});
const corruptions: [string, (view: any) => void][] = [
  ["unknown top property", (v) => (v.extra = true)],
  ["wrong project", (v) => (v.projectId = "other")],
  ["wrong revision", (v) => v.projectRevision++],
  [
    "unsafe project revision",
    (v) => (v.projectRevision = Number.MAX_SAFE_INTEGER + 1),
  ],
  ["missing row", (v) => (v.slots = [])],
  ["duplicate key", (v) => v.slots.push(structuredClone(v.slots[0]))],
  ["unexpected key", (v) => (v.slots[0].key.slotName = "unknown")],
  ["wrong equipment", (v) => (v.slots[0].key.equipmentId = "other")],
  ["wrong expected type", (v) => (v.slots[0].expectedType = "number")],
  ["wrong external name", (v) => (v.slots[0].externalName = "other")],
  [
    "wrong value type",
    (v) => (v.slots[0].reading.value = { type: "number", value: 0 }),
  ],
  ["bool cannot be zero", (v) => (v.slots[0].reading.value.value = 0)],
  ["Good cannot be null", (v) => (v.slots[0].reading.value = null)],
  ["unknown Quality", (v) => (v.slots[0].reading.quality = "future")],
  ["Stale cannot retain value", (v) => (v.slots[0].reading.quality = "stale")],
  ["Bad cannot retain value", (v) => (v.slots[0].reading.quality = "bad")],
  ["unknown state", (v) => (v.slots[0].reading.state = "future")],
  ["unknown connection", (v) => (v.connection = "future")],
  ["non Live cannot retain value", (v) => (v.connection = "reconnecting")],
  ["resolved requires metadata", (v) => (v.metadataReady = false)],
  ["resolved requires provenance", (v) => (v.slots[0].provenance = null)],
  ["unknown source", (v) => (v.slots[0].provenance.valueSource = "future")],
  ["unknown mode", (v) => (v.slots[0].provenance.collectionMode = "future")],
  [
    "unsafe catalog revision",
    (v) =>
      (v.slots[0].provenance.catalogRevision = Number.MAX_SAFE_INTEGER + 1),
  ],
  [
    "unsafe run ID",
    (v) => (v.slots[0].provenance.runId = Number.MAX_SAFE_INTEGER + 1),
  ],
  [
    "unsafe timestamp",
    (v) =>
      (v.slots[0].provenance.sourceTimestampMs = Number.MAX_SAFE_INTEGER + 1),
  ],
  [
    "non resolved cannot retain origin",
    (v) => (v.slots[0].reading = { state: "unresolved" }),
  ],
  [
    "assigned cannot be unassigned",
    (v) => {
      v.slots[0].reading = { state: "unassigned" };
      v.slots[0].provenance = null;
    },
  ],
  [
    "Live cannot publish disconnected",
    (v) => {
      v.slots[0].reading = { state: "disconnected" };
      v.slots[0].provenance = null;
    },
  ],
];
it.each(corruptions)("rejects $0 and clears the old value", (_, corrupt) => {
  const { session, read } = setup();
  const old = session.receive(session.generation, fixtures[0].view).frame;
  const input = structuredClone(fixtures[0].view);
  corrupt(input);
  const rejected = session.receive(session.generation, input);
  expect(rejected.accepted).toBe(false);
  expect(read().state).toBe("invalid");
  expect(read().provenance).toBeUndefined();
  expect(read(old).state).toBe("disconnected");
});
it("never accepts nonfinite numeric payloads", () => {
  const { session, read } = setup(fixtures[2]);
  for (const value of [NaN, Infinity, -Infinity]) {
    const input = structuredClone(fixtures[2].view);
    (input.slots[0].reading as any).value.value = value;
    expect(session.receive(session.generation, input).accepted).toBe(false);
    expect(read().state).toBe("invalid");
  }
});
it("keeps unadopted and unassigned settings ahead of invalid runtime input", () => {
  const project = parseProject(JSON.stringify(sample)),
    session = createReadSlotSession(project);
  const result = session.receive(session.generation, null);
  const ctx = equipmentReadContext(project, result.frame),
    d = project.symbols[0],
    id = project.equipment![0].id;
  expect(resolveSymbolSlot(d, "running", id, ctx).state).toBe("unassigned");
  expect(resolveSymbolSlot(d, "current", id, ctx).state).toBe("unadopted");
  expect(resolveSymbolSlot(d, "running", undefined, ctx).state).toBe("unbound");
});
it("requires the complete adopted plan, distinguishes two slots and rejects mixed catalog generations", () => {
  const { project } = setup();
  const view: any = structuredClone(fixtures[0].view);
  const other = structuredClone(fixtures[2].view.slots[0]);
  other.externalName = "Demo.Other";
  view.slots.push(other);
  project.equipment![0].bindings.push({
    slotName: "current",
    externalName: "Demo.Other",
  });
  const session = createReadSlotSession(project),
    d = project.symbols[0],
    id = project.equipment![0].id;
  const read = (slot: string) =>
    resolveSymbolSlot(
      d,
      slot,
      id,
      equipmentReadContext(project, session.frame),
    );
  expect(session.receive(session.generation, view).accepted).toBe(true);
  expect(read("running").text).toBe("false");
  expect(read("current").text).toBe("0");
  for (const field of ["catalogRevision", "runId", "collectionMode"]) {
    const mixed = structuredClone(view);
    (mixed.slots[1].provenance as any)[field] =
      field === "collectionMode" ? "all_simulation" : 999;
    expect(session.receive(session.generation, mixed).accepted).toBe(false);
    expect(read("running").state).toBe("invalid");
  }
  const partial = structuredClone(view);
  partial.slots[1].reading = { state: "unresolved" } as any;
  partial.slots[1].provenance = null;
  expect(session.receive(session.generation, partial).accepted).toBe(true);
  expect(read("running").text).toBe("false");
  expect(read("current").state).toBe("unresolved");
});
it("renders accepted Quality and simulation source without static or retained values", () => {
  for (const fixture of fixtures) {
    const { project, session } = setup(fixture);
    const result = session.receive(session.generation, fixture.view);
    const { body } = render(ScreenPainting, {
      props: {
        screen: project.screens[0],
        screens: project.screens,
        symbols: project.symbols,
        equipmentContext: equipmentReadContext(project, result.frame),
      },
    });
    expect(body).not.toContain("STATIC FALLBACK");
    expect(body.replaceAll(/<!--.*?-->/g, "")).toContain(fixture.display);
    if (fixture.view.slots[0].provenance)
      expect(body).toContain(`data-tag-source="${fixture.input.source}"`);
    if (["bad", "stale"].includes(fixture.input.quality))
      expect(body).not.toContain("987.25");
  }
});

it("accepts null bindings only as unassigned and never turns them into disconnected values", () => {
  const project = parseProject(JSON.stringify(sample));
  const session = createReadSlotSession(project);
  const view: any = {
    projectId: project.manifest.projectId,
    projectRevision: project.manifest.projectRevision,
    connection: "stopped",
    lastError: null,
    metadataReady: false,
    slots: project.equipment!.flatMap((equipment) =>
      equipment.bindings.map((binding) => ({
        key: { equipmentId: equipment.id, slotName: binding.slotName },
        expectedType: binding.slotName === "running" ? "bool" : "number",
        externalName: binding.externalName,
        reading: {
          state: binding.externalName === null ? "unassigned" : "disconnected",
        },
        provenance: null,
      })),
    ),
  };
  expect(session.receive(session.generation, view).accepted).toBe(true);
  view.slots[0].reading = { state: "disconnected" };
  expect(session.receive(session.generation, view).accepted).toBe(false);
  const context = equipmentReadContext(project, session.frame);
  expect(
    resolveSymbolSlot(
      project.symbols[0],
      "running",
      project.equipment![0].id,
      context,
    ).state,
  ).toBe("unassigned");
});
it("rejects invalid Project resets before changing a healthy session", () => {
  const { project, session, read } = setup();
  session.receive(session.generation, fixtures[0].view);
  const generation = session.generation,
    frame = session.frame;
  const invalid = structuredClone(project);
  invalid.equipment![0].typeId = "0199f700-0000-7000-8000-000000009999";
  expect(() => session.reset(invalid)).toThrow();
  expect(session.generation).toBe(generation);
  expect(session.frame).toBe(frame);
  expect(read().text).toBe("false");
});
