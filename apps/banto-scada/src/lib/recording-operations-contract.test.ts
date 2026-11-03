import { describe, it, expect } from "vitest";
import {
  operationsFixtures as fixtures,
  operationCaseInput,
  nestedOperationPlan,
  nestedOperationTarget,
  desiredBases,
} from "./__fixtures__/recording-operations-cases";
import {
  cases as planCases,
  recordingPlanCaseInput,
} from "./__fixtures__/recording-plan-cases";
import {
  fixtures as managementFixtures,
  managementCaseInput,
} from "./__fixtures__/recording-management-cases";
import { ownHistoryJson } from "./history/owned-json";
import {
  parseRecordingOperationsDocument,
  validateRecordingOperations,
  parseRecordingOperationsContext,
  parseRecordingChangeRequest,
  parseRecordingOperationRequest,
  parseRecordingOperationResult,
  parseRecordingReconciliationRequest,
  parseRecordingReconciliationResult,
  sameRecordingOperationsContext,
  sameRecordingChangeRequest,
  sameRecordingOperationRequest,
  sameRecordingReconciliationRequest,
  MAX_RECORDING_OPERATIONS_JSON_BYTES,
  MAX_RECORDING_OPERATIONS_JSON_NODES,
  MAX_RECORDING_OPERATION_RESULT_JSON_BYTES,
  MAX_RECORDING_OPERATION_RESULT_JSON_NODES,
} from "./recording-operations-contract";
function frozen(value: unknown): boolean {
  return (
    value === null ||
    typeof value !== "object" ||
    (Object.isFrozen(value) && Object.values(value).every(frozen))
  );
}
const equality = {
  context: sameRecordingOperationsContext,
  change: sameRecordingChangeRequest,
  operation: sameRecordingOperationRequest,
  reconciliation: sameRecordingReconciliationRequest,
};
describe("shared operation JSON", () => {
  for (const row of fixtures.cases)
    it(row.name, () => {
      let input: unknown;
      try {
        input = operationCaseInput(row);
      } catch (error) {
        if (!("json" in row)) throw error;
        expect(row.accepted).toBe(false);
        return;
      }
      const before = JSON.stringify(input);
      expect(validateRecordingOperations(input)).toBe(row.accepted);
      if (row.accepted) {
        const owned = parseRecordingOperationsDocument(input);
        expect(owned).not.toBe(input);
        expect(frozen(owned)).toBe(true);
        expect(JSON.stringify(owned)).toBe(before);
        expect(
          validateRecordingOperations(JSON.parse(JSON.stringify(owned))),
        ).toBe(true);
      } else
        expect(() => parseRecordingOperationsDocument(input)).toThrow(
          "Recording operations: invalid",
        );
      expect(JSON.stringify(input)).toBe(before);
    });
  for (const base of desiredBases)
    for (const row of planCases)
      it(`${base} nests H5a ${row.name}`, () => {
        let input: unknown;
        try {
          input = recordingPlanCaseInput(row);
        } catch (error) {
          if (row.json === undefined) throw error;
          expect(row.accepted).toBe(false);
          return;
        }
        expect(
          validateRecordingOperations(nestedOperationPlan(base, input)),
        ).toBe(row.accepted);
      });
  for (const row of managementFixtures.cases)
    it(`target uses strict d3 context ${row.name}`, () => {
      let input: any;
      try {
        input = managementCaseInput(row);
      } catch (error) {
        if (!("json" in row)) throw error;
        expect(row.accepted).toBe(false);
        return;
      }
      expect(validateRecordingOperations(nestedOperationTarget(input))).toBe(
        row.accepted && input?.kind === "recordingManagementContext",
      );
    });
  for (const row of fixtures.equalities)
    it(`full equality ${row.name}`, () => {
      const base = row.base as keyof typeof equality;
      const a = structuredClone(fixtures.bases[base]),
        b = operationCaseInput(row),
        before = JSON.stringify({ a, b });
      expect(equality[base](a, b)).toBe(row.expected);
      expect(JSON.stringify({ a, b })).toBe(before);
    });
});
it("owns nested context, desired order, outcome and hashes without freezing source", () => {
  const input = structuredClone(fixtures.bases.reconciliationResult);
  const owned = parseRecordingReconciliationResult(input);
  input.request.operation.change.context.target.projectId = "changed";
  input.request.operation.change.apply.desired.group.members.reverse();
  input.outcome.receipt.desiredHash = "0".repeat(64);
  expect(owned).toEqual(fixtures.bases.reconciliationResult);
  expect(frozen(owned)).toBe(true);
  expect(Object.isFrozen(input)).toBe(false);
});
it("kind-specific parsers require their exact document kind", () => {
  const parsers = [
    parseRecordingOperationsContext,
    parseRecordingChangeRequest,
    parseRecordingOperationRequest,
    parseRecordingOperationResult,
    parseRecordingReconciliationRequest,
    parseRecordingReconciliationResult,
  ];
  const bases = [
    fixtures.bases.context,
    fixtures.bases.change,
    fixtures.bases.operation,
    fixtures.bases.result,
    fixtures.bases.reconciliation,
    fixtures.bases.reconciliationResult,
  ];
  for (let i = 0; i < parsers.length; i++)
    for (let j = 0; j < bases.length; j++) {
      if (i === j) expect(parsers[i](bases[j])).toEqual(bases[j]);
      else
        expect(() => parsers[i](bases[j])).toThrow(
          "Recording operations: invalid",
        );
    }
  for (const same of Object.values(equality))
    expect(() => same({}, {})).toThrow("Recording operations: invalid");
});
it("rejects accessors without invoking them and non JSON at any nested boundary", () => {
  let invoked = 0;
  const accessor = { ...fixtures.bases.result };
  Object.defineProperty(accessor, "request", {
    enumerable: true,
    get() {
      invoked++;
      throw Error("PRIVATE ERROR");
    },
  });
  const kindAccessor = Object.defineProperty(
    { ...fixtures.bases.context },
    "kind",
    {
      enumerable: true,
      get() {
        invoked++;
        return "recordingOperationsContext";
      },
    },
  );
  for (const input of [accessor, kindAccessor]) {
    expect(validateRecordingOperations(input)).toBe(false);
    expect(() => parseRecordingOperationsDocument(input)).toThrow(
      "Recording operations: invalid",
    );
  }
  expect(invoked).toBe(0);
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
    Object.create({}),
    cycle,
    hidden,
    symbol,
    new Array(2),
    extraArray,
  ]) {
    expect(validateRecordingOperations(value)).toBe(false);
    expect(
      validateRecordingOperations({ ...fixtures.bases.result, outcome: value }),
    ).toBe(false);
  }
});
it("uses exact compact-byte, node and depth limits with normalized integer spelling", () => {
  for (const [bytes, nodes] of [
    [MAX_RECORDING_OPERATIONS_JSON_BYTES, MAX_RECORDING_OPERATIONS_JSON_NODES],
    [
      MAX_RECORDING_OPERATION_RESULT_JSON_BYTES,
      MAX_RECORDING_OPERATION_RESULT_JSON_NODES,
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
  const value = JSON.parse("[-0.0,1e3,9.007199254740991e15]");
  const bytes = "[0,1000,9007199254740991]".length;
  expect(() => ownHistoryJson(value, bytes, 4096)).not.toThrow();
  expect(() => ownHistoryJson(value, bytes - 1, 4096)).toThrow();
});
