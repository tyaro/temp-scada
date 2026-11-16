import type { AlarmSnapshot } from "./alarm-mirror";
import { ALARM_SEVERITIES, type AlarmSeverity } from "./alarms";
import { ALARM_VIEW_LABELS, conditionDisplay } from "./alarm-view";
import {
  ALARM_ENGINE_UNAVAILABLE_LABELS,
  ALARM_STATUS_LABELS,
  ALARM_UNAVAILABLE_LABELS,
  SEVERITY_RANK,
  alarmOrderOf,
  formatAlarmBannerTime,
  labelOf,
  newerFirst,
  severityOf,
} from "./alarm-banner";
import type {
  AlarmAckResult,
  AlarmEventRead,
  AlarmHistoryQuery,
  UnackedOccurrence,
} from "./project-file-service";

/**
 * アラーム一覧の窓の行の導出（純関数）。仕様: docs/design/graphics/alarm-list.md、
 * docs/design/runtime/alarm-stage3-design.md §5.5・§6・§7。
 * 状態の導出（conditionDisplay）・新しい順・severity の扱い・理由のラベルは小札と帯の
 * モジュールのものを使う。
 */

export type AlarmListFilter = "all" | "unavailable";

/** 行の状態。Normal（発生待ちを含む）は評価不能のときだけ行になる。 */
export type AlarmListRowState =
  "activeUnacked" | "activeAcked" | "returnedUnacked" | "normal";

export interface AlarmListRow {
  conditionId: string;
  /** ACK で送る回（§6「見ている回を指す」）。Normal の行は null。 */
  occurrence: string | null;
  recurrence: number;
  state: AlarmListRowState;
  /** 状態の文字（「未確認（発生中）」「発生中」「復帰・未確認」「正常」）。 */
  stateText: string;
  /** 未確認（ActiveUnacked・ReturnedUnacked）で、ACK の対象。 */
  unacked: boolean;
  severity: AlarmSeverity;
  severityText: string;
  name: string;
  message: string;
  limitLabel: string | null;
  /** 発生の時刻 `M/D HH:mm:ss`（無ければ「—」）。 */
  time: string;
  /** condition 単位の評価不能の理由（§4.5）。無ければ null。 */
  unavailable: string | null;
  unavailableText: string;
}

export interface AlarmListCurrent {
  /** Engine が動いていない・履歴に書けない・revision の違いなどの理由（上から出す）。 */
  notices: string[];
  /** Engine 単位の評価不能の行（先頭に 1 行）。 */
  engineRow: string | null;
  rows: AlarmListRow[];
  /** ACK を送れる（Engine が動いていて、履歴に書ける）。 */
  canAck: boolean;
}

export interface AlarmListContext {
  /** 警報の feed がある（デスクトップ版・e2e のモック）。 */
  feed: boolean;
  /** snapshot の取得の失敗。 */
  readError?: string | null;
  projectId: string;
  projectRevision: number;
}

const SEVERITY_TEXT = new Map(ALARM_SEVERITIES);

