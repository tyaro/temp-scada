/**
 * The desktop's Project file host (alarm design §5.2, 3-C1): the host picks
 * the file in its own dialog and reads or writes it, so the saved Project is
 * the file the host wrote. The webview names a file only by the `fileId` the
 * host returned. The browser has no such host and keeps its download.
 */
export type ProjectFileFormat = "json" | "package";

export interface UnackedOccurrence {
  readonly conditionId: string;
  readonly occurrence: string;
  readonly recurrence: number;
}

export type AlarmApplyResult =
  | {
      readonly status: "applied";
      readonly snapshot?: { readonly status: string };
      readonly initialMonitoring?: boolean;
      readonly warning?: "monitorPathNotSaved" | "recoveredAfterApply";
    }
  | { readonly status: "skippedDifferentProject" }
  | { readonly status: "skippedEndpointChanged" }
  | { readonly status: "skippedNoHub" }
  | { readonly status: "skippedBusy" }
  | {
      readonly status: "skippedUnavailable";
      readonly reason:
        "terminalUnavailable" | "noDataDir" | "auth_phase_unavailable";
    }
  | {
      readonly status: "switchConfirmationRequired";
      readonly monitoredProjectId: string;
    }
  | {
      readonly status: "confirmationRequired";
      readonly occurrences: UnackedOccurrence[];
    }
  | { readonly status: "failed"; readonly reason: string };

export interface OpenedProjectFile {
  readonly fileId: number;
  readonly file: File;
}

export interface SaveProjectFileRequest {
  /** The file the Project came from or was last saved to; null for a new
   * Project or a sample (the host asks where to save). */
  readonly fileId: number | null;
  readonly format: ProjectFileFormat;
  /** The Project's name, for the save dialog's file name. */
  readonly name: string;
  /** Always ask where to save. */
  readonly saveAs: boolean;
  readonly content: Uint8Array;
}

export interface SavedProjectFile {
  readonly fileId: number;
  readonly fileName: string;
  readonly apply?: AlarmApplyResult;
}

export interface ProjectFileService {
  /** null when the user cancelled the dialog. */
  open(): Promise<OpenedProjectFile | null>;
  /** null when the user cancelled the dialog. */
  save(request: SaveProjectFileRequest): Promise<SavedProjectFile | null>;
  apply?(
    fileId: number,
    confirmed: readonly UnackedOccurrence[],
    confirmedSwitchFrom?: string,
  ): Promise<AlarmApplyResult>;
  alarmFeed?: AlarmFeed;
}

/** The alarm host's snapshot and change events (alarm design §5.5). */
export interface AlarmFeed {
  snapshot(): Promise<import("./alarm-mirror").AlarmSnapshot>;
  subscribe(
    change: (event: import("./alarm-mirror").AlarmChange) => void,
    lagged: () => void,
  ): Promise<() => void>;
  /** `alarm_ack`: one result per item, in order. Rejects with the refusal
   * reason (unauthorized, forbidden, ...) when the whole request is refused. */
  ack?(items: readonly UnackedOccurrence[]): Promise<AlarmAckResult[]>;
  /** `alarm_history`: newest first; pass the last `seq` as `beforeSeq` for more. */
  history?(query: AlarmHistoryQuery): Promise<AlarmEventRead[]>;
  /** `alarm_buzzer_silence`: stop this terminal's buzzer. Not an ACK and
   * needs no login; resolves to the buzzer status after silencing. */
  silenceBuzzer?(): Promise<import("./alarm-mirror").AlarmBuzzerStatus>;
  /** `alarm_settings_get`: the terminal settings (terminal settings design §6). No login. */
  alarmSettings?(): Promise<import("./alarm-settings").AlarmSettingsView>;
  /** `alarm_settings_set`: retention and reread only. Rejects with the reason
   * (invalidSettings, unauthorized, ...). */
  setAlarmSettings?(
    settings: import("./alarm-settings").AlarmSettings,
  ): Promise<import("./alarm-settings").AlarmSettingsView>;
  /** `alarm_sound_import`: the host's dialog; null when cancelled. */
  importAlarmSound?(): Promise<
    import("./alarm-settings").AlarmSettingsView | null
  >;
  /** `alarm_sound_reset`: back to the bundled beep. */
  resetAlarmSound?(): Promise<import("./alarm-settings").AlarmSettingsView>;
  /** `alarm_sound_test`: play the current sound once (`buzzerRinging` while ringing). No login. */
  testAlarmSound?(): Promise<void>;
}

