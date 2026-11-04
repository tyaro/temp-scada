import { test, expect } from "@playwright/test";
import { downloadBytes, downloadProject } from "./helpers/project-files";
test("cancel model acknowledgement transcripts preserve contracts without native cancellation", async ({
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
      fpath = "/src/lib/__fixtures__/recording-cancel-model-cases.ts";
    const w = await import(wpath),
      a = await import(apath),
      f = await import(fpath);
    const frozen = (v: any): boolean =>
      v === null ||
      typeof v !== "object" ||
      (Object.isFrozen(v) && Object.values(v).every(frozen));
    const rows = f.cancelModelTranscripts();
    for (const row of rows) {
      const v = row.document,
        p = v.kind.startsWith("recordingWire")
          ? w.parseRecordingWireDocument(v)
          : a.parseRecordingAdmissionDocument(v);
      if (p === v || !frozen(p) || JSON.stringify(p) !== JSON.stringify(v))
        throw Error(row.name);
      if (
        v.kind.startsWith("recordingWire") &&
        !w.recordingWireReplyMatchesRequest(v, v.request)
      )
        throw Error("correlation");
    }
    return {
      scenarios: f.cancelModelFixtures.scenarios.length,
      transcripts: rows.length,
    };
  });
  expect(result.scenarios).toBe(41);
  expect(result.transcripts).toBeGreaterThan(120);
  expect(remote).toEqual([]);
  expect(await downloadBytes(await downloadProject(page))).toEqual(before);
});