/** 「現在」タブの行と理由。 */
export function alarmListCurrent(
  snapshot: AlarmSnapshot | null,
  context: AlarmListContext,
  filter: AlarmListFilter = "all",
): AlarmListCurrent {
  const stopped = (notice: string): AlarmListCurrent => ({
    notices: [notice],
    engineRow: null,
    rows: [],
    canAck: false,
  });
  if (!context.feed)
    return stopped(
      "警報の Engine がありません（ブラウザ版）。アラーム一覧はデスクトップ版で使えます。",
    );
  if (context.readError)
    return stopped(`警報の状態を取得できません（${context.readError}）`);
  if (!snapshot) return stopped("警報の状態を受け取っていません");
  if (snapshot.status !== "running" || !snapshot.engine)
    return stopped(
      `警報の Engine が動いていません（${labelOf(ALARM_STATUS_LABELS, snapshot.status)}）`,
    );

  const notices: string[] = [];
  if (snapshot.historyWriteFailure)
    notices.push(
      `履歴に書けません（未記録 ${snapshot.historyWriteFailure.unrecordedEvents} 件）。書けるようになるまで ACK できません。`,
    );
  if (
    snapshot.monitored?.projectId !== context.projectId ||
    (snapshot.applied && snapshot.applied.projectId !== context.projectId)
  )
    notices.push(
      "別の Project を監視中です。一覧は適用中の定義の名前で出します。",
    );
  else if (
    snapshot.applied &&
    snapshot.applied.projectRevision !== context.projectRevision
  )
    notices.push(
      `編集中の Project（revision ${context.projectRevision}）と適用中の定義（revision ${snapshot.applied.projectRevision}）が違います。一覧は適用中の定義で出します。`,
    );

  const engine = snapshot.engine;
  const engineRow = engine.unavailable
    ? `監視できていません（${labelOf(ALARM_ENGINE_UNAVAILABLE_LABELS, engine.unavailable)}）`
    : null;
  const displays = snapshot.applied?.displays ?? {};
  const rows: (AlarmListRow & { order: ReturnType<typeof alarmOrderOf> })[] =
    [];
  for (const [id, condition] of Object.entries(engine.conditions)) {
    const display = conditionDisplay(condition);
    const normal = display === "normal" || display === "pending";
    // Normal で評価不能なだけの condition は、Engine 単位の評価不能の行にまとめる。
    if (normal && (condition.unavailable === null || engineRow)) continue;
    if (filter === "unavailable" && condition.unavailable === null) continue;
    const info = Object.hasOwn(displays, id) ? displays[id] : undefined;
    const state: AlarmListRowState = normal ? "normal" : display;
    const severity = severityOf(info?.severity);
    rows.push({
      conditionId: id,
      occurrence: normal ? null : condition.occurrence,
      recurrence: condition.recurrence,
      state,
      stateText: ALARM_VIEW_LABELS[state],
      unacked: state === "activeUnacked" || state === "returnedUnacked",
      severity,
      severityText: SEVERITY_TEXT.get(severity) ?? severity,
      name: info?.name ?? id,
      message: info?.message ?? "",
      limitLabel: info?.limitLabel ?? null,
      time: normal ? "—" : formatAlarmBannerTime(condition.occurredAtMs),
      unavailable: condition.unavailable,
      unavailableText:
        condition.unavailable === null
          ? ""
          : labelOf(ALARM_UNAVAILABLE_LABELS, condition.unavailable),
      order: alarmOrderOf(id, condition),
    });
  }
  // 未確認を上に → severity の高い順 → 新しい順（§4.4）。
  rows.sort(
    (a, b) =>
      Number(b.unacked) - Number(a.unacked) ||
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      newerFirst(a.order, b.order),
  );
  return {
    notices,
    engineRow,
    rows: rows.map(({ order: _order, ...row }) => row),
    canAck: !snapshot.historyWriteFailure,
  };
}

/**
 * ACK で送る回（§6）。画面が持つ最新の snapshot の未確認の行だけを
 * (conditionId, occurrence, recurrence) で返す。`ids` を渡すとその行に絞る（選んで ACK）。
 */
export function alarmAckTargets(
  rows: readonly AlarmListRow[],
  ids?: ReadonlySet<string>,
): UnackedOccurrence[] {
  return rows
    .filter(
      (row) =>
        row.unacked &&
        row.occurrence !== null &&
        (!ids || ids.has(row.conditionId)),
    )
    .map((row) => ({
      conditionId: row.conditionId,
      occurrence: row.occurrence!,
      recurrence: row.recurrence,
    }));
}

/** ACK の結果の文字（行ごとに出す）。 */
export function alarmAckResultText(result: AlarmAckResult["result"]): string {
  switch (result.kind) {
    case "accepted":
      return "受理";
    case "otherOccurrence":
      return "別の回（最新の回を表示しています）";
    case "alreadyAcked":
      return "確認済み";
    case "notFound":
      return "無い（適用中の定義にありません）";
    case "historyUnavailable":
      return "履歴に書けない";
    case "engineStopped":
      return result.reason
        ? `Engine 停止中（${labelOf(ALARM_STATUS_LABELS, result.reason)}）`
        : "Engine 停止中";
    default:
      return result.reason ? `失敗（${result.reason}）` : "失敗";
  }
}

/** 要求ごと拒まれた ACK（認可など。§6）の文字。 */
export function alarmAckRefusalText(reason: string): string {
  switch (reason) {
    case "unauthorized":
      return "ACK には Admin でのログインが必要です。";
    case "forbidden":
      return "ACK は Admin だけが行えます。";
    case "auth_unavailable":
    case "auth_failed":
    case "auth_phase_unavailable":
      return "認証を確かめられないため ACK できません。";
    default:
      return `ACK できませんでした（${reason}）。`;
  }
}

