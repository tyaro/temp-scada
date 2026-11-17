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
  readonly confirmed?: readonly UnackedOccurrence[];
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