/** `alarm_ack`'s result of one item (`src-tauri/src/alarm.rs` `AckResult`). */
export interface AlarmAckResult {
  readonly conditionId: string;
  readonly result: {
    readonly kind:
      | "accepted"
      | "otherOccurrence"
      | "alreadyAcked"
      | "notFound"
      | "historyUnavailable"
      | "engineStopped"
      | "failed";
    readonly reason?: string;
  };
}

export interface AlarmHistoryQuery {
  readonly beforeSeq: number | null;
  readonly fromMs: number | null;
  readonly toMs: number | null;
  readonly kind: string | null;
  readonly limit: number;
}

/** One alarm event (`scada_host::alarm_db::EventRead`). */
export interface AlarmEventRead {
  readonly seq: number;
  readonly sessionId: string;
  readonly event: {
    readonly atMs: number;
    readonly conditionId: string | null;
    readonly kind: string;
    /** The engine event without kind / time / condition (occurrence,
     * recurrence, judgement, user, reason, ...), or the host's own detail. */
    readonly detail: Record<string, unknown>;
  };
  readonly display: import("./alarm-mirror").AlarmConditionDisplay | null;
}

/** A refusal of the host, with its reason code. */
export class ProjectFileError extends Error {
  constructor(readonly reason: string) {
    super(projectFileReasonText(reason));
  }
}

export function projectFileReasonText(reason: string): string {
  switch (reason) {
    case "unauthorized":
      return "Project の保存には Admin でのログインが必要です。";
    case "forbidden":
      return "Project の保存は Admin だけが行えます。";
    case "auth_unavailable":
    case "auth_failed":
      return "認証を確かめられないため保存できません。";
    case "too_large":
      return "ファイルは80MiB以下にしてください。";
    case "unknown_format":
      return "Project ファイル（.json・.bantoscada）を選んでください。";
    case "not_found":
      return "ファイルまたはフォルダが見つかりません。";
    case "permission_denied":
      return "ファイルへのアクセスが拒否されました。";
    case "format_mismatch":
    case "invalid_request":
      return "保存の要求が不正です。";
    default:
      return `ファイルの読み書きに失敗しました（${reason}）。`;
  }
}

/** Why `alarm_apply` (or the apply after a save) failed, for the toast:
 * the cause in words, then the host's code in brackets. The codes come from
 * `src-tauri/src/alarm.rs` (`reason`, `apply_failure_reason`, `hub_context`,
 * `authorized_user`); an unknown code is shown as it is. */
export function alarmApplyReasonText(reason: string): string {
  const cause = ALARM_APPLY_REASONS[reason];
  return cause ? `${cause}（${reason}）` : `理由: ${reason}`;
}

const ALARM_APPLY_REASONS: Readonly<Record<string, string>> = {
  historyUnwritable:
    "警報の履歴DBに書き込めない間は適用できません。書込みの回復を待ってから再度適用してください",
  alarmDbUnavailable: "警報DBを開けません",
  invalidProject: "Projectの警報定義を読み取れません",
  engineUnavailable: "警報Engineが応答しません",
  engineStopped: "警報Engineが停止しています",
  terminalStateFailed: "この端末の監視先の記録を更新できませんでした",
  // Any `TerminalError` (in use, unreadable, corrupt, lost): do not name one.
  terminalUnavailable: "この端末の警報設定・監視状態を利用できません",
  alarmUnavailable: "この端末では警報Engineを使えません",
  noDataDir: "警報Engineの保存先がありません",
  noHub: "Hubが設定されていません",
  hubUnavailable: "Hubの設定を読み取れません",
  endpointChanged: "Hubの接続先が変わりました",
  notApplied: "監視中のProjectがありません",
  exiting: "アプリの終了処理中です",
  unknownFileId: "Projectファイルを開き直すか保存し直してください",
  unauthorized: "警報定義の適用には Admin でのログインが必要です",
  forbidden: "警報定義の適用は Admin だけが行えます",
  auth_unavailable: "認証を確かめられません",
  auth_failed: "認証を確かめられません",
  auth_phase_unavailable: "認証の切替中です",
};
