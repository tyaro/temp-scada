import { test, expect } from "@playwright/test";
import sample from "../examples/state-color.project.json" with { type: "json" };

// A3b: a Symbol Text with `stateColors` takes its color from the equipment-type
// slot definition (state row / boolDisplay), and an unknown state uses
// `unknownColor`. Shapes following that Text resolve the same color.
test("state-following Text and followers use the slot definition colors", async ({
  page,
}) => {
  await page.goto("/");
  const colors = await page.evaluate(async (sample) => {
    const { mount, unmount, tick } =
      await import("/node_modules/.vite/deps/svelte.js");
    const { parseProject } = await import("/src/lib/project.ts");
    const { slotPresentation } = await import("/src/lib/slot-presentation.ts");
    const { default: ScreenPainting } =
      await import("/src/lib/ScreenPainting.svelte");
    const definition = (sample as any).symbols[0];
    const running = definition.objects[5],
      mode = definition.objects[6],
      line = definition.objects[0],
      rect = definition.objects[7];
    mode.shape.slotBinding = { slotName: "mode" };
    mode.shape.stateColors = { unknownColor: "#9333ea" };
    rect.shape.stateColor = { textId: mode.id };
    definition.readSlots.push({
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
        stateDisplay: {
          source: "value",
          rows: [
            { match: 5, text: "故障", color: "#dc2626" },
            { match: 1, text: "自動", color: "#2563eb" },
          ],
          otherwise: { text: "手動", color: "#0ea5e9" },
        },
      },
    ];
    const [p101, p102] = (sample as any).equipment;
    p101.bindings = [
      { slotName: "running", externalName: "P101.Run" },
      { slotName: "mode", externalName: "P101.Mode" },
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
    const good = (value: any) => ({
      state: "good",
      label: "Good",
      text: String(value.value),
      value,
      provenance,
    });
    const values: Record<string, any> = {
      "P101.Run": slotPresentation("bad"),
      "P101.Mode": good({ type: "number", value: 5 }),
      "P102.Run": good({ type: "bool", value: true }),
      "P102.Mode": slotPresentation("disconnected"),
    };
    const target = document.createElement("div");
    target.style.cssText =
      "position:fixed;left:0;top:0;width:960px;height:700px";
    document.body.append(target);
    const app = mount(ScreenPainting, {
      target,
      props: {
        screen: project.screens[0],
        screens: project.screens,
        symbols: project.symbols,
        equipmentContext: {
          equipmentTypes: project.equipmentTypes,
          equipment: project.equipment,
          readSlot: (_id: string, _slot: string, _type: string, name: string) =>
            values[name],
        },
      },
    });
    await tick();
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    const read = (equipmentId: string, childId: string, selector: string) =>
      [...target.querySelectorAll("[data-symbol-id]")]
        .filter((svg) =>
          project.screens[0].objects.some(
            (object: any) =>
              object.shape.equipmentId === equipmentId &&
              svg.closest(`[data-projected-object-id="${object.id}"]`),
          ),
        )
        .map((svg) => {
          const node = svg.querySelector(
            `[data-symbol-child-id="${childId}"] ${selector}`,
          );
          return selector === "polyline"
            ? node?.getAttribute("stroke")
            : node?.getAttribute("fill");
        });
    const result = Object.fromEntries(
      [
        ["p101", p101.id],
        ["p102", p102.id],
      ].flatMap(([key, id]) => [
        [`${key}Run`, read(id, running.id, "[data-text-content]")],
        [`${key}Line`, read(id, line.id, "polyline")],
        [`${key}Mode`, read(id, mode.id, "[data-text-content]")],
        [`${key}Rect`, read(id, rect.id, "rect")],
      ]),
    );
    unmount(app);
    target.remove();
    return result;
  }, structuredClone(sample));
  const all = (values: (string | null | undefined)[], color: string) => {
    expect(values.length).toBeGreaterThan(0);
    expect(values.every((value) => value === color)).toBe(true);
  };
  // Bad bool: the Text's unknownColor, and the line follows it.
  all(colors.p101Run, "#d97706");
  all(colors.p101Line, "#d97706");
  // state 5: the matched row color for the Text and the following rectangle.
  all(colors.p101Mode, "#dc2626");
  all(colors.p101Rect, "#dc2626");
  // bool true: the boolDisplay color.
  all(colors.p102Run, "#16a34a");
  all(colors.p102Line, "#16a34a");
  // Disconnected state: unknownColor, never the previous or a false color.
  all(colors.p102Mode, "#9333ea");
  all(colors.p102Rect, "#9333ea");
});
