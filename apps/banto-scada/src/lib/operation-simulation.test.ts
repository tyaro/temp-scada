import { describe, expect, it } from "vitest";
import sample from "../../../../examples/read-presentation.project.json" with { type: "json" };
import { buildOperationRequest, reasonText } from "./operation";
import { faceplateNotice, rowStatus } from "./operation-faceplate";
import {
  createSimulatedOperationHost,
  emptySimulation,
  SIMULATED_DIGEST,
  SIMULATED_ON_HUB,
  simulatedReadContext,
  simulatedView,
  simulateWrite,
  type Simulation,
} from "./operation-simulation";
import { parseProject, type Project } from "./project";
import { readPresentationContext } from "./read-presentation";
import { resolveEquipmentSlot } from "./symbol-slots";

/** The sample with `write` on the motor type's slots (as runtime-mode.spec.ts). */
function operationProject(): Project {
  const project = structuredClone(sample) as any;
  for (const type of project.equipmentTypes)
    for (const slot of type.slots)
      if (slot.name === "running")
        slot.write = {
          label: "運転指令",
          buttons: [
            { label: "運転", value: true },
            { label: "停止", value: false },
          ],
        };
      else if (slot.name === "current")
        slot.write = { label: "電流 設定", input: { min: 0, max: 100 } };
  return parseProject(JSON.stringify(project));
}
const project = operationProject();
// A Symbol placement linked to equipment, and that equipment's bound slots.
const placed = project.screens
  .flatMap((screen) => screen.objects.map((object) => ({ screen, object })))
  .find(
    ({ object }) =>
      object.shape.type === "symbol" &&
      project.equipment?.some(
        (item) =>
          object.shape.type === "symbol" &&
          item.id === object.shape.equipmentId,
      ),
  )!;
const equipmentId = (placed.object.shape as { equipmentId: string })
  .equipmentId;
const equipment = project.equipment!.find((item) => item.id === equipmentId)!;
const tagOf = (slot: string) =>
  equipment.bindings.find((item) => item.slotName === slot)?.externalName ??
  null;

const request = (
  slotName: string,
  choice: { buttonIndex: number } | { input: string },
  expectedValue: boolean | number,
) =>
  buildOperationRequest({
    projectId: project.manifest.projectId,
    projectDigest: SIMULATED_DIGEST,
    screenId: placed.screen.id,
    objectId: placed.object.id,
    equipmentId,
    slotName,
    choice,
    expectedValue,
  });
/** The project with `slot` bound to `tag` on the placed equipment. */
function bound(slot: string, tag: string | null): Project {
  const copy = structuredClone(project) as any;
  const target = copy.equipment.find((item: any) => item.id === equipmentId);
  target.bindings = target.bindings
    .filter((item: any) => item.slotName !== slot)
    .concat([{ slotName: slot, externalName: tag }]);
  return parseProject(JSON.stringify(copy));
}

