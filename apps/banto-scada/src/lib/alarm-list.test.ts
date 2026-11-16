import { describe, expect, it } from "vitest";
import type { AlarmConditionState, AlarmSnapshot } from "./alarm-mirror";
import {
  alarmAckRefusalText,
  alarmAckResultText,
  alarmAckTargets,
  alarmHistoryQuery,
  alarmHistoryRow,
  alarmListCurrent,
  ALARM_HISTORY_PAGE,
} from "./alarm-list";

const context = { feed: true, projectId: "p", projectRevision: 3 };

function condition(
  overrides: Partial<AlarmConditionState> & { seq?: number } = {},
): AlarmConditionState {
  const { seq = 0, ...rest } = overrides;
  const base = {
    active: false,
    acked: true,
    unavailable: null,
    ...rest,
  };
  const live = base.active || !base.acked;
  return {
    occurrence: live ? `occ-${seq}` : null,
    recurrence: 0,
    timer: null,
    reportedUnavailable: base.unavailable,
    orderKey: live ? { generation: 1, seq } : null,
    occurredAtMs: live ? Date.UTC(2026, 10, 17, 0, 0, seq) : null,
    observation: null,
    ...base,
  } as AlarmConditionState;
}

function snapshot(
  conditions: Record<string, AlarmConditionState>,
  overrides: Partial<AlarmSnapshot> & { engineUnavailable?: string } = {},
): AlarmSnapshot {
  const { engineUnavailable = null, ...rest } = overrides;
  return {
    monitored: { projectId: "p" },
    applied: {
      projectId: "p",
      projectRevision: 3,
      appliedAtMs: 1,
      displays: {
        "t:hh": {
          name: "温度 HH",
          message: "異常高",
          severity: "high",
          limitLabel: "HH",
        },
        "t:h": {
          name: "温度 H",
          message: "高",
          severity: "medium",
          limitLabel: "H",
        },
        pump: {
          name: "ポンプ",
          message: "停止",
          severity: "low",
          limitLabel: null,
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
    historyWriteFailure: null,
    rereadFailure: null,
    ...rest,
  };
}

describe("alarmListCurrent", () => {
  it("lists non-Normal and unavailable conditions, unacked first, then severity and newest", () => {
    const view = alarmListCurrent(
      snapshot({
        "t:hh": condition({ active: true, acked: true, seq: 5 }),
        "t:h": condition({ active: false, acked: false, seq: 2 }),
        pump: condition({ active: true, acked: false, seq: 1 }),
        quiet: condition(),
        stale: condition({ unavailable: "stale" }),
      }),
      context,
    );
    expect(view.notices).toEqual([]);
    expect(view.engineRow).toBeNull();
    expect(view.canAck).toBe(true);
    expect(
      view.rows.map((row) => [row.conditionId, row.stateText, row.unacked]),
    ).toEqual([
      ["t:h", "復帰・未確認", true],
      ["pump", "未確認（発生中）", true],
      ["t:hh", "発生中", false],
      ["stale", "正常", false],
    ]);
    expect(view.rows[3]).toMatchObject({
      occurrence: null,
      unavailableText: "更新停止",
      severityText: "低",
    });
    expect(view.rows[0]).toMatchObject({
      name: "温度 H",
      limitLabel: "H",
      severityText: "中",
    });
  });

  it("orders by newest within the same severity", () => {
    const view = alarmListCurrent(
      snapshot({
        a: condition({ active: true, acked: false, seq: 1 }),
        b: condition({ active: true, acked: false, seq: 9 }),
      }),
      context,
    );
    expect(view.rows.map((row) => row.conditionId)).toEqual(["b", "a"]);
  });

  it("filters to unavailable conditions, keeping an active one with a reason", () => {
    const view = alarmListCurrent(
      snapshot({
        "t:hh": condition({ active: true, acked: false, unavailable: "bad" }),
        pump: condition({ active: true, acked: false }),
        stale: condition({ unavailable: "stale" }),
      }),
      context,
      "unavailable",
    );
    expect(view.rows.map((row) => row.conditionId)).toEqual(["t:hh", "stale"]);
    expect(view.rows[0].unavailableText).toBe("不良");
  });

  it("puts the Engine-level reason first and folds Normal unavailable conditions into it", () => {
    const view = alarmListCurrent(
      snapshot(
        {
          pump: condition({ active: true, acked: false }),
          stale: condition({ unavailable: "stale" }),
        },
        { engineUnavailable: "disconnected" },
      ),
      context,
    );
    expect(view.engineRow).toBe("監視できていません（未接続）");
    expect(view.rows.map((row) => row.conditionId)).toEqual(["pump"]);
  });

  it("explains a missing feed, a read error, no snapshot and a stopped Engine", () => {
    expect(
      alarmListCurrent(null, { ...context, feed: false }).notices[0],
    ).toMatch(/ブラウザ版/);
    expect(
      alarmListCurrent(null, { ...context, readError: "boom" }).notices,
    ).toEqual(["警報の状態を取得できません（boom）"]);
    expect(alarmListCurrent(null, context).notices).toEqual([
      "警報の状態を受け取っていません",
    ]);
    const stopped = alarmListCurrent(
      snapshot({}, { status: "noHub", engine: null }),
      context,
    );
    expect(stopped).toMatchObject({
      notices: ["警報の Engine が動いていません（Hub未設定）"],
      rows: [],
      canAck: false,
    });
  });

  it("refuses ACK while history cannot be written and shows revision and project differences", () => {
    const failing = alarmListCurrent(
      snapshot(
        {},
        { historyWriteFailure: { sinceWallMs: 1, unrecordedEvents: 4 } },
      ),
      { ...context, projectRevision: 4 },
    );
    expect(failing.canAck).toBe(false);
    expect(failing.notices).toEqual([
      expect.stringMatching(/^履歴に書けません（未記録 4 件）/),
      expect.stringMatching(
        /編集中の Project（revision 4）と適用中の定義（revision 3）が違います/,
      ),
    ]);
    expect(
      alarmListCurrent(snapshot({}), { ...context, projectId: "other" })
        .notices,
    ).toEqual([expect.stringMatching(/^別の Project を監視中です/)]);
  });
});

describe("alarmAckTargets", () => {
  const rows = alarmListCurrent(
    snapshot({
      "t:hh": condition({ active: true, acked: true, seq: 5 }),
      "t:h": condition({ active: false, acked: false, seq: 2 }),
      pump: condition({ active: true, acked: false, seq: 1, recurrence: 3 }),
      stale: condition({ unavailable: "stale" }),
    }),
    context,
  ).rows;

  it("sends only the unacked rounds the screen shows", () => {
    expect(alarmAckTargets(rows)).toEqual([
      { conditionId: "t:h", occurrence: "occ-2", recurrence: 0 },
      { conditionId: "pump", occurrence: "occ-1", recurrence: 3 },
    ]);
  });

  it("narrows to the selected rows, skipping acked and Normal ones", () => {
    expect(alarmAckTargets(rows, new Set(["pump", "t:hh", "stale"]))).toEqual([
      { conditionId: "pump", occurrence: "occ-1", recurrence: 3 },
    ]);
  });
});

describe("ACK texts", () => {
  it("names every result", () => {
    expect(
      [
        { kind: "accepted" },
        { kind: "otherOccurrence" },
        { kind: "alreadyAcked" },
        { kind: "notFound" },
        { kind: "historyUnavailable" },
        { kind: "engineStopped", reason: "stopped" },
        { kind: "failed", reason: "x" },
      ].map((result) =>
        alarmAckResultText(result as Parameters<typeof alarmAckResultText>[0]),
      ),
    ).toEqual([
      "受理",
      "別の回（最新の回を表示しています）",
      "確認済み",
      "無い（適用中の定義にありません）",
      "履歴に書けない",
      "Engine 停止中（停止）",
      "失敗（x）",
    ]);
  });

  it("explains a refused request", () => {
    expect(alarmAckRefusalText("forbidden")).toBe(
      "ACK は Admin だけが行えます。",
    );
    expect(alarmAckRefusalText("zzz")).toBe("ACK できませんでした（zzz）。");
  });
});

describe("history", () => {
  it("shows the judged limit, value and source timestamp", () => {
    const row = alarmHistoryRow({
      seq: 7,
      sessionId: "s",
      event: {
        atMs: new Date(2026, 10, 17, 9, 0, 5).getTime(),
        conditionId: "t:hh",
        kind: "occurred",
        detail: {
          occurrence: "o",
          recurrence: 0,
          sound: "continuous",
          judgement: {
            limit: 120,
            value: 125.5,
            sourceTimestampMs: new Date(2026, 10, 17, 9, 0, 4).getTime(),
          },
        },
      },
      display: {
        name: "温度 HH",
        message: "異常高",
        severity: "high",
        limitLabel: "HH",
      },
    });
    expect(row).toEqual({
      seq: 7,
      time: "11/17 09:00:05",
      kind: "occurred",
      kindText: "発生",
      name: "温度 HH",
      message: "異常高",
      limitLabel: "HH",
      limit: "120",
      value: "125.5",
      sourceTime: "11/17 09:00:04",
      note: "",
    });
  });

  it("notes the user, reasons and unknown kinds", () => {
    const base = { seq: 1, sessionId: "s", display: null };
    expect(
      alarmHistoryRow({
        ...base,
        event: {
          atMs: 0,
          conditionId: "c",
          kind: "acked",
          detail: { user: "admin" },
        },
      }).note,
    ).toBe("確認者 admin");
    expect(
      alarmHistoryRow({
        ...base,
        event: {
          atMs: 0,
          conditionId: "c",
          kind: "ended",
          detail: { reason: "definitionDeleted", unacked: true },
        },
      }),
    ).toMatchObject({ name: "c", note: "定義の削除・未確認のまま" });
    expect(
      alarmHistoryRow({
        ...base,
        event: { atMs: 0, conditionId: null, kind: "mystery", detail: {} },
      }),
    ).toMatchObject({ kindText: "mystery", name: "" });
  });

  it("builds the query from local times, with a cursor", () => {
    expect(
      alarmHistoryQuery(
        { from: "2026-11-17T09:00", to: "", kind: "acked" },
        42,
      ),
    ).toEqual({
      query: {
        beforeSeq: 42,
        fromMs: new Date(2026, 10, 17, 9, 0).getTime(),
        toMs: null,
        kind: "acked",
        limit: ALARM_HISTORY_PAGE,
      },
    });
    expect(
      alarmHistoryQuery({
        from: "2026-11-17T10:00",
        to: "2026-11-17T09:00",
        kind: "",
      }),
    ).toEqual({ issue: "開始は終了より前にしてください。" });
  });
});
