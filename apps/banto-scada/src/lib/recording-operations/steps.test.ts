import { describe, expect, it } from "vitest";
import {
  nextOperationStep,
  operationStepDone,
  outcomeProgress,
  type OperationStepInput,
} from "./steps";

const input = (patch: Partial<OperationStepInput>): OperationStepInput => ({
  canPreflight: false,
  canPause: false,
  canApply: false,
  progress: 0,
  ...patch,
});

describe("nextOperationStep", () => {
  it("follows inspect, pause and join, apply", () => {
    expect(nextOperationStep(input({ canPreflight: true }))).toBe(1);
    expect(nextOperationStep(input({ canPause: true, progress: 1 }))).toBe(2);
    expect(nextOperationStep(input({ canApply: true, progress: 2 }))).toBe(3);
  });

  it("asks to resume after an apply, before a new inspection", () => {
    expect(nextOperationStep(input({ canPreflight: true, progress: 3 }))).toBe(
      4,
    );
  });

  it("has no next step while waiting", () => {
    expect(nextOperationStep(input({ progress: 1 }))).toBeUndefined();
  });
});

describe("operationStepDone", () => {
  it("marks the steps before the next one", () => {
    const paused = input({ canApply: true, progress: 2 });
    expect(operationStepDone(1, paused)).toBe(true);
    expect(operationStepDone(2, paused)).toBe(true);
    expect(operationStepDone(3, paused)).toBe(false);
  });

  it("marks the confirmed progress while waiting", () => {
    const waiting = input({ progress: 1 });
    expect(operationStepDone(1, waiting)).toBe(true);
    expect(operationStepDone(2, waiting)).toBe(false);
  });
});

describe("outcomeProgress", () => {
  it("maps the result kinds", () => {
    expect(outcomeProgress("candidate")).toBe(1);
    expect(outcomeProgress("paused")).toBe(2);
    expect(outcomeProgress("applied")).toBe(3);
    expect(outcomeProgress("replay")).toBe(3);
    expect(outcomeProgress("failed")).toBe(0);
    expect(outcomeProgress(undefined)).toBe(0);
  });

  it("does not count an apply before quiescence is confirmed", () => {
    const applied = (quiescence: string, recoveryRequired: boolean) => ({
      outcome: { kind: "applied" },
      quiescence,
      recoveryRequired,
    });
    expect(outcomeProgress(applied("confirmed", false))).toBe(3);
    expect(outcomeProgress(applied("unknown", true))).toBe(2);
    expect(outcomeProgress(applied("confirmed", true))).toBe(2);
    expect(
      nextOperationStep(
        input({ progress: outcomeProgress(applied("unknown", true)) }),
      ),
    ).toBeUndefined();
  });
});
