import type { AlarmBuzzerSound } from "./alarm-mirror";

/**
 * 警報の端末設定（docs/design/runtime/alarm-terminal-settings.md §2・§6・§7）の画面側の
 * 純粋な関数。値の形は host（`crates/scada-host/src/alarm_terminal/alarm_settings.rs`・
 * `alarm_sound.rs`、`alarm_service.rs` の `AlarmSettingsView`）の serde（camelCase）に合わせる。
 * 範囲の検査は host が正で、画面は同じ規則で先に示すだけ。
 */

export type AlarmRetentionKind = "days" | "count";

export interface AlarmSettings {
  readonly retention: {
    readonly kind: AlarmRetentionKind;
    readonly days: number;
    readonly count: number;
  };
  readonly reread: {
    readonly intervalSec: number;
    readonly timeoutSec: number;
    readonly failureLimitSec: number;
    readonly reconnectFailures: number;
  };
}

export type AlarmSoundSetting =
  | { readonly kind: "default" }
  | {
      readonly kind: "custom";
      readonly name: string;
      readonly size: number;
      readonly hash: string;
    };

export type AlarmSoundFallback = NonNullable<AlarmBuzzerSound["fallback"]>;

export type AlarmSettingsWarning =
  "retentionKind" | "retentionDays" | "retentionCount" | "reread" | "sound";

/** `alarm_settings_get` などの戻り値（`AlarmSettingsView`）。 */
export interface AlarmSettingsView extends AlarmSettings {
  readonly sound: AlarmSoundSetting;
  readonly soundFallback: AlarmSoundFallback | null;
  readonly warnings: readonly AlarmSettingsWarning[];
  /** 監視中の Project が無い・DB を読めないときは null。 */
  readonly retentionStatus: {
    readonly eventCount: number;
    readonly oldestAtMs: number | null;
  } | null;
}

/** 既定値（§2）。 */
export const ALARM_SETTINGS_DEFAULTS: AlarmSettings = {
  retention: { kind: "days", days: 365, count: 1_000_000 },
  reread: {
    intervalSec: 10,
    timeoutSec: 5,
    failureLimitSec: 30,
    reconnectFailures: 3,
  },
};

/** 範囲（§2）。期限・連続失敗の期限は周期との関係も見る。 */
export const ALARM_SETTINGS_RANGES = {
  days: [1, 3650],
  count: [10_000, 10_000_000],
  intervalSec: [2, 300],
  failureLimitMaxSec: 3600,
  reconnectFailures: [1, 10],
} as const;

/** 画面の入力欄（文字のまま持つ）。 */
export interface AlarmSettingsForm {
  kind: AlarmRetentionKind;
  days: string;
  count: string;
  intervalSec: string;
  timeoutSec: string;
  failureLimitSec: string;
  reconnectFailures: string;
}

export type AlarmSettingsField = Exclude<keyof AlarmSettingsForm, "kind">;

export function alarmSettingsForm(settings: AlarmSettings): AlarmSettingsForm {
  return {
    kind: settings.retention.kind,
    days: String(settings.retention.days),
    count: String(settings.retention.count),
    intervalSec: String(settings.reread.intervalSec),
    timeoutSec: String(settings.reread.timeoutSec),
    failureLimitSec: String(settings.reread.failureLimitSec),
    reconnectFailures: String(settings.reread.reconnectFailures),
  };
}

