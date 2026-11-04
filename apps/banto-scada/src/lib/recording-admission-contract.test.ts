import { describe, it, expect } from "vitest";
import * as contract from "./recording-admission-contract";
import {
  admissionFixtures as fixtures,
  admissionCaseInput,
  patched,
  accountingInput,
  nestedAdmissionPlan,
  nestedAdmissionTarget,
  legacyAdmissionCases,
  nestedAdmissionOperation,
} from "./__fixtures__/recording-admission-cases";
import {
  cases as planCases,
  recordingPlanCaseInput,
} from "./__fixtures__/recording-plan-cases";
import {
  fixtures as managementFixtures,
  managementCaseInput,
} from "./__fixtures__/recording-management-cases";
import { ownHistoryJson } from "./history/owned-json";
import { checkCapacity } from "./recording-admission/capacity";
const frozen = (v: unknown): boolean =>
  v === null ||
  typeof v !== "object" ||
  (Object.isFrozen(v) && Object.values(v).every(frozen));
describe("shared admission fixtures", () => {
  for (const row of fixtures.cases)
    it(row.name, () => {
      let input: unknown;
      try {
        input = admissionCaseInput(row);
      } catch {
        expect(row.json).toBeDefined();
        expect(row.accepted).toBe(false);
        return;
      }
      const before = JSON.stringify(input);
      expect(contract.validateRecordingAdmission(input)).toBe(row.accepted);
      if (row.accepted) {
        const owned = contract.parseRecordingAdmissionDocument(input);
        expect(owned).not.toBe(input);
        expect(frozen(owned)).toBe(true);
        expect(JSON.stringify(owned)).toBe(before);
        expect(
          contract.validateRecordingAdmission(
            JSON.parse(JSON.stringify(owned)),
          ),
        ).toBe(true);
      } else
        expect(() => contract.parseRecordingAdmissionDocument(input)).toThrow(
          "Recording admission: invalid",
        );
      expect(JSON.stringify(input)).toBe(before);
    });
  for (const row of fixtures.equalities)
    it("full equality " + row.name, () => {
      const a = fixtures.bases[row.base],
        b = admissionCaseInput(row);
      const compare =
        a.kind === "recordingAdmissionRequest"
          ? contract.sameRecordingAdmissionRequest
          : contract.sameRecordingAdmissionInspectionRequest;
      expect(compare(a, b)).toBe(row.expected);
    });
  for (const row of fixtures.matches)
    it("known document " + row.name, () => {
      const left = patched(fixtures.bases[row.left], row.patch),
        right = fixtures.bases[row.right];
      const compare =
        row.check === "reply"
          ? contract.recordingAdmissionReplyMatchesRequest
          : row.check === "inspection"
            ? contract.recordingAdmissionInspectionReplyMatchesRequest
            : contract.recordingReconciliationDeliveryMatchesAdmission;
      expect(compare(left, right)).toBe(row.expected);
    });
  for (const row of fixtures.accounting)
    it(row.name, () => {
      const run = () =>
        ownHistoryJson(accountingInput(row), row.bytes, row.nodes, "admission");
      if (row.accepted) expect(run).not.toThrow();
      else expect(run).toThrow();
    });
  for (const row of fixtures.capacity)
    it("capacity includes every maximum branch " + row.base, () => {
      const request = contract.parseRecordingAdmissionRequest(
        fixtures.bases[row.base],
      );
      expect(contract.validateRecordingAdmissionReplyCapacity(request)).toBe(
        true,
      );
      let count = 0;
      checkCapacity(request, (v) => {
        count++;
        ownHistoryJson(v, row.maxBytes, row.maxNodes, "admission");
      });
      expect(count).toBe(row.branches);
      let failedBranch: unknown;
      expect(() =>
        checkCapacity(request, (v) => {
          try {
            ownHistoryJson(v, row.maxBytes - 1, row.maxNodes, "admission");
          } catch (error) {
            const branch = v as { kind: string; outcome?: { kind: string } };
            failedBranch = [branch.kind, branch.outcome?.kind];
            throw error;
          }
        }),
      ).toThrow();
      expect(failedBranch).toEqual([
        "recordingAdmissionInspectionReply",
        "found",
      ]);
      expect(() =>
        checkCapacity(request, (v) => {
          ownHistoryJson(v, row.maxBytes, row.maxNodes - 1, "admission");
        }),
      ).toThrow();
      expect(() =>
        ownHistoryJson(
          request,
          row.maxBytes - 1,
          row.maxNodes - 1,
          "admission",
        ),
      ).not.toThrow();
    });
});
describe("independent nested validators", () => {
  for (const row of planCases)
    it("H5a " + row.name, () => {
      let desired: unknown;
      try {
        desired = recordingPlanCaseInput(row);
      } catch {
        expect(row.accepted).toBe(false);
        return;
      }
      expect(
        contract.validateRecordingAdmission(nestedAdmissionPlan(desired)),
      ).toBe(row.accepted);
    });
  for (const row of managementFixtures.cases)
    it("d3 " + row.name, () => {
      let target: any;
      try {
        target = managementCaseInput(row);
      } catch {
        expect(row.accepted).toBe(false);
        return;
      }
      expect(
        contract.validateRecordingAdmission(nestedAdmissionTarget(target)),
      ).toBe(row.accepted && target?.kind === "recordingManagementContext");
    });
  for (const row of legacyAdmissionCases)
    it("d4a " + row.name, () => {
      let value: unknown;
      try {
        value = nestedAdmissionOperation(row);
      } catch {
        expect(row.accepted).toBe(false);
        return;
      }
      expect(contract.validateRecordingAdmission(value)).toBe(row.accepted);
    });
});
it("kind wrappers require exact roots and own nested JSON independently", () => {
  const parsers = [
    contract.parseRecordingAdmissionRequest,
    contract.parseRecordingAdmissionReply,
    contract.parseRecordingAdmissionInspectionRequest,
    contract.parseRecordingAdmissionInspectionReply,
    contract.parseRecordingReconciliationDelivery,
  ];
  const bases = [
    "preflight",
    "preflightReply",
    "preflightInspection",
    "preflightFound",
    "delivery",
  ];
  parsers.forEach((parse, i) =>
    bases.forEach((base, j) => {
      if (i === j)
        expect(parse(fixtures.bases[base])).toEqual(fixtures.bases[base]);
      else
        expect(() => parse(fixtures.bases[base])).toThrow(
          "Recording admission: invalid",
        );
    }),
  );
  const input = admissionCaseInput({
      base: "reconcileFound",
      name: "ownership",
    }),
    owned = contract.parseRecordingAdmissionInspectionReply(input);
  input.outcome.reply.request.context.target.projectId = "changed";
  expect(owned).toEqual(fixtures.bases.reconcileFound);
  expect(Object.isFrozen(input)).toBe(false);
  for (const compare of [
    contract.sameRecordingAdmissionRequest,
    contract.sameRecordingAdmissionInspectionRequest,
    contract.recordingAdmissionReplyMatchesRequest,
    contract.recordingAdmissionInspectionReplyMatchesRequest,
    contract.recordingReconciliationDeliveryMatchesAdmission,
  ])
    expect(() => compare({}, {})).toThrow("Recording admission: invalid");
});
it("rejects accessors and non JSON without running getters or retaining source", () => {
  let calls = 0;
  const accessor = { ...fixtures.bases.preflight };
  Object.defineProperty(accessor, "action", {
    enumerable: true,
    get() {
      calls++;
      throw Error("PRIVATE");
    },
  });
  const cycle: any = {};
  cycle.self = cycle;
  const extra: any = [];
  extra.hidden = true;
  const hidden = Object.defineProperty(
    { ...fixtures.bases.preflight },
    "hidden",
    { value: true },
  );
  for (const input of [
    accessor,
    cycle,
    extra,
    hidden,
    { ...fixtures.bases.preflight, [Symbol()]: true },
    new Date(),
    Object.create({}),
    new Map(),
    new Array(2),
    undefined,
    NaN,
    Infinity,
    1n,
    () => {},
    Symbol(),
  ]) {
    expect(contract.validateRecordingAdmission(input)).toBe(false);
    expect(() => contract.parseRecordingAdmissionDocument(input)).toThrow(
      "Recording admission: invalid",
    );
  }
  expect(calls).toBe(0);
});
