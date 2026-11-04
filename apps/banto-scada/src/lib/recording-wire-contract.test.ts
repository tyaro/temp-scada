import { describe, it, expect } from "vitest";
import * as c from "./recording-wire-contract";
import { checkCapacity } from "./recording-wire/capacity";
import { measureWire, wireProfile } from "./recording-wire/budget";
import { ownHistoryJson, ownMeasuredHistoryJson } from "./history/owned-json";
import {
  wireFixtures as f,
  wireCaseInput,
  patched,
  wireAccountingInput,
  wrapAdmission,
} from "./__fixtures__/recording-wire-cases";
import {
  admissionFixtures,
  admissionCaseInput,
  nestedAdmissionPlan,
  nestedAdmissionTarget,
} from "./__fixtures__/recording-admission-cases";
import {
  cases as plans,
  recordingPlanCaseInput,
} from "./__fixtures__/recording-plan-cases";
import {
  fixtures as management,
  managementCaseInput,
} from "./__fixtures__/recording-management-cases";
const frozen = (v: any): boolean =>
  v === null ||
  typeof v !== "object" ||
  (Object.isFrozen(v) && Object.values(v).every(frozen));
describe("recording wire shared contracts", () => {
  for (const row of f.cases)
    it(row.name, () => {
      let input;
      try {
        input = wireCaseInput(row);
      } catch {
        expect(row.accepted).toBe(false);
        return;
      }
      expect(c.validateRecordingWire(input)).toBe(row.accepted);
      if (row.accepted) {
        const owned = c.parseRecordingWireDocument(input);
        expect(owned).toEqual(input);
        expect(owned).not.toBe(input);
        expect(frozen(owned)).toBe(true);
        expect(c.validateRecordingWire(JSON.parse(JSON.stringify(owned)))).toBe(
          true,
        );
      }
    });
  for (const row of f.equalities)
    it(row.name, () =>
      expect(
        c.sameRecordingWireRequest(f.bases[row.base], wireCaseInput(row)),
      ).toBe(row.expected),
    );
  for (const row of f.matches)
    it(row.name, () =>
      expect(
        (row.check === "reply"
          ? c.recordingWireReplyMatchesRequest
          : c.recordingWireFrameMatchesSubscription)(
          patched(f.bases[row.left], row.patch),
          f.bases[row.right],
        ),
      ).toBe(row.expected),
    );
  for (const row of f.accounting)
    it(row.name, () => {
      const run = () =>
        ownMeasuredHistoryJson(
          wireAccountingInput(row),
          row.bytes,
          row.nodes,
          row.profile,
        );
      if (row.accepted) expect(run).not.toThrow();
      else expect(run).toThrow();
    });
  for (const row of f.capacity)
    it("capacity closure " + row.base, () => {
      const q = c.parseRecordingWireDocument(f.bases[row.base]);
      if (!q.kind.endsWith("Request")) throw Error("request");
      expect(c.recordingWireReplyCapacity(q)).toEqual({
        reply: row.reply,
        callInspection: row.callInspection,
      });
      const limits =
        q.kind === "recordingWireCallInspectionRequest"
          ? { inspectionReply: row.reply }
          : {
              reply: row.reply,
              inspectionReply: row.callInspection ?? undefined,
            };
      expect(() =>
        checkCapacity(q as c.RecordingWireRequest, limits),
      ).not.toThrow();
      for (const key of ["bytes", "nodes", "depth"] as const) {
        const smaller = { ...row.reply, [key]: row.reply[key] - 1 };
        expect(() =>
          checkCapacity(
            q as c.RecordingWireRequest,
            q.kind === "recordingWireCallInspectionRequest"
              ? { inspectionReply: smaller }
              : { reply: smaller },
          ),
        ).toThrow();
        const inspection = row.callInspection;
        if (inspection)
          expect(() =>
            checkCapacity(q as c.RecordingWireRequest, {
              inspectionReply: {
                ...inspection,
                [key]: inspection[key] - 1,
              },
            }),
          ).toThrow();
      }
    });
  it("all legal response branches fit the prospective capacity", () => {
    for (const row of f.cases.filter((r) => r.accepted)) {
      const v = c.parseRecordingWireDocument(wireCaseInput(row));
      if (!("request" in v) || v.kind.endsWith("Request")) continue;
      const upper = c.recordingWireReplyCapacity(v.request).reply,
        p = wireProfile(v.kind),
        m = measureWire(v, p.limit, p.accounting);
      for (const key of ["bytes", "nodes", "depth"] as const)
        expect(m[key]).toBeLessThanOrEqual(upper[key]);
    }
  });
  it("full equality ignores object key order", () => {
    const reverse = (v: any): any =>
      Array.isArray(v)
        ? v.map(reverse)
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v)
                .reverse()
                .map(([k, x]) => [k, reverse(x)]),
            )
          : v;
    expect(
      c.sameRecordingWireRequest(f.bases.observe, reverse(f.bases.observe)),
    ).toBe(true);
  });
  it("legacy capacity admission is a separate prospective wrapper", () => {
    expect(
      c.recordingWireOriginalCapacity(
        f.bases.lease.scope,
        admissionFixtures.bases.preflight,
      ).reply,
    ).toEqual({ bytes: 3211264, nodes: 102400, depth: 82 });
    expect(() =>
      c.recordingWireOriginalCapacity(
        { ...f.bases.lease.scope, ownerRef: "other" },
        admissionFixtures.bases.preflight,
      ),
    ).toThrow();
  });
  for (const row of admissionFixtures.cases)
    it("independent c4a " + row.name, () => {
      let accepted = false;
      try {
        accepted = c.validateRecordingWire(
          wrapAdmission(admissionCaseInput(row)),
        );
      } catch {}
      expect(accepted).toBe(row.accepted);
    });
  for (const row of plans)
    it("independent H5a " + row.name, () => {
      let accepted = false;
      try {
        accepted = c.validateRecordingWire(
          wrapAdmission(nestedAdmissionPlan(recordingPlanCaseInput(row))),
        );
      } catch {}
      expect(accepted).toBe(row.accepted);
    });
  for (const row of management.cases)
    it("independent d3 " + row.name, () => {
      let accepted = false;
      try {
        accepted = c.validateRecordingWire(
          wrapAdmission(nestedAdmissionTarget(managementCaseInput(row))),
        );
      } catch {}
      expect(accepted).toBe(row.accepted && row.base === "context");
    });
  it("compact operation bounds convert conservatively for controls and numbers", () => {
    for (const value of [
      Array(8191).fill(0),
      "\n".repeat(120000),
      { a: [-0, 1e20, 1e-20, "😀\r\t"] },
    ]) {
      const compact = ownMeasuredHistoryJson(
          value,
          256 * 1024,
          8192,
          "compact",
        ),
        wire = ownMeasuredHistoryJson(value, 1024 * 1024, 8192, "wireReply");
      expect(wire.bytes).toBeLessThanOrEqual(
        3 * compact.bytes + 21 * compact.nodes,
      );
    }
  });
  it("rejects non JSON inputs without invoking getters or exposing errors", () => {
    let invoked = 0;
    const getter = { ...f.bases.lease };
    Object.defineProperty(getter, "scope", {
      enumerable: true,
      get() {
        invoked++;
        throw Error("PRIVATE");
      },
    });
    const cyclic: any = { ...f.bases.lease };
    cyclic.scope = cyclic;
    const hidden = { ...f.bases.lease };
    Object.defineProperty(hidden, "extra", { value: 1 });
    const symbol = { ...f.bases.lease, [Symbol()]: 1 };
    const klass = Object.assign(new Date(), f.bases.lease);
    for (const value of [
      getter,
      cyclic,
      hidden,
      symbol,
      klass,
      { ...f.bases.lease, scope: undefined },
      { ...f.bases.lease, scope: () => 0 },
      { ...f.bases.lease, requestedBudgetMs: NaN },
      { ...f.bases.lease, scope: [,] },
    ]) {
      expect(() => c.parseRecordingWireDocument(value)).toThrow(
        "Recording wire: invalid",
      );
    }
    expect(invoked).toBe(0);
  });
  it("owned results survive source mutation and accept null prototypes", () => {
    const source = structuredClone(f.bases.lease),
      owned = c.parseRecordingWireLeaseRequest(source);
    source.scope.ownerEpoch = "other";
    expect(owned.scope.ownerEpoch).toBe("epoch:1");
    expect(
      c.validateRecordingWire(
        Object.assign(Object.create(null), f.bases.lease),
      ),
    ).toBe(true);
    expect(() => c.parseRecordingWireCancelRequest(f.bases.lease)).toThrow();
  });
  it("legacy compact depth remains unchanged", () => {
    let v: any = null;
    for (let i = 0; i < 33; i++) v = [v];
    expect(() => ownHistoryJson(v, 1000, 1000)).toThrow();
  });
});
