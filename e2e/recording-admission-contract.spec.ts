import { test, expect } from "@playwright/test";
import fixtures from "../examples/recording-admission-cases.json" with { type: "json" };
import operations from "../examples/recording-operations-cases.json" with { type: "json" };
import planCases from "../examples/recording-plan-cases.json" with { type: "json" };
import management from "../examples/recording-management-cases.json" with { type: "json" };
import { downloadBytes, downloadProject } from "./helpers/project-files";

test("admission fixtures preserve owned JSON and resolve only bundled schemas", async ({
  page,
}) => {
  const remote: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).hostname === "temp-scada.invalid")
      remote.push(r.url());
  });
  await page.goto("/");
  const actual = await page.evaluate(async () => {
    const cpath = "/src/lib/recording-admission-contract.ts",
      fpath = "/src/lib/__fixtures__/recording-admission-cases.ts";
    const contract = await import(cpath),
      helper = await import(fpath);
    const frozen = (v: any): boolean =>
      v === null ||
      typeof v !== "object" ||
      (Object.isFrozen(v) && Object.values(v).every(frozen));
    return helper.admissionFixtures.cases.map((row: any) => {
      let input: unknown;
      try {
        input = helper.admissionCaseInput(row);
      } catch {
        return { name: row.name, accepted: false };
      }
      const accepted = contract.validateRecordingAdmission(input);
      if (accepted) {
        const owned = contract.parseRecordingAdmissionDocument(input);
        if (
          owned === input ||
          !frozen(owned) ||
          JSON.stringify(owned) !== JSON.stringify(input)
        )
          throw Error("ownership");
      }
      return { name: row.name, accepted };
    });
  });
  expect(actual).toEqual(
    fixtures.cases.map(({ name, accepted }) => ({ name, accepted })),
  );
  expect(remote).toEqual([]);
});
test("nested operation, desired and target keep their independent browser checks", async ({
  page,
}) => {
  await page.goto("/");
  const actual = await page.evaluate(async () => {
    const cpath = "/src/lib/recording-admission-contract.ts",
      fpath = "/src/lib/__fixtures__/recording-admission-cases.ts",
      ppath = "/src/lib/__fixtures__/recording-plan-cases.ts",
      mpath = "/src/lib/__fixtures__/recording-management-cases.ts";
    const c = await import(cpath),
      f = await import(fpath),
      p = await import(ppath),
      m = await import(mpath);
    const check = (rows: any[], input: (row: any) => unknown) =>
      rows.map((row) => {
        let accepted = false;
        try {
          accepted = c.validateRecordingAdmission(input(row));
        } catch {}
        return { name: row.name, accepted };
      });
    return {
      plans: check(p.cases, (row: any) =>
        f.nestedAdmissionPlan(p.recordingPlanCaseInput(row)),
      ),
      targets: check(m.fixtures.cases, (row: any) =>
        f.nestedAdmissionTarget(m.managementCaseInput(row)),
      ),
      operations: check(f.legacyAdmissionCases, (row: any) =>
        f.nestedAdmissionOperation(row),
      ),
    };
  });
  expect(actual.plans).toEqual(
    planCases.map(({ name, accepted }) => ({ name, accepted })),
  );
  expect(actual.targets).toEqual(
    management.cases.map((row) => ({
      name: row.name,
      accepted: row.accepted && row.base === "context",
    })),
  );
  expect(actual.operations).toEqual(
    operations.cases
      .filter((row) =>
        [
          "context",
          "change",
          "operation",
          "reconciliation",
          "reconciliationResult",
        ].includes(row.base ?? ""),
      )
      .map(({ name, accepted }) => ({ name, accepted })),
  );
});
test("reply capacity, correlation and full equality leave the normal App Project unchanged", async ({
  page,
}) => {
  await page.goto("/");
  const before = await downloadBytes(await downloadProject(page));
  const actual = await page.evaluate(async () => {
    const cpath = "/src/lib/recording-admission-contract.ts",
      fpath = "/src/lib/__fixtures__/recording-admission-cases.ts",
      bpath = "/src/lib/history/owned-json.ts",
      capacityPath = "/src/lib/recording-admission/capacity.ts";
    const c = await import(cpath),
      f = await import(fpath),
      b = await import(bpath),
      cap = await import(capacityPath);
    const data = f.admissionFixtures;
    const equalities = data.equalities.map((row: any) => ({
      name: row.name,
      equal: (row.base.endsWith("Inspection")
        ? c.sameRecordingAdmissionInspectionRequest
        : c.sameRecordingAdmissionRequest)(
        data.bases[row.base],
        f.admissionCaseInput(row),
      ),
    }));
    const matches = data.matches.map((row: any) => ({
      name: row.name,
      equal: (row.check === "reply"
        ? c.recordingAdmissionReplyMatchesRequest
        : row.check === "inspection"
          ? c.recordingAdmissionInspectionReplyMatchesRequest
          : c.recordingReconciliationDeliveryMatchesAdmission)(
        f.patched(data.bases[row.left], row.patch),
        data.bases[row.right],
      ),
    }));
    const accounting = data.accounting.map((row: any) => {
      let accepted = false;
      try {
        b.ownHistoryJson(
          f.accountingInput(row),
          row.bytes,
          row.nodes,
          "admission",
        );
        accepted = true;
      } catch {}
      return { name: row.name, accepted };
    });
    for (const row of data.capacity) {
      let branches = 0;
      cap.checkCapacity(data.bases[row.base], (v: unknown) => {
        branches++;
        b.ownHistoryJson(v, row.maxBytes, row.maxNodes, "admission");
      });
      if (branches !== row.branches) throw Error("branches");
      let rejected = false;
      try {
        cap.checkCapacity(data.bases[row.base], (v: unknown) =>
          b.ownHistoryJson(v, row.maxBytes - 1, row.maxNodes, "admission"),
        );
      } catch {
        rejected = true;
      }
      if (!rejected) throw Error("capacity");
    }
    return { equalities, matches, accounting };
  });
  expect(actual.equalities).toEqual(
    fixtures.equalities.map((row) => ({ name: row.name, equal: row.expected })),
  );
  expect(actual.matches).toEqual(
    fixtures.matches.map((row) => ({ name: row.name, equal: row.expected })),
  );
  expect(actual.accounting).toEqual(
    fixtures.accounting.map(({ name, accepted }) => ({ name, accepted })),
  );
  expect(await downloadBytes(await downloadProject(page))).toEqual(before);
  await expect(page.getByTestId("save-state")).toContainText(
    "書き出し要求後の変更なし",
  );
});
