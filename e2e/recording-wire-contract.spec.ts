import { test, expect } from "@playwright/test";
import fixtures from "../examples/recording-wire-cases.json" with { type: "json" };
import admission from "../examples/recording-admission-cases.json" with { type: "json" };
import plans from "../examples/recording-plan-cases.json" with { type: "json" };
import management from "../examples/recording-management-cases.json" with { type: "json" };
import { downloadBytes, downloadProject } from "./helpers/project-files";
test("wire roots use owned immutable JSON and bundled schemas only", async ({
  page,
}) => {
  const remote: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).hostname === "temp-scada.invalid")
      remote.push(r.url());
  });
  await page.goto("/");
  const actual = await page.evaluate(async () => {
    const cpath = "/src/lib/recording-wire-contract.ts",
      fpath = "/src/lib/__fixtures__/recording-wire-cases.ts";
    const c = await import(cpath),
      f = await import(fpath);
    const frozen = (v: any): boolean =>
      v === null ||
      typeof v !== "object" ||
      (Object.isFrozen(v) && Object.values(v).every(frozen));
    return f.wireFixtures.cases.map((row: any) => {
      let input;
      try {
        input = f.wireCaseInput(row);
      } catch {
        return { name: row.name, accepted: false };
      }
      const accepted = c.validateRecordingWire(input);
      if (accepted) {
        const owned = c.parseRecordingWireDocument(input);
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
test("wire nesting preserves admission, desired and management checks", async ({
  page,
}) => {
  await page.goto("/");
  const actual = await page.evaluate(async () => {
    const paths = [
      "/src/lib/recording-wire-contract.ts",
      "/src/lib/__fixtures__/recording-wire-cases.ts",
      "/src/lib/__fixtures__/recording-admission-cases.ts",
      "/src/lib/__fixtures__/recording-plan-cases.ts",
      "/src/lib/__fixtures__/recording-management-cases.ts",
    ];
    const [c, w, a, p, m] = await Promise.all(
      paths.map((path) => import(path)),
    );
    const check = (rows: any[], input: (row: any) => unknown) =>
      rows.map((row) => {
        let accepted = false;
        try {
          accepted = c.validateRecordingWire(w.wrapAdmission(input(row)));
        } catch {}
        return { name: row.name, accepted };
      });
    return {
      admission: check(a.admissionFixtures.cases, a.admissionCaseInput),
      plans: check(p.cases, (r: any) =>
        a.nestedAdmissionPlan(p.recordingPlanCaseInput(r)),
      ),
      targets: check(m.fixtures.cases, (r: any) =>
        a.nestedAdmissionTarget(m.managementCaseInput(r)),
      ),
    };
  });
  expect(actual.admission).toEqual(
    admission.cases.map(({ name, accepted }) => ({ name, accepted })),
  );
  expect(actual.plans).toEqual(
    plans.map(({ name, accepted }) => ({ name, accepted })),
  );
  expect(actual.targets).toEqual(
    management.cases.map(({ name, accepted, base }) => ({
      name,
      accepted: accepted && base === "context",
    })),
  );
});
test("wire capacity and correlation leave normal App Project saving unchanged", async ({
  page,
}) => {
  await page.goto("/");
  const before = await downloadBytes(await downloadProject(page));
  const actual = await page.evaluate(async () => {
    const cpath = "/src/lib/recording-wire-contract.ts",
      fpath = "/src/lib/__fixtures__/recording-wire-cases.ts",
      bpath = "/src/lib/history/owned-json.ts",
      cappath = "/src/lib/recording-wire/capacity.ts";
    const c = await import(cpath),
      f = await import(fpath),
      b = await import(bpath),
      cap = await import(cappath),
      data = f.wireFixtures;
    const equalities = data.equalities.map((r: any) => ({
      name: r.name,
      equal: c.sameRecordingWireRequest(data.bases[r.base], f.wireCaseInput(r)),
    }));
    const matches = data.matches.map((r: any) => ({
      name: r.name,
      equal: (r.check === "reply"
        ? c.recordingWireReplyMatchesRequest
        : c.recordingWireFrameMatchesSubscription)(
        f.patched(data.bases[r.left], r.patch),
        data.bases[r.right],
      ),
    }));
    const accounting = data.accounting.map((r: any) => {
      let accepted = false;
      try {
        b.ownMeasuredHistoryJson(
          f.wireAccountingInput(r),
          r.bytes,
          r.nodes,
          r.profile,
        );
        accepted = true;
      } catch {}
      return { name: r.name, accepted };
    });
    for (const row of data.capacity) {
      const q = data.bases[row.base],
        actual = c.recordingWireReplyCapacity(q);
      if (
        JSON.stringify(actual) !==
        JSON.stringify({ reply: row.reply, callInspection: row.callInspection })
      )
        throw Error("capacity");
      for (const key of ["bytes", "nodes", "depth"]) {
        let rejected = false;
        try {
          const lower = { ...row.reply, [key]: row.reply[key] - 1 };
          cap.checkCapacity(
            q,
            q.kind === "recordingWireCallInspectionRequest"
              ? { inspectionReply: lower }
              : { reply: lower },
          );
        } catch {
          rejected = true;
        }
        if (!rejected) throw Error("closure boundary");
      }
    }
    return { equalities, matches, accounting };
  });
  expect(actual.equalities).toEqual(
    fixtures.equalities.map(({ name, expected }) => ({
      name,
      equal: expected,
    })),
  );
  expect(actual.matches).toEqual(
    fixtures.matches.map(({ name, expected }) => ({ name, equal: expected })),
  );
  expect(actual.accounting).toEqual(
    fixtures.accounting.map(({ name, accepted }) => ({ name, accepted })),
  );
  expect(await downloadBytes(await downloadProject(page))).toEqual(before);
});
