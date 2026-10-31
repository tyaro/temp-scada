import { expect, it } from "vitest";
import examples from "../../../../examples/read-display-cases.json";
import sample from "../../../../examples/read-presentation.project.json";
import { parseProject } from "./project";
import {
  createReadPresentationSession,
  readPresentationContext,
} from "./read-presentation";
import { presentNumeric } from "./tag-presentation";

function setup() {
  const project = parseProject(JSON.stringify(sample));
  const session = createReadPresentationSession(project);
  const read = () => readPresentationContext(project, session.frame);
  return { project, session, read };
}
const copy = (index = 0, sequence = 1, generation: number | null = 1) => {
  const update = structuredClone(examples[index].update);
  update.sequence = sequence;
  update.sdkGeneration = generation;
  return update;
};

it.each(examples)("accepts the Rust display fixture: $name", (fixture) => {
  const { session, read } = setup();
  expect(session.receive(session.token, fixture.update).accepted).toBe(true);
  const context = read();
  const number = presentNumeric(context.readings.get("Demo.Number"));
  const slot = context.equipmentContext.readSlot!(
    sample.equipment[0].id,
    "current",
    "number",
    "Demo.Number",
  );
  const expected = {
    good: "0",
    simulation: "SIM · 12.5",
    stale: "SIM · -- · Stale",
    bad: "-- · Bad",
    waiting: "-- · 未解決",
    disconnected: "-- · 未接続",
  }[fixture.name];
  expect(number.text).toBe(expected);
  expect(slot.text).toBe(number.text);
  expect(slot.provenance).toEqual(number.provenance);
});

const corruptions: [string, (value: any) => void][] = [
  ["extra root property", (v) => (v.secret = "must not pass")],
  ["wrong Project", (v) => (v.text.projectId = "other")],
  ["mixed connection", (v) => (v.slots.connection = "stopped")],
  ["mixed error", (v) => (v.slots.lastError = "transport")],
  ["mixed metadataReady", (v) => (v.slots.metadataReady = false)],
  ["missing SDK generation", (v) => (v.sdkGeneration = null)],
  [
    "unsafe SDK generation",
    (v) => (v.sdkGeneration = Number.MAX_SAFE_INTEGER + 1),
  ],
  ["unsafe sequence", (v) => (v.sequence = Number.MAX_SAFE_INTEGER + 1)],
  ["zero sequence", (v) => (v.sequence = 0)],
  ["missing Text", (v) => (v.text.readings = {})],
  ["extra Text", (v) => (v.text.readings.other = { state: "unresolved" })],
  [
    "extra provenance",
    (v) => (v.text.provenance.other = v.text.provenance["Demo.Number"]),
  ],
  [
    "Text nonfinite",
    (v) => (v.text.readings["Demo.Number"].numericValue = Infinity),
  ],
  [
    "Text Bad retains value",
    (v) => (v.text.readings["Demo.Number"].quality = "bad"),
  ],
  ["Text missing origin", (v) => (v.text.provenance = {})],
  [
    "Text unknown source",
    (v) => (v.text.provenance["Demo.Number"].valueSource = "future"),
  ],
  ["missing slot", (v) => v.slots.slots.pop()],
  [
    "same tag different Text state",
    (v) => {
      v.text.readings["Demo.Number"] = { state: "unresolved" };
      v.text.provenance = {};
    },
  ],
  [
    "same tag different slot state",
    (v) => {
      v.slots.slots[0].reading = { state: "unresolved" };
      v.slots.slots[0].provenance = null;
    },
  ],
  ["slot corrupt type", (v) => (v.slots.slots[0].reading.value.type = "bool")],
  ["mixed generations", (v) => v.slots.slots[1].provenance.runId++],
  [
    "same tag different value",
    (v) => (v.slots.slots[0].reading.value.value = 3),
  ],
  [
    "same tag different source",
    (v) => (v.slots.slots[0].provenance.valueSource = "db"),
  ],
];
it.each(corruptions)("rejects %s and clears both halves", (_, corrupt) => {
  const { session, read } = setup();
  session.receive(session.token, copy());
  const bad = copy(0, 2);
  corrupt(bad);
  expect(session.receive(session.token, bad).accepted).toBe(false);
  expect(presentNumeric(read().readings.get("Demo.Number")).state).toBe(
    "invalid",
  );
  expect(
    read().equipmentContext.readSlot!(
      sample.equipment[0].id,
      "current",
      "number",
      "Demo.Number",
    ).state,
  ).toBe("invalid");
});

