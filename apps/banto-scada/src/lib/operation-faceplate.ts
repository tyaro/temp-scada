/**
 * Runtime の小窓（標準 Faceplate）の操作の行の状態（段階3の運転操作 §6・§8、
 * O3c-1）。画面の部品（designer/EquipmentOperationRows.svelte）は薄くし、
 * 押せるか・何を出すかはここで決める。書込みの可否は host が毎回決めるので、
 * ここで押せると判断しても送った結果が正となる。
 */
import {
  outcomeText,
  reasonText,
  SENDING_TEXT,
  UNRECORDED_TEXT,
  type OperationLatest,
  type OperationRow,
  type OperationView,
  type OperationWriteRequest,
  type WriteResult,
} from "./operation";

/** Runtime の host（command `operation_view`・`operation_write`）と、起動時の Project。 */
export interface OperationHost {
  projectId: string;
  projectDigest: string;
  view(equipmentId: string): Promise<OperationView>;
  write(request: OperationWriteRequest): Promise<WriteResult>;
}

type Invoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;
/** Tauri の invoke から作る。どちらの command も `{ request }` を受ける。 */
export function createOperationHost(
  invoke: Invoke,
  projectId: string,
  projectDigest: string,
): OperationHost {
  return {
    projectId,
    projectDigest,
    view: async (equipmentId) =>
      (await invoke("operation_view", {
        request: { equipmentId },
      })) as OperationView,
    write: async (request) =>
      (await invoke("operation_write", { request })) as WriteResult,
  };
}

/** 押した Symbol 配置。書込みの要求と入力の小数桁に要る。 */
export interface OperationPlacement {
  screenId: string;
  objectId: string;
}

/** §6: 開発・初期設定のフェーズで、押せるときに出す文。 */
export const INITIALIZING_TEXT = "初期設定中: ログインなしで書込みできます";
export const NO_PLACEMENT_TEXT = "配置から開いたときだけ操作できます";
export const LOADING_TEXT = "操作の状態を読んでいます";
/**
 * 小窓を開いている間に `operation_view` を照会し直す間隔。押せるかは
 * 認証・フェーズ・ほかの書込みで小窓の外から変わる（host が毎回決め直す）。
 */
export const OPERATION_VIEW_REFRESH_MS = 2000;

export type ViewState =
  | { status: "loading" }
  | { status: "ready"; view: OperationView }
  | { status: "error"; message: string };

/** IPC の失敗（Err の文字列など）を短い文にする。成功とはみなさない。 */
export function ipcErrorText(error: unknown): string {
  const code =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : "";
  return code
    ? `host が受け付けませんでした（${reasonText(code)}）`
    : "host に届きません";
}

/**
 * 小窓全体の押せなさと上端の文。`disabled` は押せなくする理由（null は押せる）、
 * `banner` は初期設定中の文（押せないときは出さない）。
 */
export function faceplateNotice(
  state: ViewState,
  placement: OperationPlacement | null,
  sending: boolean,
  runtime: Pick<OperationHost, "projectId" | "projectDigest">,
): { disabled: string | null; banner: string | null } {
  if (state.status === "loading")
    return { disabled: LOADING_TEXT, banner: null };
  if (state.status === "error")
    return {
      disabled: `操作の状態を読めません: ${state.message}`,
      banner: null,
    };
  if (state.view.blocked)
    return { disabled: reasonText(state.view.blocked), banner: null };
  // host の適用中の Project が無いか、この窓の Project と違えば送らない
  // （要求の projectId・projectDigest は Runtime の Project のもの）。
  if (
    !state.view.projectId ||
    !state.view.projectDigest ||
    state.view.projectId !== runtime.projectId ||
    state.view.projectDigest !== runtime.projectDigest
  )
    return { disabled: reasonText("project_changed"), banner: null };
  const banner = state.view.phase === "initializing" ? INITIALIZING_TEXT : null;
  if (!placement) return { disabled: NO_PLACEMENT_TEXT, banner };
  // 送信中は小窓の操作をすべて止める（2 度押し。host も端末で 1 つに限る）。
  return { disabled: sending ? SENDING_TEXT : null, banner };
}

