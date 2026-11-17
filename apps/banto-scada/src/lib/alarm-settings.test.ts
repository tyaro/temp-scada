import { describe, expect, it } from "vitest";
import {
  ALARM_SETTINGS_DEFAULTS,
  ALARM_SOUND_FALLBACK_NOTICE,
  alarmRetentionStatusText,
  alarmSettingsEntryReason,
  alarmSettingsForm,
  alarmSettingsReasonText,
  alarmSoundFallbackNotice,
  alarmSoundLabel,
  isAlarmSettingsPermissionRefusal,
  parseSettingInteger,
  validateAlarmSettingsForm,
  type AlarmSettingsForm,
} from "./alarm-settings";

// 警報の端末設定の画面の純粋な関数。仕様: docs/design/runtime/alarm-terminal-settings.md §2・§7
const defaults = () => alarmSettingsForm(ALARM_SETTINGS_DEFAULTS);
const errorsOf = (patch: Partial<AlarmSettingsForm>) => {
  const result = validateAlarmSettingsForm({ ...defaults(), ...patch });
  return result.ok ? {} : result.errors;
};

describe("parseSettingInteger", () => {
  it("半角・全角の数字とカンマ区切りを整数にする", () => {
    expect(parseSettingInteger(" 365 ")).toBe(365);
    expect(parseSettingInteger("１０")).toBe(10);
    expect(parseSettingInteger("1,000,000")).toBe(1_000_000);
  });
  it("整数でないものは null", () => {
    for (const text of ["", "1.5", "-1", "1e3", "abc", "9".repeat(20)])
      expect(parseSettingInteger(text)).toBeNull();
  });
});

describe("validateAlarmSettingsForm", () => {
  it("既定値をそのまま保存値にする", () => {
    expect(validateAlarmSettingsForm(defaults())).toEqual({
      ok: true,
      settings: ALARM_SETTINGS_DEFAULTS,
    });
  });

  it("種類を切り替えても使わない方の値を残す", () => {
    const result = validateAlarmSettingsForm({
      ...defaults(),
      kind: "count",
      count: "20000",
    });
    expect(result).toEqual({
      ok: true,
      settings: {
        ...ALARM_SETTINGS_DEFAULTS,
        retention: { kind: "count", days: 365, count: 20_000 },
      },
    });
  });

  it("保持の日数・件数の範囲の端", () => {
    expect(errorsOf({ days: "1" })).toEqual({});
    expect(errorsOf({ days: "3650" })).toEqual({});
    expect(errorsOf({ days: "0" }).days).toMatch("1〜3,650 日");
    expect(errorsOf({ days: "3651" }).days).toBeDefined();
    expect(errorsOf({ count: "10000" })).toEqual({});
    expect(errorsOf({ count: "9999" }).count).toMatch("10,000〜10,000,000 件");
    expect(errorsOf({ count: "10000001" }).count).toBeDefined();
  });

  it("読み直しの範囲と相互の関係（期限 ≤ 周期、連続失敗の期限 ≥ 周期の 2 倍）", () => {
    expect(errorsOf({ intervalSec: "1" }).intervalSec).toMatch("2〜300 秒");
    expect(errorsOf({ intervalSec: "301" }).intervalSec).toBeDefined();
    expect(errorsOf({ timeoutSec: "10" })).toEqual({});
    expect(errorsOf({ timeoutSec: "11" }).timeoutSec).toMatch("1〜10 秒");
    expect(errorsOf({ timeoutSec: "0" }).timeoutSec).toBeDefined();
    expect(errorsOf({ failureLimitSec: "20" })).toEqual({});
    expect(errorsOf({ failureLimitSec: "19" }).failureLimitSec).toMatch(
      "20〜3600 秒",
    );
    expect(errorsOf({ failureLimitSec: "3601" }).failureLimitSec).toBeDefined();
    expect(
      errorsOf({ reconnectFailures: "0" }).reconnectFailures,
    ).toBeDefined();
    expect(
      errorsOf({ reconnectFailures: "11" }).reconnectFailures,
    ).toBeDefined();
    // 周期を縮めると、既定の期限 5 秒が関係を外れる。
    expect(errorsOf({ intervalSec: "4" })).toEqual({
      timeoutSec: "1〜4 秒（周期以下）で入れてください。",
    });
  });

  it("周期が誤っているときは関係でなく値だけを見る", () => {
    expect(errorsOf({ intervalSec: "x", timeoutSec: "100" })).toEqual({
      intervalSec: "整数を入れてください。",
    });
    expect(
      errorsOf({ intervalSec: "x", failureLimitSec: "2" }).failureLimitSec,
    ).toBeDefined();
  });
});

describe("文言", () => {
  it("host の理由を文字にする", () => {
    expect(alarmSettingsReasonText("invalidSound:tooLong")).toBe(
      "この音は使えません（音が 5 秒を超えています）。",
    );
    expect(alarmSettingsReasonText("invalidSound:other")).toMatch(
      "invalidSound:other",
    );
    expect(alarmSettingsReasonText("forbidden")).toBe(
      "端末設定の変更は Admin だけが行えます。",
    );
    expect(alarmSettingsReasonText("buzzerRinging")).toMatch("鳴っている間");
    expect(alarmSettingsReasonText("terminalUnavailable")).toMatch(
      "設定ファイルを開けない",
    );
    expect(alarmSettingsReasonText("mystery")).toMatch("（mystery）");
  });

  it("権限による拒否だけを読むだけにする", () => {
    expect(isAlarmSettingsPermissionRefusal("unauthorized")).toBe(true);
    expect(isAlarmSettingsPermissionRefusal("auth_phase_unavailable")).toBe(
      true,
    );
    expect(isAlarmSettingsPermissionRefusal("invalidSettings")).toBe(false);
    expect(isAlarmSettingsPermissionRefusal("terminalUnavailable")).toBe(false);
  });

  it("音の表示と代替の知らせ", () => {
    expect(alarmSoundLabel({ kind: "default" })).toBe("既定のビープ");
    expect(
      alarmSoundLabel({ kind: "custom", name: "a.wav", size: 1, hash: "" }),
    ).toBe("取り込んだファイル「a.wav」");
    expect(alarmSoundFallbackNotice(undefined)).toBeNull();
    expect(
      alarmSoundFallbackNotice({ kind: "custom", fallback: null }),
    ).toBeNull();
    expect(
      alarmSoundFallbackNotice({ kind: "custom", fallback: "hashMismatch" }),
    ).toBe(ALARM_SOUND_FALLBACK_NOTICE);
  });

  it("保持の現況", () => {
    expect(alarmRetentionStatusText(null)).toMatch("現況を示せません");
    expect(
      alarmRetentionStatusText({ eventCount: 1234, oldestAtMs: null }),
    ).toBe("いまのイベント 1,234 件（消す対象のイベントはありません）");
    expect(
      alarmRetentionStatusText(
        { eventCount: 2, oldestAtMs: Date.UTC(2026, 0, 2, 3, 4, 5) },
        "Asia/Tokyo",
      ),
    ).toBe("いまのイベント 2 件・いちばん古いイベント 2026/1/2 12:04:05");
  });

  it("host が無ければ入口を押せない理由を返す", () => {
    expect(alarmSettingsEntryReason(undefined)).toMatch("デスクトップ版");
    expect(alarmSettingsEntryReason({})).toMatch("デスクトップ版");
    expect(
      alarmSettingsEntryReason({ alarmSettings: async () => ({}) }),
    ).toBeNull();
  });
});
