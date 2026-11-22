import { test, expect } from "@playwright/test";
import historyCases from "../examples/history-contract-cases.json" with { type: "json" };
import queryCases from "../examples/history-query-cases.json" with { type: "json" };
import coverageCases from "../examples/history-coverage-cases.json" with { type: "json" };
import minmaxCases from "../examples/history-minmax-cases.json" with { type: "json" };
import retentionCases from "../examples/history-retention-cases.json" with { type: "json" };
import retentionJobCases from "../examples/history-retention-job-cases.json" with { type: "json" };
import { downloadBytes, downloadProject } from "./helpers/project-files";

// 純ロジックの全ケースは vitest が持つ。ここはブラウザ境界だけを見る:
// 各モジュールを実アプリのページで import でき、代表ケースが通り、
// 外部（temp-scada.invalid）へ要求を出さず、App の保存結果を変えないこと。
test("recording / history モジュールはブラウザで代表ケースが通り、外部要求も Project の変更も起こさない", async ({
  page,
}) => {
  const remote: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).hostname === "temp-scada.invalid")
      remote.push(r.url());
  });
  await page.goto("/");
  const before = await downloadBytes(await downloadProject(page));

  const summary = await page.evaluate(
    async (history) => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const L = "/src/lib/",
        F = "/src/lib/__fixtures__/";
      const frozen = (v: any): boolean =>
        v === null ||
        typeof v !== "object" ||
        (Object.isFrozen(v) && Object.values(v).every(frozen));
      const assert = (ok: boolean, message: string) => {
        if (!ok) throw Error(message);
      };
      // 受理した入力は、別物で・（history 以外は）凍結され・内容が同じ所有コピーになる
      const owned = (
        parse: (v: any) => any,
        input: any,
        label: string,
        mustFreeze = true,
      ) => {
        const p = parse(input);
        assert(
          p !== input &&
            (!mustFreeze || frozen(p)) &&
            JSON.stringify(p) === JSON.stringify(input),
          `ownership: ${label}`,
        );
      };
      // 受理と拒否を 1 件ずつ（フィクスチャ行は accepted を持つ）
      const pair = (
        rows: any[],
        input: (row: any) => any,
        validate: (v: any) => boolean,
        parse: (v: any) => any,
        label: string,
      ) => {
        for (const want of [true, false]) {
          const row = rows.find((r) => r.accepted === want);
          assert(!!row, `${label}: no ${want} row`);
          let value: any,
            actual = false;
          try {
            value = input(row);
            actual = validate(value);
          } catch {}
          assert(actual === want, `${label}: ${row.name}`);
          if (want) owned(parse, value, `${label}: ${row.name}`);
        }
        return label;
      };

      const wire = await load(L + "recording-wire-contract.ts");
      const adm = await load(L + "recording-admission-contract.ts");
      const ops = await load(L + "recording-operations-contract.ts");
      // transcript の document を種別に応じた parser で所有コピーにする
      const parseDoc = (v: any) =>
        !v.kind
          ? wire.parseRecordingWireStateFrame({
              version: 1,
              kind: "recordingWireStateFrame",
              subscriptionRef: "validation",
              snapshot: v,
            }).snapshot
          : v.kind.startsWith("recordingWire")
            ? wire.parseRecordingWireDocument(v)
            : v.kind.startsWith("recordingAdmission") ||
                v.kind === "recordingReconciliationDelivery"
              ? adm.parseRecordingAdmissionDocument(v)
              : ops.parseRecordingOperationsDocument(v);
      const model = async (file: string, rowsName: string, label: string) => {
        const f = await load(F + file);
        const row = f[rowsName]()[0];
        owned(parseDoc, row.document, `${label}: ${row.name}`);
        if (
          row.document.kind?.startsWith("recordingWire") &&
          row.document.kind.endsWith("Reply")
        )
          assert(
            wire.recordingWireReplyMatchesRequest(
              row.document,
              row.document.request,
            ),
            `${label}: correlation`,
          );
        return label;
      };
      const workflow = async (file: string, fn: string, label: string) => {
        const f = await load(F + file);
        const step = f[`${fn}Fixtures`].scenarios
          .flatMap((s: any) => s.steps)
          .find((s: any) => s.input);
        owned(parseDoc, f[`${fn}Document`](step.input), `${label}: input`);
        return model(file, `${fn}Transcripts`, label);
      };

      const checks: { name: string; run: () => Promise<string> | string }[] = [
        {
          name: "history-contract",
          run: async () => {
            const c = await load(L + "history-contract.ts");
            const ok = history.contract.find((r) => r.expected === "accepted")!;
            const ng = history.contract.find((r) => r.expected !== "accepted")!;
            assert(
              c.validateHistoryContract(ok.input) === "accepted",
              "history accepted",
            );
            owned(c.parseHistoryContract, ok.input, "history", false);
            assert(
              c.validateHistoryContract(ng.input) === ng.expected,
              "history rejected",
            );
            // SQLite の query / coverage / minmax / retention / retention job の結果
            for (const rows of [
              history.query,
              history.coverage,
              history.minmax,
              history.retention,
              history.retentionJob,
            ]) {
              const row = rows.find((r: any) => r.expected)!;
              assert(
                c.validateHistoryContract(row.expected) === "accepted",
                `history result: ${row.name}`,
              );
              owned(c.parseHistoryContract, row.expected, row.name, false);
            }
            return "history-contract";
          },
        },
        {
          name: "recording-plan",
          run: async () => {
            const p = await load(L + "recording-plan.ts");
            const f = await load(F + "recording-plan-cases.ts");
            const ok = f.cases.find((r: any) => r.accepted);
            assert(
              Object.isFrozen(
                p.parseRecordingPlan(f.recordingPlanCaseInput(ok)).group
                  .members[0],
              ),
              "plan member frozen",
            );
            return pair(
              f.cases,
              f.recordingPlanCaseInput,
              p.validateRecordingPlan,
              p.parseRecordingPlan,
              "recording-plan",
            );
          },
        },
        {
          name: "recording-management",
          run: async () => {
            const c = await load(L + "recording-management-contract.ts");
            const f = await load(F + "recording-management-cases.ts");
            return pair(
              f.fixtures.cases,
              f.managementCaseInput,
              c.validateRecordingManagement,
              c.parseRecordingManagementDocument,
              "recording-management",
            );
          },
        },
        {
          name: "recording-operations",
          run: async () => {
            const f = await load(F + "recording-operations-cases.ts");
            const eq = f.operationsFixtures.equalities[0];
            const a = structuredClone(f.operationsFixtures.bases[eq.base]),
              b = f.operationCaseInput(eq),
              snapshot = JSON.stringify({ a, b });
            const same: any = {
              context: ops.sameRecordingOperationsContext,
              change: ops.sameRecordingChangeRequest,
              operation: ops.sameRecordingOperationRequest,
              reconciliation: ops.sameRecordingReconciliationRequest,
            };
            same[eq.base](a, b);
            assert(JSON.stringify({ a, b }) === snapshot, "operations mutated");
            return pair(
              f.operationsFixtures.cases,
              f.operationCaseInput,
              ops.validateRecordingOperations,
              ops.parseRecordingOperationsDocument,
              "recording-operations",
            );
          },
        },
        {
          name: "recording-admission",
          run: async () => {
            const f = await load(F + "recording-admission-cases.ts");
            return pair(
              f.admissionFixtures.cases,
              f.admissionCaseInput,
              adm.validateRecordingAdmission,
              adm.parseRecordingAdmissionDocument,
              "recording-admission",
            );
          },
        },
        {
          name: "recording-wire-contract",
          run: async () => {
            const f = await load(F + "recording-wire-cases.ts");
            return pair(
              f.wireFixtures.cases,
              f.wireCaseInput,
              wire.validateRecordingWire,
              wire.parseRecordingWireDocument,
              "recording-wire-contract",
            );
          },
        },
        {
          name: "cancel-model",
          run: () =>
            model(
              "recording-cancel-model-cases.ts",
              "cancelModelTranscripts",
              "cancel-model",
            ),
        },
        {
          name: "observation-model",
          run: () =>
            model(
              "recording-observation-model-cases.ts",
              "observationModelTranscripts",
              "observation-model",
            ),
        },
        {
          name: "registry-model",
          run: () =>
            model(
              "recording-registry-model-cases.ts",
              "registryModelTranscripts",
              "registry-model",
            ),
        },
        {
          name: "subscription-model",
          run: () =>
            model(
              "recording-subscription-model-cases.ts",
              "subscriptionModelTranscripts",
              "subscription-model",
            ),
        },
        {
          name: "workflow-model",
          run: () =>
            workflow(
              "recording-workflow-model-cases.ts",
              "workflowModel",
              "workflow-model",
            ),
        },
        {
          name: "workflow-renewal",
          run: () =>
            workflow(
              "recording-workflow-renewal-cases.ts",
              "workflowRenewal",
              "workflow-renewal",
            ),
        },
        {
          name: "wire-receiver",
          run: async () => {
            const f = await load(F + "recording-wire-receiver-cases.ts");
            const d = f.runReceiverScenario(f.receiverFixtures.scenarios[0]);
            const r = f.runReceiverScenario(
              f.receiverReadoutFixtures.scenarios[0],
            );
            assert(
              typeof d.documents === "number" &&
                typeof r.terminalReads === "number",
              "receiver",
            );
            return "wire-receiver";
          },
        },
        {
          name: "delivery-ledger",
          run: async () => {
            const f = await load(F + "recording-wire-delivery-ledger-cases.ts");
            const row = f.runDeliveryScenario(f.deliveryFixtures.scenarios[0]);
            assert(typeof row.documents === "number", "delivery ledger");
            const o = await load(
              F + "recording-wire-observation-ledger-cases.ts",
            );
            o.runObservationLedgerScenario(
              o.observationLedgerCases.scenarios[0],
            );
            return "delivery-ledger";
          },
        },
        {
          name: "local-v2",
          run: async () => {
            const f = await load(F + "recording-wire-local-v2-cases.ts");
            const u = await f.runLocalV2Scenario(f.localV2Cases.scenarios[0]);
            assert(u.pending === 0 && u.delivered > 0, "local-v2 usage");
            return "local-v2";
          },
        },
        {
          name: "coordinator-v2",
          run: async () => {
            const f = await load(F + "recording-wire-coordinator-v2-cases.ts");
            const u = await f.runCoordinatorV2Scenario(
              f.coordinatorV2Cases.scenarios[0],
            );
            assert(u.tracks === 1 && u.attempts === 1, "coordinator-v2 usage");
            return "coordinator-v2";
          },
        },
      ];
      const done: string[] = [];
      for (const check of checks) {
        try {
          done.push(await check.run());
        } catch (error) {
          throw Error(`${check.name}: ${(error as Error).message}`);
        }
      }
      return done;
    },
    {
      contract: historyCases,
      query: queryCases,
      coverage: coverageCases,
      minmax: minmaxCases,
      retention: retentionCases,
      retentionJob: retentionJobCases,
    },
  );

  expect(summary).toHaveLength(16);
  expect(remote).toEqual([]);
  expect(await downloadBytes(await downloadProject(page))).toEqual(before);
});
