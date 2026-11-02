import { expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import schema from "../../../../crates/scada-model/schema/recording-plan.schema.json";
import {
  cases,
  recordingPlanCaseInput,
} from "./__fixtures__/recording-plan-cases";
import {
  parseRecordingPlan,
  validateRecordingPlan,
  MAX_RECORDING_PLAN_JSON_BYTES,
  MAX_RECORDING_PLAN_JSON_NODES,
} from "./recording-plan";
import { ownHistoryJson } from "./history/owned-json";
it.each(cases)("shared recording plan case: $name", (fixture) => {
  let input: unknown;
  try {
    input = recordingPlanCaseInput(fixture);
  } catch (error) {
    if (fixture.json === undefined) throw error;
    expect(fixture.accepted).toBe(false);
    return;
  }
  expect(validateRecordingPlan(input)).toBe(fixture.accepted);
  if (fixture.accepted) {
    const owned = parseRecordingPlan(input);
    expect(owned).toEqual(input);
    expect(owned).not.toBe(input);
    expect(Object.isFrozen(owned.group.members)).toBe(true);
    expect(validateRecordingPlan(JSON.parse(JSON.stringify(owned)))).toBe(true);
  } else
    expect(() => parseRecordingPlan(input)).toThrow("Recording plan: invalid");
});
it("owns and freezes all members, preserving order, spaces and caller data", () => {
  const input = recordingPlanCaseInput(cases[0]) as any;
  const owned = parseRecordingPlan(input);
  input.group.members[0].externalName = "changed";
  input.group.members.reverse();
  expect(owned.group.members.map((row) => row.memberId)).toEqual([
    "member:b",
    "member:a",
  ]);
  expect(owned.group.members[0].externalName).toBe(" 温度 ");
  expect(Object.isFrozen(owned.group.members[0])).toBe(true);
  expect(Object.isFrozen(input)).toBe(false);
});
it("uses the H1 resource without a second ID grammar", () => {
  expect(() => new Ajv2020().compile(schema)).toThrow();
});
it.each([
  undefined,
  NaN,
  Infinity,
  -Infinity,
  BigInt(1),
  () => {},
  new Date(),
  new Map(),
  new Set(),
  new Uint8Array(1),
  Symbol("invalid"),
])("rejects non-JSON value %#", (value) => {
  expect(validateRecordingPlan(value)).toBe(false);
  expect(() => parseRecordingPlan(value)).toThrow("Recording plan: invalid");
});
it("rejects accessors, cycles, prototypes, sparse arrays and hidden/symbol properties without invoking getters", () => {
  const base = () => recordingPlanCaseInput(cases[0]) as any;
  let reads = 0;
  const getter = base();
  Object.defineProperty(getter.group.members[0], "externalName", {
    enumerable: true,
    get() {
      reads++;
      return "leak";
    },
  });
  const cycle = base();
  cycle.group.members.push(cycle);
  const proto = base();
  Object.setPrototypeOf(proto.group, { inherited: true });
  const sparse = base();
  delete sparse.group.members[0];
  const hidden = base();
  Object.defineProperty(hidden, "hidden", { value: 1 });
  const symbol = base();
  symbol[Symbol("extra")] = 1;
  for (const value of [getter, cycle, proto, sparse, hidden, symbol])
    expect(validateRecordingPlan(value)).toBe(false);
  expect(reads).toBe(0);
});
it("supports null-prototype plain JSON without prototype mutation", () => {
  const input = Object.assign(
    Object.create(null),
    recordingPlanCaseInput(cases[0]),
  );
  expect(validateRecordingPlan(input)).toBe(true);
  expect(Object.getPrototypeOf(input)).toBeNull();
});
it("bounds owned traversal at 64KiB, 4096 nodes and depth32, while preserving the History default", () => {
  expect(MAX_RECORDING_PLAN_JSON_BYTES).toBe(65536);
  expect(MAX_RECORDING_PLAN_JSON_NODES).toBe(4096);
  expect(ownHistoryJson("x".repeat(65534), 65536, 4096)).toHaveLength(65534);
  expect(() => ownHistoryJson("x".repeat(65535), 65536, 4096)).toThrow();
  const below = Object.fromEntries(
    Array.from({ length: 4095 }, (_, i) => [`k:${i}`, null]),
  );
  expect(
    Object.keys(ownHistoryJson(below, 65536, 4096) as object),
  ).toHaveLength(4095);
  const above = { ...below, extra: null };
  expect(() => ownHistoryJson(above, 65536, 4096)).toThrow();
  expect(() => ownHistoryJson(above, 65536)).not.toThrow();
  let depth: unknown = null;
  for (let i = 0; i < 32; i++) depth = [depth];
  expect(() => ownHistoryJson(depth, 65536, 4096)).not.toThrow();
  expect(() => ownHistoryJson([depth], 65536, 4096)).toThrow();
});
