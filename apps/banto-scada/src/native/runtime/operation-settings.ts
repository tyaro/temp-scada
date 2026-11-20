/**
 * 書込みの端末設定（段階3の操作 設計 §7、O2c-4a）の純関数。host の command
 * `operation_key_status`・`operation_key_register`・`operation_key_delete`・
 * `operation_write_resume`（`src-tauri/src/operation.rs`）の答えと誤りを、
 * Runtime の上端の札と窓の文にする。秘密の値は host から返らない。
 */

export type WriteState = "ready" | "stopped" | "key_invalid";

/** `OperationKeyStatus`（Rust）の wire の形。 */
export interface OperationKeyStatus {
  /** キーを組にした接続先。キーが無ければ null。 */
  keyEndpoint: string | null;
  /** 保存した読み用の接続先。無ければ null。 */
  hubEndpoint: string | null;
  write: { state: WriteState; changedAtMs: number | null };
  /** 書込みの最小間隔（ミリ秒、O2c-4b）。 */
  minIntervalMs: number;
  /** 記録の保持（O4a）。日数と件数の両方を当て、早く消える方が効く。 */
  retention: { days: number; count: number };
}

/**
 * `operation_record_size` の答え。記録の行数と最古の依頼時刻。数えるのに
 * 索引を全部読むので、上端の札が定期に読む状態には含めず、窓を開いた・
 * 保持を保存したときだけ読む。
 */
export interface OperationRecordSize {
  rowCount: number;
  oldestRequestedAtMs: number | null;
}

/** 最小間隔の範囲（host の `operation_db::valid_min_interval` と同じ）。 */
export const MIN_INTERVAL_RANGE_MS = [100, 60_000] as const;
export const MIN_INTERVAL_STEP_MS = 100;

/** 記録の保持の範囲（host の `operation_db::RETENTION_*_RANGE` と同じ）。 */
export const RETENTION_DAYS_RANGE = [1, 3_650] as const;
export const RETENTION_COUNT_RANGE = [10_000, 10_000_000] as const;

export type Invoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

/** 端末設定の command を包む。誤りは host の理由の文字のまま投げる。 */
export function createOperationSettingsHost(invoke: Invoke) {
  return {
    status: () => invoke<OperationKeyStatus>("operation_key_status"),
    recordSize: () => invoke<OperationRecordSize>("operation_record_size"),
    register: (secret: string) =>
      invoke<OperationKeyStatus>("operation_key_register", { secret }),
    remove: () => invoke<OperationKeyStatus>("operation_key_delete"),
    resume: () => invoke<OperationKeyStatus>("operation_write_resume"),
    setMinInterval: (minIntervalMs: number) =>
      invoke<OperationKeyStatus>("operation_min_interval_set", {
        minIntervalMs,
      }),
    setRetention: (retentionDays: number, retentionCount: number) =>
      invoke<OperationKeyStatus>("operation_retention_set", {
        retentionDays,
        retentionCount,
      }),
  };
}
export type OperationSettingsHost = ReturnType<
  typeof createOperationSettingsHost
>;

/** host の誤りを理由の文字にする（文字でないものは IPC の失敗）。 */
export function settingsErrorCode(error: unknown): string {
  return typeof error === "string" ? error : "ipc_failed";
}

/**
 * 書き用キーの組の状態。`mismatch` は登録した接続先と今の読み用の接続先が
 * 違う（書込みは `hub_mismatch`）。
 */
export type KeyPairing = "none" | "paired" | "mismatch";
export function keyPairing(status: OperationKeyStatus): KeyPairing {
  if (status.keyEndpoint === null) return "none";
  return status.keyEndpoint === status.hubEndpoint ? "paired" : "mismatch";
}

export interface WriteBadge {
  variant: "success" | "warning" | "danger" | "neutral";
  label: string;
  /** 札の title。 */
  title: string;
}

/**
 * 上端の札（設計 §8「Runtime の上端にも出す」・§10「操作の記録ができない」）。
 * Hub の書込み契約は機器ごとの照会（`operation_view`）でしか分からないので、
 * ここでは「書ける」と言わず「キー登録済み」とする。
 */
export function writeBadge(
  view: { status: OperationKeyStatus } | { error: string } | undefined,
): WriteBadge {
  if (!view) return { variant: "neutral", label: "書込み: 確認中", title: "" };
  if ("error" in view)
    return view.error === "record_failed"
      ? {
          variant: "danger",
          label: "書込み: 停止",
          title: "操作の記録ができないため書込みを止めています",
        }
      : {
          variant: "warning",
          label: "書込み: 状態不明",
          title: "書込みの設定を読めません",
        };
  const { status } = view;
  const pairing = keyPairing(status);
  if (pairing === "none")
    return {
      variant: "neutral",
      label: "書込み: キー未登録",
      title: "書き用キーが登録されていないため、この端末からは書込みしません",
    };
  if (pairing === "mismatch")
    return {
      variant: "warning",
      label: "書込み: 接続先違い",
      title: "書き用キーが別の接続先のものです。登録し直してください",
    };
  if (status.write.state === "stopped")
    return {
      variant: "danger",
      label: "書込み: 停止中",
      title: "Hub が書き用キーを止めました",
    };
  if (status.write.state === "key_invalid")
    return {
      variant: "danger",
      label: "書込み: キー無効",
      title: "Hub が書き用キーを認めませんでした。登録し直してください",
    };
  return {
    variant: "success",
    label: "書込み: キー登録済み",
    title: "書き用キーが登録されています",
  };
}