/** 履歴の種類（`alarm_history` の kind）と日本語ラベル。先頭は絞り込みの選択肢に出す。 */
export const ALARM_EVENT_KINDS: readonly [string, string][] = [
  ["occurred", "発生"],
  ["reoccurred", "再発生"],
  ["returned", "復帰"],
  ["acked", "確認（ACK）"],
  ["autoAcked", "自動確認"],
  ["unavailableStarted", "評価不能の開始"],
  ["unavailableEnded", "評価不能の終了"],
  ["engineUnavailableStarted", "監視不能の開始"],
  ["engineUnavailableEnded", "監視不能の終了"],
  ["ended", "終了"],
  ["engineStarted", "Engine 開始"],
  ["engineStopped", "Engine 停止"],
  ["projectSwitched", "Project の切替"],
  ["definitionChanged", "定義の変更で終了"],
  ["definitionDeleted", "定義の削除で終了"],
  ["connectionChanged", "接続先の変更で終了"],
  ["unrecordedPeriod", "記録できなかった期間"],
  ["unknownPeriod", "記録の無い期間"],
  ["previousSessionState", "前回の終わりの状態"],
  ["previousEngineUnavailable", "前回の監視不能"],
  ["stoppedState", "停止時の状態"],
  ["stoppedEngineUnavailable", "停止時の監視不能"],
];
const EVENT_KIND_TEXT: Readonly<Record<string, string>> =
  Object.fromEntries(ALARM_EVENT_KINDS);
const END_REASON_TEXT: Readonly<Record<string, string>> = {
  definitionChanged: "定義の変更",
  definitionDeleted: "定義の削除",
  connectionChanged: "接続先の変更",
};

export interface AlarmHistoryRow {
  seq: number;
  time: string;
  kind: string;
  kindText: string;
  name: string;
  message: string;
  limitLabel: string;
  /** 判定の限界（数値）。無ければ空。 */
  limit: string;
  /** 判定の値。無ければ空。 */
  value: string;
  /** 値の source timestamp。無ければ空。 */
  sourceTime: string;
  /** 確認者・理由など。 */
  note: string;
}

function formatValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "ON" : "OFF";
  if (typeof value === "number" || typeof value === "string")
    return String(value);
  return "";
}

/** 履歴の 1 件の行。 */
export function alarmHistoryRow(read: AlarmEventRead): AlarmHistoryRow {
  const { event, display } = read;
  const detail = (event.detail ?? {}) as Record<string, unknown>;
  const judgement =
    detail.judgement && typeof detail.judgement === "object"
      ? (detail.judgement as Record<string, unknown>)
      : {};
  const reason = typeof detail.reason === "string" ? detail.reason : "";
  const notes: string[] = [];
  if (typeof detail.user === "string") notes.push(`確認者 ${detail.user}`);
  if (reason)
    notes.push(
      event.kind === "ended"
        ? labelOf(END_REASON_TEXT, reason)
        : event.kind.startsWith("engineUnavailable")
          ? labelOf(ALARM_ENGINE_UNAVAILABLE_LABELS, reason)
          : event.kind.startsWith("unavailable")
            ? labelOf(ALARM_UNAVAILABLE_LABELS, reason)
            : labelOf(ALARM_STATUS_LABELS, reason),
    );
  if (detail.unacked === true) notes.push("未確認のまま");
  const source =
    typeof judgement.sourceTimestampMs === "number"
      ? formatAlarmBannerTime(judgement.sourceTimestampMs)
      : "";
  return {
    seq: read.seq,
    time: formatAlarmBannerTime(event.atMs),
    kind: event.kind,
    kindText: labelOf(EVENT_KIND_TEXT, event.kind),
    name: display?.name ?? event.conditionId ?? "",
    message: display?.message ?? "",
    limitLabel: display?.limitLabel ?? "",
    limit: formatValue(judgement.limit),
    value: formatValue(judgement.value),
    sourceTime: source,
    note: notes.join("・"),
  };
}

/** 履歴の 1 回の取得の件数。返った件数がこれと同じなら続きがある。 */
export const ALARM_HISTORY_PAGE = 100;

/**
 * 履歴の照会の条件。期間は `datetime-local` の値（ローカル時刻）で、空なら制限しない。
 * 開始が終了より後なら issue を返す。
 */
export function alarmHistoryQuery(
  input: { from: string; to: string; kind: string },
  beforeSeq: number | null = null,
): { query: AlarmHistoryQuery } | { issue: string } {
  const parse = (value: string): number | null | undefined => {
    if (!value) return null;
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : undefined;
  };
  const fromMs = parse(input.from),
    toMs = parse(input.to);
  if (fromMs === undefined || toMs === undefined)
    return { issue: "期間の日時を正しく入れてください。" };
  if (fromMs !== null && toMs !== null && fromMs > toMs)
    return { issue: "開始は終了より前にしてください。" };
  return {
    query: {
      beforeSeq,
      fromMs,
      toMs,
      kind: input.kind || null,
      limit: ALARM_HISTORY_PAGE,
    },
  };
}
