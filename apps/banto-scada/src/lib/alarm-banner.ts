import type { AlarmSnapshot } from "./alarm-mirror";
import type { AlarmSeverity } from "./alarms";
import { conditionDisplay } from "./alarm-view";
import type { AlarmBannerShape } from "./project";

/**
 * 最新の警報の帯の表示の導出（純関数）。仕様: docs/design/graphics/alarm-banner.md、
 * docs/design/runtime/alarm-stage3-design.md §7・§4.4・§4.5。
 */

export type AlarmBannerKind =
  /** snapshot が無い・Engine が動いていない。 */
  | "stopped"
  /** Engine 単位の評価不能（未接続・受信の途絶）。 */
  | "unmonitored"
  /** 監視中・適用中の Project が編集中の Project と違う。 */
  | "otherProject"
  /** 監視中で、選んだ 1 件がある。 */
  | "alarm"
  /** 監視中で、出す警報が無い。 */
  | "none";

/** 帯に出す 1 件の表示状態（Normal・発生待ちは出さない）。 */
export type AlarmBannerState =
  "activeUnacked" | "activeAcked" | "returnedUnacked";

export interface AlarmBannerSelection {
  conditionId: string;
  state: AlarmBannerState;
  severity: AlarmSeverity;
  /** `M/D HH:mm:ss`（ローカル時刻）。時刻が無ければ「—」。 */
  time: string;
  name: string;
  message: string;
}

export interface AlarmBannerView {
  kind: AlarmBannerKind;
  /** 主の文字（停止中・監視できていない・別 Project・選んだ 1 件・警報なし）。 */
  main: string;
  /** 選んだ 1 件（kind が alarm のとき）。 */
  selected?: AlarmBannerSelection;
  /** 件数の文字「警報 n 件（未確認 k 件）」（kind が alarm のとき）。 */
  count?: string;
  /** condition 単位の評価不能の文字「評価不能 n 件（主な理由）」（監視中で 1 件以上のとき）。 */
  unavailable?: string;
  /** aria-label・title に使う全文。 */
  label: string;
}

/** `status` の日本語ラベル。未知の文字列はそのまま出す。 */
export const ALARM_STATUS_LABELS: Readonly<Record<string, string>> = {
  notApplied: "未適用",
  noHub: "Hub未設定",
  endpointChanged: "接続先が変わりました",
  noConditions: "警報の定義がありません",
  stopped: "停止",
  terminalUnavailable: "端末設定を開けません",
  alarmDbUnavailable: "警報DBを開けません",
  invalidAppliedDefinition: "適用済みの定義が不正です",
  engineStartFailed: "開始できませんでした",
  engineStopped: "Engineが止まりました",
  authExpired: "Hubの認証が切れました（接続し直すと再開します）",
  connectionFailed: "Hubとの通信に失敗しました",
  alarmDbFailed: "警報DBに書けなくなりました",
  engineFailed: "内部エラーで止まりました",
  confirmationRequired: "切替の確認待ち",
  switchRecoveryFailed: "切替の復旧に失敗しました",
};

/** Engine 単位の評価不能の日本語ラベル。 */
export const ALARM_ENGINE_UNAVAILABLE_LABELS: Readonly<Record<string, string>> =
  { disconnected: "未接続", receiveLost: "受信の途絶" };

/** condition 単位の評価不能の理由（§4.5 の enum 順。同数のときの主な理由の順）。 */
export const ALARM_UNAVAILABLE_REASONS = [
  "initialValue",
  "stale",
  "bad",
  "unresolved",
  "noValue",
  "typeMismatch",
  "nonFinite",
] as const;
export const ALARM_UNAVAILABLE_LABELS: Readonly<Record<string, string>> = {
  initialValue: "初期値待ち",
  stale: "更新停止",
  bad: "不良",
  unresolved: "未解決",
  noValue: "値なし",
  typeMismatch: "型不一致",
  nonFinite: "非有限",
};

