import { describe, it, expect } from "vitest";
import {
  fixtures,
  managementCaseInput,
  nestedPlanResponse,
} from "./__fixtures__/recording-management-cases";
import {
  cases as planCases,
  recordingPlanCaseInput,
} from "./__fixtures__/recording-plan-cases";
import { ownHistoryJson } from "./history/owned-json";
import {
  compareDesiredApplied,
  sameRecordingInspectionRequest,
  parseRecordingManagementDocument,
  parseRecordingManagementContext,
  parseRecordingInspectionRequest,
  parseRecordingInspectionResponse,
  validateRecordingManagement,
  MAX_RECORDING_MANAGEMENT_JSON_BYTES,
  MAX_RECORDING_MANAGEMENT_JSON_NODES,
  MAX_RECORDING_INSPECTION_RESPONSE_JSON_BYTES,
  MAX_RECORDING_INSPECTION_RESPONSE_JSON_NODES,
} from "./recording-management-contract";

function frozen(value: unknown): boolean {
  return (
    value === null ||
    typeof value !== "object" ||
    (Object.isFrozen(value) && Object.values(value).every(frozen))
  );
}
describe("shared recording management contract", () => {
  for (const row of fixtures.cases)
    it(row.name, () => {
      let input: unknown;
      try {
        input = managementCaseInput(row);
      } catch (error) {
        if (!("json" in row)) throw error;
        expect(row.accepted).toBe(false);
        return;
      }
      const before = JSON.stringify(input);
      expect(validateRecordingManagement(input)).toBe(row.accepted);
      if (row.accepted) {
        const parsed = parseRecordingManagementDocument(input);
        expect(parsed).not.toBe(input);
        expect(JSON.stringify(parsed)).toBe(before);
        expect(frozen(parsed)).toBe(true);
        expect(
          validateRecordingManagement(JSON.parse(JSON.stringify(parsed))),
        ).toBe(true);
      } else
        expect(() => parseRecordingManagementDocument(input)).toThrow(
          "Recording management: invalid",
        );
      expect(JSON.stringify(input)).toBe(before);
    });
  for (const row of planCases)
    it(`nested H5a ${row.name}`, () => {
      let input: unknown;
      try {
        input = recordingPlanCaseInput(row);
      } catch (error) {
        if (row.json === undefined) throw error;
        expect(row.accepted).toBe(false);
        return;
      }
      expect(validateRecordingManagement(nestedPlanResponse(input))).toBe(
        row.accepted,
      );
    });
  for (const row of fixtures.comparisons)
    it(`compare ${row.name}`, () => {
      const response = managementCaseInput(row),
        local = "local" in row ? structuredClone(row.local) : undefined;
      const before = JSON.stringify({ response, local });
      const result = compareDesiredApplied(local, response);
      expect(result).toEqual(row.expected);
      expect(Object.isFrozen(result)).toBe(true);
      expect(JSON.stringify({ response, local })).toBe(before);
    });
  for (const row of fixtures.requests)
    it(`full echoed request ${row.name}`, () => {
      expect(
        sameRecordingInspectionRequest(
          fixtures.bases.request,
          managementCaseInput(row),
        ),
      ).toBe(row.expected);
    });
});
it("owns all nested fields without freezing or retaining source", () => {
  const input = structuredClone(fixtures.bases.observed);
  const output = parseRecordingInspectionResponse(input);
  input.request.context.projectId = "changed";
  input.database.applied.desired.group.members.reverse();
  input.database.applied.desired.group.members[0].externalName = "changed";
  input.host.phase = "idle";
  expect(output.request.context.projectId).toBe(
    fixtures.bases.context.projectId,
  );
  expect(output.database).toEqual(fixtures.bases.observed.database);
  expect(output.host).toEqual(fixtures.bases.observed.host);
  expect(Object.isFrozen(input)).toBe(false);
  expect(frozen(output)).toBe(true);
});
it("kind-specific parsers and comparison reject malformed inputs", () => {
  expect(() => parseRecordingManagementContext(fixtures.bases.request)).toThrow(
    "Recording management: invalid",
  );
  expect(() =>
    parseRecordingInspectionRequest(fixtures.bases.response),
  ).toThrow("Recording management: invalid");
  expect(() =>
    parseRecordingInspectionResponse(fixtures.bases.context),
  ).toThrow("Recording management: invalid");
  expect(
    parseRecordingManagementContext(fixtures.bases.context).historianNamespace,
  ).toBeNull();
  expect(
    parseRecordingInspectionRequest(fixtures.bases.request).requestId,
  ).toBe("request:1");
  expect(() => compareDesiredApplied(null, fixtures.bases.response)).toThrow(
    "Recording plan: invalid",
  );
  expect(() => compareDesiredApplied(undefined, {})).toThrow(
    "Recording management: invalid",
  );
  expect(() =>
    sameRecordingInspectionRequest({}, fixtures.bases.request),
  ).toThrow("Recording management: invalid");
});
it("rejects getters without invocation and rejects non JSON structured data", () => {
  let called = 0;
  const accessor = { ...fixtures.bases.response };
  Object.defineProperty(accessor, "request", {
    enumerable: true,
    get() {
      called++;
      throw Error("sensitive text");
    },
  });
  expect(validateRecordingManagement(accessor)).toBe(false);
  expect(() => parseRecordingInspectionResponse(accessor)).toThrow(
    "Recording management: invalid",
  );
  expect(called).toBe(0);
  const cycle: any = {};
  cycle.self = cycle;
  const hidden = Object.defineProperty(
    { ...fixtures.bases.context },
    "hidden",
    { value: true },
  );
  const symbol = { ...fixtures.bases.context, [Symbol("extra")]: true };
  const extraArray: any = [];
  extraArray.extra = true;
  for (const value of [
    undefined,
    () => {},
    Symbol(),
    1n,
    NaN,
    Infinity,
    new Date(),
    new Map(),
    new Number(1),
    Object.create({}),
    cycle,
    hidden,
    symbol,
    new Array(2),
    extraArray,
  ]) {
    expect(validateRecordingManagement(value)).toBe(false);
    expect(
      validateRecordingManagement({ ...fixtures.bases.response, host: value }),
    ).toBe(false);
  }
});
it("checks both budget sizes, normalized signed bytes, nodes and root depth exactly", () => {
  for (const [bytes, nodes] of [
    [MAX_RECORDING_MANAGEMENT_JSON_BYTES, MAX_RECORDING_MANAGEMENT_JSON_NODES],
    [
      MAX_RECORDING_INSPECTION_RESPONSE_JSON_BYTES,
      MAX_RECORDING_INSPECTION_RESPONSE_JSON_NODES,
    ],
  ]) {
    expect(() =>
      ownHistoryJson("x".repeat(bytes - 2), bytes, nodes),
    ).not.toThrow();
    expect(() => ownHistoryJson("x".repeat(bytes - 1), bytes, nodes)).toThrow();
    expect(() =>
      ownHistoryJson(
        Array.from({ length: nodes - 1 }, () => null),
        bytes,
        nodes,
      ),
    ).not.toThrow();
    expect(() =>
      ownHistoryJson(
        Array.from({ length: nodes }, () => null),
        bytes,
        nodes,
      ),
    ).toThrow();
  }
  let depth: unknown = null;
  for (let i = 0; i < 32; i++) depth = [depth];
  expect(() => ownHistoryJson(depth, 131072, 4096)).not.toThrow();
  expect(() => ownHistoryJson([depth], 131072, 4096)).toThrow();
  const value = JSON.parse("[-9.007199254740991e15,-0.0,1e3,1.0]");
  const bytes = "[-9007199254740991,0,1000,1]".length;
  expect(() => ownHistoryJson(value, bytes, 4096)).not.toThrow();
  expect(() => ownHistoryJson(value, bytes - 1, 4096)).toThrow();
});
