import { test, expect } from "@playwright/test";
import { downloadBytes, downloadProject } from "./helpers/project-files";
test("pure delivery ledger preserves originals and recovery attempts without native dispatch", async ({
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
    const path =
        "/src/lib/__fixtures__/recording-wire-delivery-ledger-cases.ts",
      f = await import(path);
    let documents = 0,
      reads = 0;
    for (const scenario of f.deliveryFixtures.scenarios) {
      const row = f.runDeliveryScenario(scenario);
      documents += row.documents;
      reads += row.reads;
    }
    const l = f.makeDelivery(),
      q = f.deliveryRequest(),
      o = l.beginOriginal(q).value,
      p = l.beginInspection(o, f.deliveryQuery(q)).value,
      committed = l.current();
    let traps = 0;
    const incoming = new Proxy(
      f.deliveryInspection(f.deliveryQuery(q), "terminal", f.deliveryReply(q)),
      {
        getOwnPropertyDescriptor(target, key) {
          if (
            l.current() !== committed ||
            l.original(o).reason !== "busy" ||
            l.attempt(p.attempt).reason !== "busy" ||
            l.dispose().reason !== "busy"
          )
            throw Error("reentrant exposure");
          traps++;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    if (
      !l.acceptInspection(p.attempt, incoming).ok ||
      l.original(o).value.learnedBy !== "inspection"
    )
      throw Error("recovery delivery");
    const view = l.current();
    for (let i = 0; i < 100; i++) {
      l.original(o);
      l.inspection(p.query);
      l.attempt(p.attempt);
    }
    if (l.current() !== view) throw Error("getter republished");
    return {
      scenarios: f.deliveryFixtures.scenarios.length,
      documents,
      reads,
      traps,
    };
  });
  expect(result.scenarios).toBe(61);
  expect(result.documents).toBeGreaterThan(150);
  expect(result.reads).toBeGreaterThan(200);
  expect(result.traps).toBeGreaterThan(0);
  expect(remote).toEqual([]);
  expect(await downloadBytes(await downloadProject(page))).toEqual(before);
});

test("Observation ledger advances pending to terminal in the real browser module", async ({
  page,
}) => {
  await page.goto("/");
  const before = await downloadBytes(await downloadProject(page));
  const state = await page.evaluate(async () => {
    const ledgerPath = "/src/lib/recording-wire-delivery-ledger.ts";
    const fixturePath =
      "/src/lib/__fixtures__/recording-wire-delivery-ledger-cases.ts";
    const wirePath = "/src/lib/__fixtures__/recording-wire-cases.ts";
    const observationCasesPath =
      "/src/lib/__fixtures__/recording-wire-observation-ledger-cases.ts";
    const ledgerModule = await import(ledgerPath);
    const delivery = await import(fixturePath);
    const wire = await import(wirePath);
    const cases = await import(observationCasesPath);
    for (const scenario of cases.observationLedgerCases.scenarios)
      cases.runObservationLedgerScenario(scenario);
    const observation = delivery.cloneDelivery(wire.wireFixtures.bases.observe);
    const terminal = delivery.cloneDelivery(
      wire.wireFixtures.bases.observationReply,
    );
    const admission = delivery.deliveryRequest("admit");
    admission.action = {
      kind: "apply",
      changeRef: "change-ref",
      operation: observation.target.request,
    };
    const accepted = {
      version: 1,
      kind: "recordingAdmissionReply",
      request: delivery.cloneDelivery(admission),
      outcome: {
        kind: "accepted",
        handle: {
          kind: "operation",
          changeRef: "change-ref",
          operationRef: observation.target.operationRef,
          request: delivery.cloneDelivery(observation.target.request),
        },
      },
    };
    const made = ledgerModule.createRecordingWireDeliveryLedger(
      delivery.deliveryFixtures.scope,
    );
    if (!made.ok) throw Error("factory");
    const l = made.value;
    const original = l.beginOriginal(admission);
    if (!original.ok || !l.acceptOriginal(original.value, accepted).ok)
      throw Error("admission");
    const target = l.bindObservationTarget(original.value);
    if (!target.ok) throw Error("target");
    const pair = l.beginObservation(target.value, observation);
    if (!pair.ok || l.repeatObservation(pair.value.query).reason !== "busy")
      throw Error("lost attempt");
    const pending = {
      version: 1,
      kind: "recordingWireObservationReply",
      request: observation,
      outcome: { kind: "pending" },
    };
    if (!l.acceptObservation(pair.value.attempt, pending).ok)
      throw Error("pending");
    const second = l.repeatObservation(pair.value.query);
    if (!second.ok || !l.acceptObservation(second.value, terminal).ok)
      throw Error("terminal");
    const view = l.current();
    for (let i = 0; i < 100; i++) {
      l.observationTarget(target.value);
      l.observation(pair.value.query);
      l.observationAttempt(second.value);
    }
    if (l.current() !== view) throw Error("getter republished");
    return {
      result: l.observationTarget(target.value).value.result,
      usage: view.usage,
      scenarios: cases.observationLedgerCases.scenarios.length,
    };
  });
  expect(state.scenarios).toBe(3);
  expect(state.result).toMatchObject({ kind: "recordingOperationResult" });
  expect(state.usage).toMatchObject({
    awaitingObservationReply: 0,
    pendingObservationQueries: 0,
    observationAttempts: 2,
  });
  expect(await downloadBytes(await downloadProject(page))).toEqual(before);
});
