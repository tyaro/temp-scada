import { describe, expect, it } from "vitest";
import {
  AlarmMirror,
  type AlarmConditionState,
  type AlarmSnapshot,
} from "./alarm-mirror";

const condition = (active: boolean): AlarmConditionState => ({
  active,
  occurrence: null,
  recurrence: 0,
  acked: true,
  timer: null,
  unavailable: null,
  reportedUnavailable: null,
  orderKey: null,
  occurredAtMs: null,
  observation: null,
});

const snapshot = (generation: number, seq: number): AlarmSnapshot => ({
  monitored: { projectId: "A" },
  applied: {
    projectId: "A",
    projectRevision: 1,
    appliedAtMs: 1,
    displays: {},
  },
  engine: {
    session: { id: `session-${generation}`, generation },
    seq,
    unavailable: null,
    conditions: { a: condition(true) },
  },
  status: "running",
  pendingConditionChanges: false,
  pendingDisplayChanges: false,
  pendingUnknown: false,
  historyWriteFailure: null,
  rereadFailure: null,
});

describe("alarm event reconciliation", () => {
  it("orders generations before session and sequence, then applies exact next changes", () => {
    const mirror = new AlarmMirror();
    mirror.acceptSnapshot(snapshot(5, 8));
    expect(
      mirror.acceptChange({
        session: { id: "old", generation: 4 },
        seq: 999,
        conditions: {},
        engineUnavailable: null,
      }),
    ).toBe("ignored");
    expect(
      mirror.acceptChange({
        session: { id: "new", generation: 6 },
        seq: 1,
        conditions: {},
        engineUnavailable: null,
      }),
    ).toBe("refresh");
    expect(
      mirror.acceptChange({
        session: { id: "wrong", generation: 5 },
        seq: 9,
        conditions: {},
        engineUnavailable: null,
      }),
    ).toBe("refresh");
    expect(
      mirror.acceptChange({
        session: { id: "session-5", generation: 5 },
        seq: 10,
        conditions: {},
        engineUnavailable: null,
      }),
    ).toBe("refresh");
    expect(
      mirror.acceptChange({
        session: { id: "session-5", generation: 5 },
        seq: 8,
        conditions: {},
        engineUnavailable: null,
      }),
    ).toBe("ignored");
    expect(
      mirror.acceptChange({
        session: { id: "session-5", generation: 5 },
        seq: 9,
        conditions: { a: null, b: condition(false) },
        engineUnavailable: "disconnected",
      }),
    ).toBe("applied");
    expect(mirror.current?.engine?.conditions).toEqual({
      b: condition(false),
    });
    expect(mirror.current?.engine?.unavailable).toBe("disconnected");
    expect(mirror.acceptSnapshot(snapshot(4, 500))).toBe(false);
    expect(mirror.acceptSnapshot(snapshot(5, 8))).toBe(false);
    expect(mirror.acceptSnapshot(snapshot(6, 1))).toBe(true);
  });

  it("requires a snapshot when stopped or no generation is available", () => {
    const mirror = new AlarmMirror();
    mirror.acceptSnapshot({
      monitored: null,
      applied: null,
      engine: null,
      status: "notApplied",
      pendingConditionChanges: false,
      pendingDisplayChanges: false,
      pendingUnknown: false,
      historyWriteFailure: null,
      rereadFailure: null,
    });
    expect(
      mirror.acceptChange({
        session: { id: "s", generation: 1 },
        seq: 1,
        conditions: {},
        engineUnavailable: null,
      }),
    ).toBe("refresh");
  });

  it("does not revive a stopped engine from an earlier generation", () => {
    const mirror = new AlarmMirror();
    mirror.acceptSnapshot(snapshot(5, 8));
    const stopped = { ...snapshot(5, 8), engine: null, status: "noConditions" };
    expect(mirror.acceptSnapshot(stopped)).toBe(true);
    expect(mirror.acceptSnapshot(snapshot(5, 9))).toBe(false);
    expect(mirror.current?.status).toBe("noConditions");
    expect(mirror.acceptSnapshot(snapshot(6, 1))).toBe(true);
  });
});