/**
 * 書込みの応答が取れないときの文。host が処理したか（送ったか）は画面から
 * 決められないので、受け付けられなかった前提で押し直しを誘わない（§5 の
 * 結果不明と同じ扱い）。自動の再送はしない。
 */
export const WRITE_UNKNOWN_TEXT =
  "結果不明。現在値と実行記録を確認してください";
/**
 * command `operation_write` の失敗を文にする。host が送る前に断ると決まって
 * いる誤りは `"runtimeOnly"`（O2b-2b）だけで、それ以外の失敗（応答の欠落・
 * IPC の断）はすべて結果不明とする。
 */
export function writeErrorText(error: unknown): string {
  return error === "runtimeOnly"
    ? "送っていません（Runtime の窓でだけ書込みできます）"
    : WRITE_UNKNOWN_TEXT;
}

/**
 * この小窓から送った書込みの答え、または応答が取れなかったこと。`before` は
 * 送る前に見ていた記録の最後の行の id（無ければ null）。
 */
export type RowAnswer =
  | { kind: "result"; result: WriteResult; atMs: number }
  | {
      kind: "error";
      message: string;
      before: string | null;
      /** 確認の小窓で書くとした値。 */
      value: boolean | number;
    };

/** 操作の行に出す結果（§8）。`atMs` は区分が確定した時刻。 */
export interface RowStatus {
  /** 区分・送信中・記録できなかったことの文（並べて出す）。 */
  texts: string[];
  reason: string | null;
  atMs: number | null;
  /**
   * 書こうとした値（解決した値）の文。§5: 結果は設備の状態ではないので、
   * どの値についての結果かを購読値と並べて出す。分からなければ null。
   */
  value: string | null;
}

/** 書いた値の文。ボタンの値なら、確認の小窓と同じ「見出し（値）」。 */
export function writtenValueText(
  value: unknown,
  row: Pick<OperationRow, "buttons"> | null,
): string | null {
  if (typeof value !== "boolean" && typeof value !== "number") return null;
  const button = row?.buttons.find((item) => item.value === value);
  return button ? `${button.label}（${String(value)}）` : String(value);
}

function latestStatus(
  latest: OperationLatest,
  row: Pick<OperationRow, "buttons"> | null,
): RowStatus {
  const outcome = latest.outcome ? outcomeText(latest.outcome) : null;
  const texts =
    latest.state === "sending"
      ? [SENDING_TEXT]
      : latest.state === "unrecorded"
        ? [UNRECORDED_TEXT, ...(outcome ? [outcome] : [])]
        : [outcome ?? outcomeText("uncertain")];
  return {
    texts,
    reason: latest.reason ? reasonText(latest.reason) : null,
    atMs: latest.state === "sending" ? null : latest.finishedAtMs,
    value: writtenValueText(latest.value, row),
  };
}

/**
 * 行の結果。出どころは host の実行記録の最後の 1 件（開き直しても同じ）。
 * ただし、この小窓の直前の答えが記録に無い（記録しない拒否・記録に失敗・
 * IPC の失敗）か、記録の最後の行と違うときは、その答えを出す。
 */
export function rowStatus(
  latest: OperationLatest | null,
  answer: RowAnswer | null,
  row: Pick<OperationRow, "buttons"> | null = null,
): RowStatus | null {
  if (answer?.kind === "error")
    // 送った後に新しい記録の行が読めたら、その行が結果を示す。
    return latest && latest.id !== answer.before
      ? latestStatus(latest, row)
      : {
          texts: [answer.message],
          reason: null,
          atMs: null,
          value: writtenValueText(answer.value, row),
        };
  if (
    answer &&
    (answer.result.unrecorded ||
      !answer.result.recordId ||
      answer.result.recordId !== latest?.id)
  )
    return {
      texts: [
        outcomeText(answer.result.outcome),
        ...(answer.result.unrecorded ? ["記録に失敗"] : []),
      ],
      reason: answer.result.reason ? reasonText(answer.result.reason) : null,
      atMs: answer.atMs,
      value: writtenValueText(answer.result.value, row),
    };
  return latest ? latestStatus(latest, row) : null;
}

/** 結果の時刻（端末の時刻帯の 24 時間表記）。 */
export function operationTimeText(ms: number): string {
  return new Date(ms).toLocaleString("ja-JP", { hour12: false });
}
