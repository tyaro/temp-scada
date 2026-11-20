/**
 * 操作履歴の窓（段階3の運転操作 設計 §9 の照会、O4b）の純関数。行は host の
 * command `operation_history` が返し（適用中の Project の行、新しい順）、
 * `pending` の行の解釈（`sending`・`unrecorded`）も host が決める。ここは
 * 行の表示文と、絞り込みの入力から照会の条件を作ることだけをする。
 */
import type { Project } from "./project";
import {
  operationRows,
  outcomeText,
  SENDING_TEXT,
  type OperationLatest,
  type OperationOutcome,
} from "./operation";
import { operationTimeText, rowStatus } from "./operation-faceplate";

/** 1 回の照会の上限（host `HISTORY_PAGE`）。 */
export const OPERATION_HISTORY_PAGE = 500;

/** 絞り込みの区分。`pending` は結果が記録に無い行（送信中・記録できなかった）。 */
export type HistoryOutcome = OperationOutcome | "pending";

/** 絞り込みの区分と、その日本語（§5 の小窓の表示と同じ文を使う）。 */
export const HISTORY_OUTCOMES: readonly (readonly [HistoryOutcome, string])[] =
  [
    ...(
      ["ok", "refused", "not_sent", "stopped", "failed", "uncertain"] as const
    ).map((outcome) => [outcome, outcomeText(outcome)] as const),
    ["pending", `${SENDING_TEXT}・結果を記録できなかったもの`],
  ];

/** host の行（`operation_history` の `rows` の 1 つ）。 */
export interface OperationHistoryRow extends OperationLatest {
  seq: number;
  user: string;
  equipmentId: string;
  equipmentCode: string | null;
  slot: string;
  /** 入力の操作で打たれた文字列。 */
  input: string | null;
  /** §7 の集約でまとめた件数（既定 1）。 */
  repeatCount: number;
}
export interface OperationHistory {
  /** 適用中の Project。無いときは null（行も無い）。 */
  projectId: string | null;
  rows: OperationHistoryRow[];
  /** 続きのカーソル。古い行が残っていなければ null。 */
  nextBeforeSeq: number | null;
}

/** command `operation_history` の要求。無い項目は条件にしない。 */
export interface OperationHistoryQuery {
  fromMs?: number;
  toMs?: number;
  equipmentId?: string;
  outcomes?: HistoryOutcome[];
  beforeSeq?: number;
}

export interface OperationHistoryHost {
  history(query: OperationHistoryQuery): Promise<OperationHistory>;
}
type Invoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;
export function createOperationHistoryHost(
  invoke: Invoke,
): OperationHistoryHost {
  return {
    history: async (request) =>
      (await invoke("operation_history", { request })) as OperationHistory,
  };
}

/** 絞り込みの欄の値。期間は `datetime-local`（ローカル時刻）、空は制限しない。 */
export interface OperationHistoryFilter {
  from: string;
  to: string;
  /** 空はすべての機器。 */
  equipmentId: string;
  outcomes: readonly HistoryOutcome[];
}

/**
 * 絞り込みの欄から照会の条件を作る。区分がすべて選ばれていれば区分の条件を
 * 付けない。期間の誤り・区分が 1 つも無いときは issue を返す。
 */
export function operationHistoryQuery(
  filter: OperationHistoryFilter,
  beforeSeq: number | null = null,
): { query: OperationHistoryQuery } | { issue: string } {
  const parse = (value: string): number | null | undefined => {
    if (!value) return null;
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : undefined;
  };
  const fromMs = parse(filter.from),
    toMs = parse(filter.to);
  if (fromMs === undefined || toMs === undefined)
    return { issue: "期間の日時を正しく入れてください。" };
  if (fromMs !== null && toMs !== null && fromMs > toMs)
    return { issue: "開始は終了より前にしてください。" };
  const chosen = new Set(filter.outcomes);
  if (!chosen.size) return { issue: "区分を 1 つ以上選んでください。" };
  const query: OperationHistoryQuery = {};
  if (fromMs !== null) query.fromMs = fromMs;
  if (toMs !== null) query.toMs = toMs;
  if (filter.equipmentId) query.equipmentId = filter.equipmentId;
  if (HISTORY_OUTCOMES.some(([outcome]) => !chosen.has(outcome)))
    query.outcomes = HISTORY_OUTCOMES.map(([outcome]) => outcome).filter(
      (outcome) => chosen.has(outcome),
    );
  if (beforeSeq !== null) query.beforeSeq = beforeSeq;
  return { query };
}

/** 窓の 1 行の表示文。 */
export interface OperationHistoryLine {
  seq: number;
  time: string;
  user: string;
  equipment: string;
  operation: string;
  value: string;
  outcome: string;
  reason: string;
  /** `repeatCount` が 2 以上のときだけ「×n」。 */
  repeat: string;
  duration: string;
  auditId: string;
}

/** 所要時間（受付から結果の確定まで）。確定していなければ空。 */
export function durationText(row: OperationLatest): string {
  if (row.finishedAtMs === null) return "";
  const ms = Math.max(0, row.finishedAtMs - row.requestedAtMs);
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} 秒`;
}

/**
 * 行の表示文。機器の名前と操作の見出しは今の Project から引き、無ければ
 * 記録のコード・slot 名を出す。区分・理由は小窓の結果の表示（`rowStatus`）
 * と同じ規則で作る。値は記録どおりの値（無ければ入力の文字列）で、ボタンの
 * 名前は付けない。履歴は同じ Project ID の旧版の行も含み、今のボタン定義が
 * その操作の時点と同じとは限らないため（#334 のレビュー）。
 */
export function operationHistoryLine(
  row: OperationHistoryRow,
  project: Project | undefined,
): OperationHistoryLine {
  const equipment = project?.equipment?.find(
    (item) => item.id === row.equipmentId,
  );
  const code = row.equipmentCode ?? equipment?.code ?? row.equipmentId;
  const write = project
    ? operationRows(project, row.equipmentId).find(
        (item) => item.slotName === row.slot,
      )
    : undefined;
  const status = rowStatus(row, null, null);
  return {
    seq: row.seq,
    time: operationTimeText(row.requestedAtMs),
    user: row.user,
    equipment: equipment?.name ? `${code} ${equipment.name}` : code,
    operation: write?.label ?? row.slot,
    value: status?.value ?? row.input ?? "",
    outcome: status?.texts.join("・") ?? "",
    reason: status?.reason ?? "",
    repeat: row.repeatCount >= 2 ? `×${row.repeatCount}` : "",
    duration: durationText(row),
    auditId: row.auditId === null ? "" : String(row.auditId),
  };
}
