import { describe, expect, it } from "vitest";
import sample from "../../../../examples/minimal.project.json";
import operationCases from "../../../../examples/operation-cases.json";
import type { EquipmentSlot, SlotType, SlotWrite } from "./equipment";
import { parseProject } from "./project";
import {
  defaultSlotWrite,
  nextButtonValue,
  parseWriteNumber,
  slotWriteError,
  slotWriteProblem,
} from "./slot-write-edit";

describe("slot write editing", () => {
  it("starts every slot type from a definition the model accepts", () => {
    for (const type of ["bool", "number", "state"] as SlotType[]) {
      const write = defaultSlotWrite(type);
      expect(slotWriteProblem(type, write)).toBeUndefined();
    }
  });

  it("agrees with the shared contract on every operation case", () => {
    for (const { name, valid, ...config } of operationCases) {
      let parses = true;
      try {
        parseProject(JSON.stringify({ ...sample, ...config }));
      } catch {
        parses = false;
      }
      expect(parses, name).toBe(valid);
      const problems = config.equipmentTypes[0].slots
        .map((slot) => slotWriteError(slot as EquipmentSlot))
        .filter(Boolean);
      // Unknown properties are left to the schema; everything else is shown.
      if (!/unknown|missing label/.test(name))
        expect(problems.length === 0, `${name}: ${problems}`).toBe(valid);
    }
  });

  it("reads only half-width decimals", () => {
    expect(parseWriteNumber("-1.5")).toBe(-1.5);
    expect(parseWriteNumber("60")).toBe(60);
    for (const text of ["", "-", "1.", "１", "1,000", "1e3", "NaN", "Infinity", " 1"])
      expect(parseWriteNumber(text), text).toBeNaN();
  });

  it("offers the next unused value for a new button", () => {
    const bool: SlotWrite = { label: "a", buttons: [{ label: "入", value: true }] };
    expect(nextButtonValue("bool", bool)).toBe(false);
    const state: SlotWrite = {
      label: "a",
      buttons: [
        { label: "a", value: 2 },
        { label: "b", value: 0 },
      ],
    };
    expect(nextButtonValue("state", state)).toBe(3);
    expect(nextButtonValue("number", { label: "a", input: { min: 0, max: 1 } })).toBe(0);
  });

  it("names the slot and the button in the problem", () => {
    const slot: EquipmentSlot = {
      name: "mode",
      type: "state",
      direction: "read",
      write: {
        label: "モード",
        buttons: [
          { label: "手動", value: 1 },
          { label: "自動", value: 1 },
        ],
      },
    };
    expect(slotWriteError(slot)).toBe(
      "modeの操作: ボタン2: 同じ値のボタンが上にあります",
    );
    expect(
      slotWriteError({ ...slot, write: { label: "モード", buttons: [{ label: "", value: 1 }] } }),
    ).toBe("modeの操作: ボタン1: 見出しを入れてください");
    expect(
      slotWriteError({ ...slot, write: { label: "x", buttons: [{ label: "x", value: Number.NaN }] } }),
    ).toMatch(/整数で入れて/);
  });
});