/**
 * 窓の「書込みの状態」の文。端末の止まり方だけを言う（`ready` はキーの有無・
 * 接続先・Hub の対応を含まないので「書ける」とは言わない）。
 */
export function writeStateText(state: WriteState): string {
  switch (state) {
    case "ready":
      return "止まっていません（書込みには、この接続先と組の書き用キーと、Hub の書込みへの対応が要ります）。";
    case "stopped":
      return "停止中: Hub が書き用キーを止めました。Hub の管理画面で解除してから「書込みを再開」を押すか、キーを登録し直してください。";
    case "key_invalid":
      return "キーが無効: Hub が書き用キーを認めませんでした（失効・削除）。キーを登録し直してください。";
  }
}

/** host の誤りの理由の文（`operation.rs` の各 command の誤り）。 */
export function operationSettingsReasonText(code: string): string {
  switch (code) {
    case "unauthorized":
      return "書込みの設定の変更には Admin でのログインが必要です。";
    case "forbidden":
      return "書込みの設定の変更は Admin だけが行えます。";
    case "auth_unavailable":
    case "auth_failed":
      return "認証を確かめられないため、書込みの設定を変更できません。";
    case "auth_phase_unavailable":
      return "認証の切替中のため、書込みの設定を変更できません。";
    case "record_failed":
      return "操作の記録を開けないため、書込みの設定を使えません。";
    case "no_hub":
      return "Hub の接続先が保存されていません。Editor で Hub に接続してから登録してください。";
    case "invalid_secret":
      return "キーの形式が正しくありません（空白や全角を含まない文字列を入れてください）。";
    case "invalid_endpoint":
      return "Hub の接続先が http ではないため、書き用キーを登録できません。";
    case "invalid_interval":
      return "最小間隔は 0.1〜60 秒（0.1 秒刻み）で入れてください。";
    case "invalid_retention":
      return "記録の保持は 1〜3650 日、10000〜10000000 件の整数で入れてください。";
    case "key_store":
      return "資格情報の保存先を使えないため、書き用キーを扱えません。";
    case "ipc_failed":
      return "アプリの内部の呼出しに失敗しました。";
    default:
      return `書込みの設定を変更できませんでした（${code}）。`;
  }
}

/** 変更の結果の文（登録・削除・再開・最小間隔・保持）。 */
export function changeDoneText(
  change: "register" | "remove" | "resume" | "interval" | "retention",
  status: OperationKeyStatus,
): string {
  switch (change) {
    case "retention":
      return `記録の保持を ${status.retention.days} 日・${status.retention.count} 件にしました。古い記録はどちらかを超えたものから消します。`;
    case "interval":
      return `最小間隔を ${intervalSecondsText(status.minIntervalMs)} 秒にしました。次の書込みから使います。`;
    case "register":
      return "書き用キーを登録しました。最初の書込みで Hub がキーを確かめます。";
    case "remove":
      return "書き用キーを削除しました。この端末からは書込みしません。";
    case "resume":
      return status.write.state === "ready"
        ? "書込みを再開しました。次の書込みで Hub がもう一度確かめます。"
        : "書込みは停止中ではないため、状態を変えていません。";
  }
}

/** 入力したキーの前後の空白（貼り付けで混ざる改行など）を落とす。中の空白は host が断る。 */
export function normalizeSecret(input: string): string {
  return input.trim();
}

/** 最小間隔の秒の表記（0.1 秒刻み）。 */
export function intervalSecondsText(ms: number): string {
  return String(ms / 1000);
}

/**
 * 秒で入れた最小間隔をミリ秒にする。数でない・範囲の外・0.1 秒刻みでない
 * ときは null（host も同じ規則で断る）。
 */
export function parseIntervalSeconds(input: string): number | null {
  const text = input.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const ms = Math.round(Number(text) * 1000);
  if (Math.abs(Number(text) * 1000 - ms) > 1e-6) return null;
  if (ms < MIN_INTERVAL_RANGE_MS[0] || ms > MIN_INTERVAL_RANGE_MS[1])
    return null;
  return ms % MIN_INTERVAL_STEP_MS === 0 ? ms : null;
}

/** 状態が変わった時刻の表示。 */
export function changedAtText(ms: number | null): string {
  if (ms === null) return "";
  return new Date(ms).toLocaleString("ja-JP");
}

/**
 * 入れた保持の日数・件数を数にする。整数でない・範囲の外は null（host も
 * 同じ規則で断る）。
 */
export function parseRetention(
  daysInput: string,
  countInput: string,
): { days: number; count: number } | null {
  const days = parseWhole(daysInput);
  const count = parseWhole(countInput);
  if (days === null || count === null) return null;
  if (days < RETENTION_DAYS_RANGE[0] || days > RETENTION_DAYS_RANGE[1])
    return null;
  if (count < RETENTION_COUNT_RANGE[0] || count > RETENTION_COUNT_RANGE[1])
    return null;
  return { days, count };
}

function parseWhole(input: string): number | null {
  const text = input.trim();
  return /^\d{1,9}$/.test(text) ? Number(text) : null;
}

/** 記録の大きさの表示。読めなければ空。 */
export function recordSizeText(record: OperationRecordSize | null): string {
  if (record === null) return "";
  if (record.oldestRequestedAtMs === null)
    return `今の記録: ${record.rowCount} 件`;
  return `今の記録: ${record.rowCount} 件（最古 ${changedAtText(record.oldestRequestedAtMs)}）`;
}
