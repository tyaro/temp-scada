import { describe, expect, it } from "vitest";
import type { AlarmSnapshot } from "../alarm-mirror";
import { alarmHealthy, alarmStatusLabel } from "./alarm-status";

const base: AlarmSnapshot = {
  monitored: { projectId: "project-a" },
  applied: null,
  engine: null,
  status: "running",
  pendingConditionChanges: false,
  pendingDisplayChanges: false,
  pendingUnknown: false,
  historyWriteFailure: null,
  rereadFailure: null,
};

describe("上端の警報の状態", () => {
  it("取得前・取得の失敗・監視できない理由を出し分ける", () => {
    expect(alarmStatusLabel(null, null, null, "project-a")).toBe(
      "警報: 確認中",
    );
    expect(alarmStatusLabel(null, "offline", null, "project-a")).toBe(
      "警報: 状態を取得できません",
    );
    expect(alarmStatusLabel(null, null, "noDataDir", "project-a")).toBe(
      "警報: 保存先がなく監視できません",
    );
    expect(
      alarmStatusLabel(
        { ...base, status: "notApplied" },
        null,
        null,
        "project-a",
      ),
    ).toBe("警報: 未適用");
  });

  it("監視中の Project と表示中の Project を比べる", () => {
    expect(alarmStatusLabel(base, null, null, "project-a")).toBe(
      "警報: 監視中",
    );
    expect(alarmHealthy(base, "project-a")).toBe(true);
    expect(alarmStatusLabel(base, null, null, "project-b")).toBe(
      "警報: 別のProjectを監視中",
    );
    expect(alarmHealthy(base, "project-b")).toBe(false);
  });

  it("履歴の書込み失敗と読み直しの失敗は並べて出す", () => {
    const failing: AlarmSnapshot = {
      ...base,
      historyWriteFailure: { sinceWallMs: 1, unrecordedEvents: 3 },
      rereadFailure: { failures: 2 } as AlarmSnapshot["rereadFailure"],
    };
    expect(alarmStatusLabel(failing, null, null, "project-a")).toBe(
      "警報: 履歴に書けません（未記録 3 件）・値の読み直しに失敗（2 回）",
    );
    expect(alarmHealthy(failing, "project-a")).toBe(false);
  });

  it("購読を張れない間は snapshot が取れても監視中にしない", () => {
    expect(alarmStatusLabel(base, null, null, "project-a", "offline")).toBe(
      "警報: 変化を受け取れません",
    );
    expect(alarmHealthy(base, "project-a", "offline")).toBe(false);
    expect(alarmStatusLabel(null, null, null, "project-a", "offline")).toBe(
      "警報: 変化を受け取れません",
    );
    // snapshot を取れない方を先に出す。
    expect(alarmStatusLabel(null, "busy", null, "project-a", "offline")).toBe(
      "警報: 状態を取得できません",
    );
    // 購読の失敗の理由が「この端末では使えない」なら、それを出す。
    expect(
      alarmStatusLabel(null, null, null, "project-a", "terminalUnavailable"),
    ).toBe("警報: この端末ではEngineを利用できません");
    expect(alarmStatusLabel(base, null, null, "project-a", null)).toBe(
      "警報: 監視中",
    );
  });
});
