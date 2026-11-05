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
