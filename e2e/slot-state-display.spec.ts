import { test, expect } from "@playwright/test";
import sample from "../examples/state-color.project.json" with { type: "json" };

// A3: a Symbol Text bound to a slot shows the equipment-type state definition
// (state rows, bool labels, "none" for an allowed unassigned slot) in place of
// the raw value text; unknown readings keep the reason text.
test("slot-bound Text shows the equipment-type state definition", async ({
  page,
}) => {
  await page.goto("/");
  const texts = await page.evaluate(async (sample) => {
    const { mount, unmount, tick } =
      await import("/node_modules/.vite/deps/svelte.js");
    const { parseProject } = await import("/src/lib/project.ts");
    const { slotPresentation } = await import("/src/lib/slot-presentation.ts");
    const { default: ScreenPainting } =
      await import("/src/lib/ScreenPainting.svelte");
    const value = (sample as any).symbols[0].objects[6];
    value.shape.slotBinding = { slotName: "mode" };
    (sample as any).symbols[0].readSlots.push({
      name: "mode",
      type: "state",
      direction: "read",
    });
    (sample as any).equipmentTypes[0].slots = [
      {
        name: "running",
        type: "bool",
        direction: "read",
        boolDisplay: {
          true: { text: "運転", color: "#16a34a" },
          false: { text: "停止", color: "#64748b" },
        },
      },
      { name: "current", type: "number", direction: "read" },
      {
        name: "mode",
        type: "state",
        direction: "read",
        allowUnassigned: true,
        stateDisplay: {
          source: "bits",
          rows: [
            { match: 2, text: "故障", color: "#dc2626" },
            { match: 0, text: "自動", color: "#2563eb" },
          ],
          otherwise: { text: "手動", color: "#64748b" },
        },
      },
    ];
    const [p101, p102] = (sample as any).equipment;
    p101.bindings = [
      { slotName: "running", externalName: "P101.Run" },
      { slotName: "mode", externalName: null },
    ];
    p102.bindings = [
      { slotName: "running", externalName: "P102.Run" },
      { slotName: "mode", externalName: "P102.Mode" },
    ];
    const project = parseProject(JSON.stringify(sample));
    const provenance = {
      valueSource: "real",
      collectionMode: "configured",
      catalogRevision: 1,
      runId: null,
      sourceTimestampMs: 0,
    };
    const values: Record<string, any> = {
      "P101.Run": slotPresentation("bad"),
      "P102.Run": {
        state: "good",
        label: "Good",
        text: "true",
        value: { type: "bool", value: true },
        provenance,
      },
      "P102.Mode": {
        state: "good",
        label: "Good",
        text: "5",
        value: { type: "number", value: 5 },
        provenance,
      },
    };
    const target = document.createElement("div");
    target.style.cssText =
      "position:fixed;left:0;top:0;width:960px;height:700px";
    document.body.append(target);
    const render = () =>
      mount(ScreenPainting, {
        target,
        props: {
          screen: project.screens[0],
          screens: project.screens,
          symbols: project.symbols,
          equipmentContext: {
            equipmentTypes: project.equipmentTypes,
            equipment: project.equipment,
            readSlot: (
              _id: string,
              _slot: string,
              _type: string,
              name: string,
            ) => values[name],
          },
        },
      });
    const flush = async () => {
      await tick();
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    };
    let app = render();
    await flush();
    const read = (equipmentId: string, childId: string) =>
      [...target.querySelectorAll("[data-symbol-id]")]
        .filter((svg) =>
          project.screens[0].objects.some(
            (object: any) =>
              object.shape.equipmentId === equipmentId &&
              svg.closest(`[data-projected-object-id="${object.id}"]`),
          ),
        )
        .map((svg) =>
          svg
            .querySelector(
              `[data-symbol-child-id="${childId}"] [data-text-content]`,
            )
            ?.textContent?.trim(),
        );
    const result = {
      p101Run: read(p101.id, sample.symbols[0].objects[5].id),
      p101Mode: read(p101.id, value.id),
      p102Run: read(p102.id, sample.symbols[0].objects[5].id),
      p102Mode: read(p102.id, value.id),
    };
    unmount(app);
    // A Good but fractional SIM word cannot be a state: invalid, not raw text.
    values["P102.Mode"] = {
      state: "good",
      label: "Good",
      text: "SIM · 1.5",
      value: { type: "number", value: 1.5 },
      provenance: { ...provenance, valueSource: "simulation" },
    };
    app = render();
    await flush();
    const invalid = {
      text: read(p102.id, value.id),
      state: [
        ...target.querySelectorAll(
          `[data-symbol-child-id="${value.id}"] [data-tag-state]`,
        ),
      ].map((node) => node.getAttribute("data-tag-state")),
    };
    unmount(app);
    target.remove();
    return { ...result, invalid };
  }, structuredClone(sample));
  // Bad keeps the reason; an allowed unassigned state is "none" (otherwise).
  expect(texts.p101Run.every((text) => text === "-- · 不良")).toBe(true);
  expect(texts.p101Mode.every((text) => text === "手動")).toBe(true);
  expect(texts.p102Run.every((text) => text === "運転")).toBe(true);
  // 5 = bits 0 and 2; the upper row (bit 2) wins.
  expect(texts.p102Mode.every((text) => text === "故障")).toBe(true);
  expect(texts.p102Mode.length).toBeGreaterThan(0);
  expect(texts.p101Mode.length).toBeGreaterThan(0);
  expect(texts.invalid.text.length).toBeGreaterThan(0);
  expect(
    texts.invalid.text.every((text) => text === "SIM · -- · 値が不正"),
  ).toBe(true);
  expect(texts.invalid.state).toContain("invalid");
});