/** 半角・全角の数字だけの整数（区切りのカンマは許す）。それ以外は null。 */
export function parseSettingInteger(text: string): number | null {
  const normalized = text
    .trim()
    .replace(/[０-９]/g, (digit) =>
      String.fromCharCode(digit.charCodeAt(0) - 0xfee0),
    )
    .replace(/[,，]/g, "");
  if (!/^\d+$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isSafeInteger(value) ? value : null;
}

function range(
  value: number | null,
  min: number,
  max: number,
  unit: string,
): string | null {
  if (value === null) return "整数を入れてください。";
  if (value < min || value > max)
    return `${min.toLocaleString("ja-JP")}〜${max.toLocaleString("ja-JP")}${unit}で入れてください。`;
  return null;
}

export type AlarmSettingsValidation =
  | { readonly ok: true; readonly settings: AlarmSettings }
  | {
      readonly ok: false;
      readonly errors: Partial<Record<AlarmSettingsField, string>>;
    };

/**
 * 入力欄を保存値にする（§2 の範囲と相互の関係）。種類で使わない方の値も残すので、
 * 日数・件数はどちらも検査する。期限・連続失敗の期限は周期が正しいときだけ関係を見る。
 */
export function validateAlarmSettingsForm(
  form: AlarmSettingsForm,
): AlarmSettingsValidation {
  const r = ALARM_SETTINGS_RANGES;
  const days = parseSettingInteger(form.days);
  const count = parseSettingInteger(form.count);
  const intervalSec = parseSettingInteger(form.intervalSec);
  const timeoutSec = parseSettingInteger(form.timeoutSec);
  const failureLimitSec = parseSettingInteger(form.failureLimitSec);
  const reconnectFailures = parseSettingInteger(form.reconnectFailures);
  const errors: Partial<Record<AlarmSettingsField, string>> = {};
  const set = (field: AlarmSettingsField, message: string | null) => {
    if (message) errors[field] = message;
  };
  set("days", range(days, r.days[0], r.days[1], " 日"));
  set("count", range(count, r.count[0], r.count[1], " 件"));
  const intervalError = range(
    intervalSec,
    r.intervalSec[0],
    r.intervalSec[1],
    " 秒",
  );
  set("intervalSec", intervalError);
  const interval = intervalError ? null : intervalSec;
  if (timeoutSec === null) set("timeoutSec", "整数を入れてください。");
  else if (interval === null) {
    if (timeoutSec < 1) set("timeoutSec", "1 秒以上で入れてください。");
  } else
    set(
      "timeoutSec",
      timeoutSec < 1 || timeoutSec > interval
        ? `1〜${interval} 秒（周期以下）で入れてください。`
        : null,
    );
  if (failureLimitSec === null)
    set("failureLimitSec", "整数を入れてください。");
  else {
    const min = interval === null ? 4 : interval * 2;
    set(
      "failureLimitSec",
      failureLimitSec < min || failureLimitSec > r.failureLimitMaxSec
        ? interval === null
          ? `${r.failureLimitMaxSec} 秒以下（周期の 2 倍以上）で入れてください。`
          : `${min}〜${r.failureLimitMaxSec} 秒（周期の 2 倍以上）で入れてください。`
        : null,
    );
  }
  set(
    "reconnectFailures",
    range(
      reconnectFailures,
      r.reconnectFailures[0],
      r.reconnectFailures[1],
      " 回",
    ),
  );
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    settings: {
      retention: { kind: form.kind, days: days!, count: count! },
      reread: {
        intervalSec: intervalSec!,
        timeoutSec: timeoutSec!,
        failureLimitSec: failureLimitSec!,
        reconnectFailures: reconnectFailures!,
      },
    },
  };
}

/** 変更が拒まれた理由のうち、権限（認証）によるもの。以後は読むだけにする。 */
export function isAlarmSettingsPermissionRefusal(reason: string): boolean {
  return [
    "unauthorized",
    "forbidden",
    "auth_unavailable",
    "auth_failed",
    "auth_phase_unavailable",
  ].includes(reason);
}

const WAV_REJECTIONS: Record<string, string> = {
  tooLarge: "ファイルが 1 MB を超えています",
  notWav: "WAV ファイルではありません",
  outOfBounds: "ファイルの中身が壊れています",
  noFormat: "音の形式が書かれていません",
  extensible: "拡張形式の WAV には対応していません",
  compressed: "圧縮された WAV には対応していません（リニア PCM のみ）",
  unsupportedBits: "対応していないビット数です（8・16 ビットのみ）",
  unsupportedChannels:
    "対応していないチャンネル数です（モノラル・ステレオのみ）",
  malformed: "音の形式の値が食い違っています",
  noData: "音のデータがありません",
  tooLong: "音が 5 秒を超えています",
};