describe("simulateWrite", () => {
  const both = project;
  // One decimal shown for `current` on the pressed Symbol limits the input.
  const withTags = structuredClone(project) as any;
  withTags.symbols[0].objects.push({
    slotBinding: { slotName: "current" },
    format: { decimals: 1 },
  });

  it("a button sets the simulated value of the slot's tag and the latest per slot", () => {
    const { simulation, result } = simulateWrite(
      both,
      emptySimulation(),
      request("running", { buttonIndex: 0 }, true),
      1000,
    );
    expect(result).toMatchObject({
      outcome: "ok",
      tag: "Demo.Bool",
      value: true,
      recordId: "simulated-1",
      unrecorded: false,
    });
    expect(simulation.values.get("Demo.Bool")).toEqual({
      value: { type: "bool", value: true },
      atMs: 1000,
    });
    const view = simulatedView(both, simulation, equipmentId, false);
    expect(view.blocked).toBeNull();
    expect(view.projectDigest).toBe(SIMULATED_DIGEST);
    const running = view.slots.find((item) => item.slot === "running");
    expect(running?.latest).toMatchObject({
      id: "simulated-1",
      outcome: "ok",
      value: true,
    });
    expect(
      view.slots.find((item) => item.slot === "current")?.latest,
    ).toBeNull();
    // The row shows the written value of the latest simulated write.
    expect(
      rowStatus(
        running!.latest,
        { kind: "result", result, atMs: 1000 },
        {
          buttons: [{ index: 0, label: "運転", value: true }],
        },
      )?.value,
    ).toBe("運転（true）");

    // A second write replaces the latest of that slot only.
    const next = simulateWrite(
      both,
      simulation,
      request("running", { buttonIndex: 1 }, false),
      2000,
    );
    const again = simulatedView(both, next.simulation, equipmentId, false);
    expect(
      again.slots.find((item) => item.slot === "running")?.latest,
    ).toMatchObject({ id: "simulated-2", value: false });
  });

  it("an input honours the range and the displayed decimals", () => {
    const ok = simulateWrite(
      withTags,
      emptySimulation(),
      request("current", { input: "42" }, 42),
      1,
    );
    expect(ok.result.outcome).toBe("ok");
    expect(ok.simulation.values.get("Demo.Number")?.value).toEqual({
      type: "number",
      value: 42,
    });
    const range = simulateWrite(
      withTags,
      emptySimulation(),
      request("current", { input: "120" }, 120),
      1,
    );
    expect(range.result).toMatchObject({
      outcome: "refused",
      reason: "out_of_range",
    });
    expect(range.simulation.values.size).toBe(0);
    const text = simulateWrite(
      withTags,
      emptySimulation(),
      request("current", { input: "1e2" }, 100),
      1,
    );
    expect(text.result.reason).toBe("invalid_value");
    expect(
      simulateWrite(
        withTags,
        emptySimulation(),
        request("current", { input: "12.5" }, 12.5),
        1,
      ).result.outcome,
    ).toBe("ok");
    expect(
      simulateWrite(
        withTags,
        emptySimulation(),
        request("current", { input: "12.25" }, 12.25),
        1,
      ).result.reason,
    ).toBe("invalid_value");
  });

  it("refuses an unbound slot, an unknown button and a changed value", () => {
    const unbound = bound("running", null);
    expect(
      simulateWrite(
        unbound,
        emptySimulation(),
        request("running", { buttonIndex: 0 }, true),
        1,
      ).result,
    ).toMatchObject({ outcome: "refused", reason: "unbound", recordId: null });
    expect(
      simulateWrite(
        both,
        emptySimulation(),
        request("running", { buttonIndex: 5 }, true),
        1,
      ).result.reason,
    ).toBe("invalid_button");
    expect(
      simulateWrite(
        both,
        emptySimulation(),
        request("running", { buttonIndex: 0 }, false),
        1,
      ).result.reason,
    ).toBe("project_changed");
    expect(
      simulateWrite(
        both,
        emptySimulation(),
        { ...request("running", { buttonIndex: 0 }, true), projectDigest: "x" },
        1,
      ).result.reason,
    ).toBe("project_changed");
  });

  it("the host disables the rows and never writes while the preview reads a real Hub", async () => {
    let simulation: Simulation = emptySimulation();
    let readsHub = true;
    const host = createSimulatedOperationHost({
      project: () => both,
      simulation: () => simulation,
      readsHub: () => readsHub,
      update: (next) => (simulation = next),
      now: () => 7,
    });
    expect(host.simulated).toBe(true);
    const view = await host.view(equipmentId);
    expect(view.blocked).toBe(SIMULATED_ON_HUB);
    expect(
      faceplateNotice(
        { status: "ready", view },
        { screenId: placed.screen.id, objectId: placed.object.id },
        false,
        host,
      ),
    ).toEqual({ disabled: reasonText(SIMULATED_ON_HUB), banner: null });
    expect(reasonText(SIMULATED_ON_HUB)).toBe(
      "実Hubの購読中は模擬の書込みはできません",
    );
    const refused = await host.write(
      request("running", { buttonIndex: 0 }, true),
    );
    expect(refused).toMatchObject({
      outcome: "refused",
      reason: SIMULATED_ON_HUB,
    });
    expect(simulation.values.size).toBe(0);

    readsHub = false;
    const notice = faceplateNotice(
      { status: "ready", view: await host.view(equipmentId) },
      { screenId: placed.screen.id, objectId: placed.object.id },
      false,
      host,
    );
    expect(notice).toEqual({ disabled: null, banner: null });
    const result = await host.write(
      request("running", { buttonIndex: 0 }, true),
    );
    expect(result.outcome).toBe("ok");
    expect(simulation.values.get("Demo.Bool")?.atMs).toBe(7);
  });
});

describe("simulatedReadContext", () => {
  it("shows a simulated value as Good with SIM on the slot and the tag", () => {
    const withTag = project;
    const base = readPresentationContext(withTag);
    const { simulation } = simulateWrite(
      withTag,
      emptySimulation(),
      request("current", { input: "12.5" }, 12.5),
      3,
    );
    const context = simulatedReadContext(base, simulation, withTag);
    const display = resolveEquipmentSlot(
      equipmentId,
      "current",
      "number",
      context.equipmentContext,
    );
    expect(display).toMatchObject({
      state: "good",
      text: "SIM · 12.5",
      value: { type: "number", value: 12.5 },
      provenance: { valueSource: "simulation", sourceTimestampMs: 3 },
    });
    expect(context.readings.get("Demo.Number")).toMatchObject({
      state: "resolved",
      quality: "good",
      numericValue: 12.5,
    });
    expect(context.readings.has("Demo.Number")).toBe(true);
    // Another Project does not see these values.
    const other = structuredClone(withTag) as any;
    other.manifest.projectId = "0199f700-0000-7000-8000-0000000000ff";
    const otherProject = parseProject(JSON.stringify(other));
    const unrelated = simulatedReadContext(
      readPresentationContext(otherProject),
      simulation,
      otherProject,
    );
    expect(unrelated.readings.has("Demo.Number")).toBe(false);
  });
});