it("ignores old sequence and token, consumes rejected new sequence, and requires a new SDK generation after stop", () => {
  const { session, read } = setup();
  session.receive(session.token, copy());
  const stale = copy(2, 2);
  session.receive(session.token, stale);
  const previous = session.frame;
  expect(session.receive(session.token, copy()).accepted).toBe(false);
  expect(session.frame).toBe(previous);
  const corrupt = copy(0, 3);
  (corrupt.text.readings as any).bad = { state: "invalid" };
  session.receive(session.token, corrupt);
  expect(session.receive(session.token, stale).accepted).toBe(false);
  expect(presentNumeric(read().readings.get("Demo.Number")).state).toBe(
    "invalid",
  );
  expect(session.receive(session.token, copy(0, 4)).accepted).toBe(true);
  expect(session.receive(session.token, copy(5, 5, null)).accepted).toBe(true);
  expect(session.receive(session.token, copy(0, 6)).accepted).toBe(false);
  expect(session.receive(session.token, copy(0, 7, 2)).accepted).toBe(true);
  const old = session.token;
  session.reset(parseProject(JSON.stringify(sample)));
  expect(session.receive(old, copy(0, 999, 99)).accepted).toBe(false);
});

it("rejects SDK generation regression and same-generation metadata/state changes", () => {
  const { session } = setup();
  session.receive(session.token, copy(0, 1, 5));
  expect(session.receive(session.token, copy(0, 2, 4)).accepted).toBe(false);
  const changed = copy(0, 3, 5);
  changed.text.provenance["Demo.Number"]!.runId++;
  for (const row of changed.slots.slots)
    if (row.provenance) row.provenance.runId++;
  expect(session.receive(session.token, changed).accepted).toBe(false);
  expect(session.receive(session.token, copy(4, 4, 5)).accepted).toBe(false);
  expect(session.receive(session.token, copy(4, 5, 6)).accepted).toBe(true);
  expect(session.receive(session.token, copy(0, 6, 6)).accepted).toBe(false);
  expect(session.receive(session.token, copy(0, 7, 7)).accepted).toBe(true);
});

it("owns accepted values, clears held contexts after reset, and rejects foreign/mutated Project identities", () => {
  const { project, session, read } = setup();
  const payload = copy();
  session.receive(session.token, payload);
  const held = read();
  (payload.text.readings["Demo.Number"] as any).numericValue = 999;
  held.readings.get("Demo.Number")!.provenance!.valueSource = "db";
  expect(presentNumeric(read().readings.get("Demo.Number")).text).toBe("0");
  expect(read().readings.get("Demo.Number")!.provenance!.valueSource).toBe(
    "real",
  );
  const other = parseProject(JSON.stringify(project));
  expect(
    readPresentationContext(other, session.frame).readings.get("Demo.Number")!
      .state,
  ).toBe("disconnected");
  project.manifest.projectRevision++;
  expect(held.readings.get("Demo.Number")!.state).toBe("disconnected");
  session.reset(other);
  expect(held.readings.get("Demo.Number")!.state).toBe("disconnected");
});

it("treats a throwing payload accessor as invalid and can recover on a new sequence", () => {
  const { session, read } = setup();
  session.receive(session.token, copy());
  expect(
    session.receive(session.token, {
      get sequence() {
        throw Error("broken source");
      },
    }).accepted,
  ).toBe(false);
  expect(read().readings.get("Demo.Number")!.state).toBe("invalid");
  expect(session.receive(session.token, copy(0, 2)).accepted).toBe(true);
});