export const labelOf = (
  labels: Readonly<Record<string, string>>,
  key: string,
) => (Object.hasOwn(labels, key) ? labels[key] : key);

export const SEVERITY_RANK: Readonly<Record<AlarmSeverity, number>> = {
  high: 2,
  medium: 1,
  low: 0,
};
export const severityOf = (raw: string | undefined): AlarmSeverity =>
  raw === "high" || raw === "medium" || raw === "low" ? raw : "low";

/** 同じ定義で上位にある限界（h には hh、l には ll）。 */
const UPPER_LIMIT: Readonly<Record<string, string>> = { h: "hh", l: "ll" };

/** `M/D HH:mm:ss`（ローカル時刻）。 */
export function formatAlarmBannerTime(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "—";
  const two = (value: number) => String(value).padStart(2, "0");
  return `${date.getMonth() + 1}/${date.getDate()} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

/** 新しい順（§4.4）の比較に使う値。無い orderKey・時刻は -Infinity。 */
export interface AlarmOrder {
  id: string;
  generation: number;
  seq: number;
  occurredAtMs: number;
}

interface Candidate extends AlarmOrder {
  state: AlarmBannerState;
  severity: AlarmSeverity;
}

/** condition の orderKey と発生時刻から比較の値を作る。 */
export function alarmOrderOf(
  id: string,
  condition: {
    orderKey: { generation: number; seq: number } | null;
    occurredAtMs: number | null;
  },
): AlarmOrder {
  return {
    id,
    generation: condition.orderKey?.generation ?? -Infinity,
    seq: condition.orderKey?.seq ?? -Infinity,
    occurredAtMs: condition.occurredAtMs ?? -Infinity,
  };
}

/** 新しい順（orderKey の降順、同じなら occurredAtMs の降順、最後は condition id）。 */
export function newerFirst(a: AlarmOrder, b: AlarmOrder): number {
  // 無い orderKey・時刻は -Infinity（最も古い）。差を取ると NaN になるので比べる。
  const descending = (x: number, y: number) => (x < y ? 1 : x > y ? -1 : 0);
  return (
    descending(a.generation, b.generation) ||
    descending(a.seq, b.seq) ||
    descending(a.occurredAtMs, b.occurredAtMs) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * 帯に出す表示。
 * - snapshot が無い・Engine が動いていない → 「警報 停止中（理由）」。
 * - Engine 単位の評価不能 → 「警報 監視できていません（理由）」（選んだ 1 件は出さない）。
 * - 監視中・適用中の Project が編集中と違う → 「警報 別の Project を監視中です」。
 * - 監視中: 未確認を先に → severity の高い順 → 同じ定義の上位の限界がある下位を落とす →
 *   新しい順、で 1 件を選ぶ。condition 単位の評価不能があれば件数と主な理由を添える。
 */
export function alarmBannerView(
  snapshot: AlarmSnapshot | null,
  projectId: string,
): AlarmBannerView {
  const fixed = (kind: AlarmBannerKind, main: string): AlarmBannerView => ({
    kind,
    main,
    label: `最新の警報: ${main}`,
  });
  if (!snapshot)
    return fixed("stopped", "警報 停止中（警報の状態を受け取っていません）");
  if (snapshot.status !== "running" || !snapshot.engine)
    return fixed(
      "stopped",
      `警報 停止中（${labelOf(ALARM_STATUS_LABELS, snapshot.status)}）`,
    );
  const engine = snapshot.engine;
  if (engine.unavailable)
    return fixed(
      "unmonitored",
      `警報 監視できていません（${labelOf(ALARM_ENGINE_UNAVAILABLE_LABELS, engine.unavailable)}）`,
    );
  if (
    snapshot.monitored?.projectId !== projectId ||
    (snapshot.applied && snapshot.applied.projectId !== projectId)
  )
    return fixed("otherProject", "警報 別の Project を監視中です");

  const displays = snapshot.applied?.displays ?? {};
  const displayOf = (id: string) =>
    Object.hasOwn(displays, id) ? displays[id] : undefined;
  const candidates: Candidate[] = [];
  const reasons = new Map<string, number>();
  for (const [id, condition] of Object.entries(engine.conditions)) {
    if (condition.unavailable !== null)
      reasons.set(
        condition.unavailable,
        (reasons.get(condition.unavailable) ?? 0) + 1,
      );
    const state = conditionDisplay(condition);
    if (state === "normal" || state === "pending") continue;
    candidates.push({
      ...alarmOrderOf(id, condition),
      state,
      severity: severityOf(displayOf(id)?.severity),
    });
  }

  let unavailable: string | undefined;
  if (reasons.size) {
    const total = [...reasons.values()].reduce((sum, n) => sum + n, 0);
    const order = (reason: string) => {
      const index = (ALARM_UNAVAILABLE_REASONS as readonly string[]).indexOf(
        reason,
      );
      return index < 0 ? ALARM_UNAVAILABLE_REASONS.length : index;
    };
    const [main] = [...reasons].sort(
      ([a, n], [b, m]) =>
        m - n || order(a) - order(b) || (a < b ? -1 : a > b ? 1 : 0),
    )[0];
    unavailable = `評価不能 ${total} 件（${labelOf(ALARM_UNAVAILABLE_LABELS, main)}）`;
  }

  const unacked = (c: Candidate) => c.state !== "activeAcked";
  // a. 未確認を確認済みより先に。b. その組の中で severity の高い順。
  const group = candidates.some(unacked)
    ? candidates.filter(unacked)
    : candidates;
  const top = Math.max(...group.map((c) => SEVERITY_RANK[c.severity]));
  const bySeverity = group.filter((c) => SEVERITY_RANK[c.severity] === top);
  // c. 同じ定義で上位の限界が残っていれば下位を落とす（比較関数に入れると推移律が崩れる）。
  const ids = new Set(bySeverity.map((c) => c.id));
  const narrowed = bySeverity.filter((c) => {
    const colon = c.id.indexOf(":");
    if (colon < 0) return true;
    const upper = UPPER_LIMIT[c.id.slice(colon + 1)];
    return !upper || !ids.has(`${c.id.slice(0, colon)}:${upper}`);
  });
  // d. 新しい順。
  const chosen = narrowed.sort(newerFirst)[0];

  if (!chosen) {
    const main = "警報なし";
    return {
      kind: "none",
      main,
      ...(unavailable ? { unavailable } : {}),
      label: ["最新の警報: 警報なし", unavailable].filter(Boolean).join(" ／ "),
    };
  }
  const display = displayOf(chosen.id);
  const condition = engine.conditions[chosen.id];
  const selected: AlarmBannerSelection = {
    conditionId: chosen.id,
    state: chosen.state,
    severity: chosen.severity,
    time: formatAlarmBannerTime(condition.occurredAtMs),
    name: display?.name ?? chosen.id,
    message: display?.message ?? "",
  };
  const main = [
    chosen.state === "returnedUnacked" ? "復帰" : "",
    selected.time,
    selected.name,
    selected.message,
  ]
    .filter(Boolean)
    .join(" ");
  const count = `警報 ${candidates.length} 件（未確認 ${candidates.filter(unacked).length} 件）`;
  return {
    kind: "alarm",
    main,
    selected,
    count,
    ...(unavailable ? { unavailable } : {}),
    label: [`最新の警報: ${main}`, count, unavailable]
      .filter(Boolean)
      .join(" ／ "),
  };
}

/** 新しい帯の形（文字サイズ 14・標準）。 */
export function newAlarmBannerShape(): AlarmBannerShape {
  return { type: "alarmBanner", style: { fontSize: 14, fontWeight: "normal" } };
}