/** host の拒否の理由（`src-tauri/src/alarm.rs` の `reason` / `refusal`）の文字。 */
export function alarmSettingsReasonText(reason: string): string {
  if (reason.startsWith("invalidSound:")) {
    const detail = WAV_REJECTIONS[reason.slice("invalidSound:".length)];
    return `この音は使えません（${detail ?? reason}）。`;
  }
  switch (reason) {
    case "unauthorized":
      return "端末設定の変更には Admin でのログインが必要です。";
    case "forbidden":
      return "端末設定の変更は Admin だけが行えます。";
    case "auth_unavailable":
    case "auth_failed":
      return "認証を確かめられないため端末設定を変更できません。";
    case "auth_phase_unavailable":
      return "認証の切替中のため端末設定を変更できません。";
    case "invalidSettings":
      return "値が範囲外のため保存しませんでした。";
    case "buzzerRinging":
      return "ブザーが鳴っている間は試しに鳴らせません。";
    case "soundUnreadable":
      return "選んだファイルを読めませんでした。";
    case "terminalUnavailable":
      return "この端末の設定ファイルを開けないため、端末設定を使えません。";
    case "alarmUnavailable":
    case "noDataDir":
      return "この端末では警報を利用できないため、端末設定を使えません。";
    default:
      return `端末設定を扱えませんでした（${reason}）。`;
  }
}

/** いまの音の表示（既定のビープか、取り込んだファイルの名前）。 */
export function alarmSoundLabel(sound: AlarmSoundSetting): string {
  return sound.kind === "custom"
    ? `取り込んだファイル「${sound.name}」`
    : "既定のビープ";
}

export function alarmSoundFallbackText(fallback: AlarmSoundFallback): string {
  switch (fallback) {
    case "fileUnreadable":
      return "取り込んだファイルが無いか読めない";
    case "hashMismatch":
      return "取り込んだファイルが設定の内容と違う";
    case "invalidWav":
      return "取り込んだファイルが WAV の検査に通らない";
  }
}

/** §5: 代替のときにヘッダーと一覧の窓に示す文字。 */
export const ALARM_SOUND_FALLBACK_NOTICE =
  "設定の音を鳴らせないため、既定の音で鳴らしています";

export function alarmSoundFallbackNotice(
  sound: AlarmBuzzerSound | null | undefined,
): string | null {
  return sound?.fallback ? ALARM_SOUND_FALLBACK_NOTICE : null;
}

/** 読込み時に既定値へ戻した組（§2）の文字。 */
export function alarmSettingsWarningText(
  warning: AlarmSettingsWarning,
): string {
  switch (warning) {
    case "retentionKind":
      return "保持の上限の種類が不正だったため、既定（日数）に戻しました。";
    case "retentionDays":
      return "保持の日数が範囲外だったため、既定値に戻しました。";
    case "retentionCount":
      return "保持の件数が範囲外だったため、既定値に戻しました。";
    case "reread":
      return "値の読み直しの設定が範囲外だったため、4 つとも既定値に戻しました。";
    case "sound":
      return "ブザーの音の設定が不正だったため、既定のビープに戻しました。";
  }
}

/** 保持の現況の文字。 */
export function alarmRetentionStatusText(
  status: AlarmSettingsView["retentionStatus"],
  timeZone?: string,
): string {
  if (!status)
    return "監視中の Project が無いか、履歴を読めないため、現況を示せません。";
  const count = `いまのイベント ${status.eventCount.toLocaleString("ja-JP")} 件`;
  if (status.oldestAtMs === null)
    return `${count}（消す対象のイベントはありません）`;
  const oldest = new Date(status.oldestAtMs).toLocaleString("ja-JP", {
    timeZone,
  });
  return `${count}・いちばん古いイベント ${oldest}`;
}

/**
 * 入口（メニュー・一覧の窓の「端末設定」）を押せない理由。端末設定は host が持つので、
 * host の無いブラウザ版では押せない。押せるときは null。
 */
export function alarmSettingsEntryReason(
  feed: { readonly alarmSettings?: unknown } | undefined,
): string | null {
  return feed?.alarmSettings
    ? null
    : "端末設定はデスクトップ版だけで扱えます（ブラウザ版には端末の host がありません）。";
}
