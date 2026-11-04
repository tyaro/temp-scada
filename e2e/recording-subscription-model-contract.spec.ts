import { test, expect } from "@playwright/test";
import { downloadBytes, downloadProject } from "./helpers/project-files";
test("subscription snapshots and frames preserve contracts without native delivery", async ({
  page,
}) => {
  const remote: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).hostname === "temp-scada.invalid")
      remote.push(r.url());
  });
  await page.goto("/");
  const before = await downloadBytes(await downloadProject(page));
  const result = await page.evaluate(async () => {
    const wpath = "/src/lib/recording-wire-contract.ts",
      apath = "/src/lib/recording-admission-contract.ts",
      opath = "/src/lib/recording-operations-contract.ts",
      fpath = "/src/lib/__fixtures__/recording-subscription-model-cases.ts";
    const w = await import(wpath),
      a = await import(apath),
      o = await import(opath),
      f = await import(fpath);
    const frozen = (v: any): boolean =>
      v === null ||
      typeof v !== "object" ||
      (Object.isFrozen(v) && Object.values(v).every(frozen));
    const rows = f.subscriptionModelTranscripts();
    for (const row of rows) {
      const v = row.document,
        p = !v.kind
          ? w.parseRecordingWireStateFrame({
              version: 1,
              kind: "recordingWireStateFrame",
              subscriptionRef: "validation",
              snapshot: v,
            }).snapshot
          : v.kind.startsWith("recordingWire")
            ? w.parseRecordingWireDocument(v)
            : v.kind.startsWith("recordingAdmission") ||
                v.kind === "recordingReconciliationDelivery"
              ? a.parseRecordingAdmissionDocument(v)
              : o.parseRecordingOperationsDocument(v);
      if (p === v || !frozen(p) || JSON.stringify(p) !== JSON.stringify(v))
        throw Error(row.name);
      if (
        v.kind?.endsWith("Reply") &&
        v.kind.startsWith("recordingWire") &&
        !w.recordingWireReplyMatchesRequest(v, v.request)
      )
        throw Error("correlation");
    }
    return {
      scenarios: f.subscriptionModelFixtures.scenarios.length,
      transcripts: rows.length,
    };
  });
  expect(result.scenarios).toBe(48);
  expect(result.transcripts).toBe(141);
  expect(remote).toEqual([]);
  expect(await downloadBytes(await downloadProject(page))).toEqual(before);
});
