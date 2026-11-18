import { bindingReferences } from "../lib/binding-references";
import { slotReadType } from "../lib/equipment";
import type { Project } from "../lib/project";
import type { ReadSource } from "../lib/designer/controllers/read-presentation.svelte";
import type { ReadDisplayUpdate } from "../lib/read-presentation";
import type { ReadSlotRow, SlotProvenance } from "../lib/read-slot-session";
import type { NumericReading } from "../lib/tag-presentation";
import type { DemoClock, DemoScenario, DemoValue } from "./scenario";

/**
 * 模擬値の読取 source。Project が読むタグ（画面直下の結合と機器の slot）を
 * 筋書きの値で満たし、製品の Host と同じ表示 DTO（`ReadDisplayUpdate`）で渡す。
 * 筋書きに無いタグは「未解決」のままにし、値を作らない。
 */
export function createDemoReadSource(
  scenario: DemoScenario,
  clock: DemoClock,
): ReadSource {
  return {
    subscribe(project, begin) {
      const delivery = begin();
      let sequence = 0;
      const stop = clock.every(() => {
        const nowMs = clock.nowMs();
        sequence += 1;
        delivery.receive(
          demoUpdate(project, scenario.values(nowMs / 1000), nowMs, sequence),
        );
      });
      return () => {
        stop();
        delivery.close();
      };
    },
  };
}

/** 1 回分の表示 DTO。値の出所は `internal`（Hub・PLC の値ではない）。 */
export function demoUpdate(
  project: Project,
  values: Record<string, DemoValue>,
  nowMs: number,
  sequence: number,
): ReadDisplayUpdate {
  const provenance: SlotProvenance = {
    catalogRevision: 1,
    runId: 1,
    collectionMode: "configured",
    valueSource: "internal",
    sourceTimestampMs: Math.floor(nowMs),
  };
  const valueOf = (name: string): DemoValue | undefined =>
    Object.hasOwn(values, name) ? values[name] : undefined;
  const head = {
    projectId: project.manifest.projectId,
    projectRevision: project.manifest.projectRevision,
    connection: "live",
    lastError: null,
    metadataReady: true,
  };
  const readings: Record<string, NumericReading> = {};
  const origins: Record<string, SlotProvenance> = {};
  for (const { externalName } of bindingReferences(project)) {
    const value = valueOf(externalName);
    if (value === undefined) {
      readings[externalName] = { state: "unresolved" };
      continue;
    }
    readings[externalName] =
      typeof value === "boolean"
        ? {
            state: "resolved",
            quality: "good",
            numericValue: null,
            boolValue: value,
          }
        : { state: "resolved", quality: "good", numericValue: value };
    origins[externalName] = provenance;
  }
  const slots: ReadSlotRow[] = [];
  for (const equipment of project.equipment ?? []) {
    const type = project.equipmentTypes?.find(
      (row) => row.id === equipment.typeId,
    );
    for (const binding of equipment.bindings) {
      const slot = type?.slots.find((row) => row.name === binding.slotName);
      if (!slot) continue;
      const expectedType = slotReadType(slot.type);
      const row = {
        key: { equipmentId: equipment.id, slotName: slot.name },
        expectedType,
        externalName: binding.externalName,
      };
      if (binding.externalName === null) {
        slots.push({
          ...row,
          reading: { state: "unassigned" },
          provenance: null,
        });
        continue;
      }
      const value = valueOf(binding.externalName);
      if (value === undefined)
        slots.push({
          ...row,
          reading: { state: "unresolved" },
          provenance: null,
        });
      else if (typeof value === "boolean" && expectedType === "bool")
        slots.push({
          ...row,
          reading: {
            state: "resolved",
            quality: "good",
            value: { type: "bool", value },
          },
          provenance,
        });
      else if (typeof value === "number" && expectedType === "number")
        slots.push({
          ...row,
          reading: {
            state: "resolved",
            quality: "good",
            value: { type: "number", value },
          },
          provenance,
        });
      else
        slots.push({
          ...row,
          reading: { state: "invalid", reason: "typeMismatch" },
          provenance: null,
        });
    }
  }
  return {
    sequence,
    sdkGeneration: 1,
    text: { ...head, readings, provenance: origins },
    slots: { ...head, slots },
  };
}
