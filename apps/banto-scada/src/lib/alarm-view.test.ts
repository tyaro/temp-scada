import { describe, expect, it } from "vitest";
import type { AlarmConditionState, AlarmSnapshot } from "./alarm-mirror";
import {
  alarmConditionView,
  alarmViewText,
  conditionDisplay,
} from "./alarm-view";

const PROJECT = "0199f200-0000-7000-8000-000000000001";
const ID = "alarm:hh";

const condition = (
  patch: Partial<AlarmConditionState> = {},
): AlarmConditionState => ({
  active: false,
  occurrence: null,
  recurrence: 0,
  acked: true,
  timer: null,
  unavailable: null,
  reportedUnavailable: null,
  orderKey: null,
  occurredAtMs: null,
  observation: null,
  ...patch,
});

function snapshot(
  conditions: Record<string, AlarmConditionState> = { [ID]: condition() },
  patch: Partial<AlarmSnapshot> = {},
  engineUnavailable: string | null = null,
): AlarmSnapshot {
  return {
    monitored: { projectId: PROJECT },
    applied: {
      projectId: PROJECT,
      projectRevision: 1,
      appliedAtMs: 1,
      displays: {
        [ID]: {
          name: "温度",
          message: "温度 異常高",
          severity: "medium",
          limitLabel: "HH",
        },
      },
    },
    engine: {
      session: { id: "s", generation: 1 },
      seq: 1,
      unavailable: engineUnavailable,
      conditions,
    },
    status: "running",
    pendingConditionChanges: false,
    pendingDisplayChanges: false,
    pendingUnknown: false,
    historyWriteFailure: null,
    rereadFailure: null,
    ...patch,
  };
}
const view = (value: AlarmSnapshot | null, id = ID, project = PROJECT) =>
  alarmConditionView(value, project, id);

describe("conditionDisplay follows ConditionState::display()", () => {
  it.each([
    [{ active: true, acked: false }, "activeUnacked"],
    [{ active: true, acked: true }, "activeAcked"],
    [{ active: false, acked: false }, "returnedUnacked"],
    [{ active: false, acked: true }, "normal"],
    [
      {
        active: false,
        acked: true,
        timer: { kind: "onDelay" as const, dueMs: 1 },
      },
      "pending",
    ],
    [
      {
        active: false,
        acked: true,
        timer: { kind: "offDelay" as const, dueMs: 1 },
      },
      "normal",
    ],
    [
      {
        active: false,
        acked: false,
        timer: { kind: "onDelay" as const, dueMs: 1 },
      },
      "returnedUnacked",
    ],
  ])("%j → %s", (patch, expected) => {
    expect(conditionDisplay(condition(patch))).toBe(expected);
  });
});

describe("alarmConditionView", () => {
  it("is unknown with a reason whenever the Engine cannot answer", () => {
    expect(view(null)).toMatchObject({
      state: "unknown",
      reason: "noSnapshot",
    });
    expect(view(snapshot(undefined, { status: "stopped" }))).toMatchObject({
      state: "unknown",
      reason: "notRunning",
    });
    expect(view(snapshot(undefined, { engine: null }))).toMatchObject({
      state: "unknown",
      reason: "notRunning",
    });
    expect(view(snapshot(undefined, {}, "disconnected"))).toMatchObject({
      state: "unknown",
      reason: "engineUnavailable",
    });
    expect(view(snapshot(), ID, "other")).toMatchObject({
      state: "unknown",
      reason: "otherProject",
    });
    expect(
      view(
        snapshot(undefined, {
          applied: { ...snapshot().applied!, projectId: "other" },
        }),
      ),
    ).toMatchObject({ state: "unknown", reason: "otherProject" });
    expect(view(snapshot(), "new:h")).toMatchObject({
      state: "unknown",
      reason: "notApplied",
    });
    // 継承したプロパティを condition と取り違えない。
    expect(view(snapshot(), "toString")).toMatchObject({
      state: "unknown",
      reason: "notApplied",
    });
  });
  it("treats pending as normal and carries the applied severity", () => {
    expect(view(snapshot())).toEqual({
      state: "normal",
      unavailableMark: false,
      severity: "medium",
    });
    expect(
      view(
        snapshot({
          [ID]: condition({ timer: { kind: "onDelay", dueMs: 9 } }),
        }),
      ).state,
    ).toBe("normal");
  });
  it("shows each active and returned state", () => {
    expect(
      view(snapshot({ [ID]: condition({ active: true, acked: false }) })),
    ).toEqual({
      state: "activeUnacked",
      unavailableMark: false,
      severity: "medium",
    });
    expect(
      view(snapshot({ [ID]: condition({ active: true, acked: true }) })).state,
    ).toBe("activeAcked");
    expect(
      view(snapshot({ [ID]: condition({ active: false, acked: false }) }))
        .state,
    ).toBe("returnedUnacked");
  });
  it("marks unavailable on normal and adds ? to an active condition", () => {
    expect(
      view(snapshot({ [ID]: condition({ unavailable: "stale" }) })).state,
    ).toBe("unavailable");
    expect(
      view(
        snapshot({
          [ID]: condition({ unavailable: "initialValue", timer: null }),
        }),
      ).state,
    ).toBe("unavailable");
    expect(
      view(
        snapshot({
          [ID]: condition({ active: true, acked: true, unavailable: "bad" }),
        }),
      ),
    ).toEqual({
      state: "activeAcked",
      unavailableMark: true,
      severity: "medium",
    });
    expect(
      view(
        snapshot({
          [ID]: condition({ active: false, acked: false, unavailable: "bad" }),
        }),
      ),
    ).toMatchObject({ state: "returnedUnacked", unavailableMark: false });
  });
  it("drops an unknown severity", () => {
    const value = snapshot();
    const odd = {
      ...value,
      applied: {
        ...value.applied!,
        displays: { [ID]: { ...value.applied!.displays[ID], severity: "x" } },
      },
    };
    expect(view(odd)).toEqual({ state: "normal", unavailableMark: false });
  });
  it("words each state for assistive technology", () => {
    expect(alarmViewText(view(null))).toBe(
      "不明（警報の状態を受け取っていません）",
    );
    expect(
      alarmViewText(
        view(snapshot({ [ID]: condition({ active: true, acked: false }) })),
      ),
    ).toBe("未確認（発生中）");
    expect(
      alarmViewText(
        view(
          snapshot({
            [ID]: condition({ active: true, acked: true, unavailable: "bad" }),
          }),
        ),
      ),
    ).toBe("発生中・評価不能");
  });
});
