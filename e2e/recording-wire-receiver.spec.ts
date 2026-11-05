import { test, expect } from "@playwright/test";
import { downloadBytes, downloadProject } from "./helpers/project-files";
test("pure wire receiver runs ordering, terminal and quota scenarios without native dispatch", async ({
  page,
}) => {
  const remote: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).hostname === "temp-scada.invalid")
      remote.push(request.url());
  });
  await page.goto("/");
  const before = await downloadBytes(await downloadProject(page));
  const result = await page.evaluate(async () => {
    const path = "/src/lib/__fixtures__/recording-wire-receiver-cases.ts";
    const f = await import(path);
    let documents = 0;
    for (const scenario of f.receiverFixtures.scenarios)
      documents += f.runReceiverScenario(scenario).documents;
    const r = f.makeReceiver();
    r.setConnected(true);
    const q = f.receiverAttachRequest(),
      g = r.beginAttach(q).value,
      prior = r.current();
    let nested = 0;
    const reply = new Proxy(f.receiverAttachReply(q), {
      getPrototypeOf(target) {
        const result = r.dispose();
        if (result.ok || result.reason !== "busy" || r.current() !== prior)
          throw Error("reentry changed committed state");
        nested++;
        return Reflect.getPrototypeOf(target);
      },
    });
    if (!r.acceptAttach(g, reply).ok || r.current().highwater !== 1 || !nested)
      throw Error("browser reentry");
    return {
      scenarios: f.receiverFixtures.scenarios.length,
      documents,
      nested,
    };
  });
  expect(result.scenarios).toBe(59);
  expect(result.documents).toBeGreaterThan(170);
  expect(result.nested).toBeGreaterThan(0);
  expect(remote).toEqual([]);
  expect(await downloadBytes(await downloadProject(page))).toEqual(before);
});

test("receiver readout preserves original replies and historical display without App injection", async ({
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
    const path = "/src/lib/__fixtures__/recording-wire-receiver-cases.ts",
      f = await import(path);
    let reads = 0;
    for (const scenario of f.receiverReadoutFixtures.scenarios)
      reads += f.runReceiverScenario(scenario).terminalReads;
    const r = f.makeReceiver();
    r.setConnected(true);
    const q = f.receiverAttachRequest(),
      g = r.beginAttach(q).value,
      old = r.currentDisplay();
    let nested = 0;
    const reply = new Proxy(f.receiverAttachReply(q), {
      getOwnPropertyDescriptor(target, key) {
        if (
          r.currentDisplay() !== old ||
          r.attachTerminal(g).reason !== "busy" ||
          r.controlTerminal({}).reason !== "busy"
        )
          throw Error("partial readout");
        nested++;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    if (
      !r.acceptAttach(g, reply).ok ||
      r.attachTerminal(g).value.kind !== "terminal" ||
      r.currentDisplay().snapshotRelation !== "currentSubscription"
    )
      throw Error("terminal delivery");
    const state = r.current(),
      display = r.currentDisplay();
    for (let n = 0; n < 100; n++) r.attachTerminal(g);
    if (r.current() !== state || r.currentDisplay() !== display)
      throw Error("getter mutated cache");
    return {
      scenarios: f.receiverReadoutFixtures.scenarios.length,
      reads,
      nested,
    };
  });
  expect(result.scenarios).toBe(19);
  expect(result.reads).toBeGreaterThan(50);
  expect(result.nested).toBeGreaterThan(0);
  expect(remote).toEqual([]);
  expect(await downloadBytes(await downloadProject(page))).toEqual(before);
});
