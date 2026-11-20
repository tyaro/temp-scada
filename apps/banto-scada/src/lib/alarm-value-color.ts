import type { AlarmSnapshot } from "./alarm-mirror";
import {
  alarmConditionView,
  alarmViewText,
  type AlarmView,
} from "./alarm-view";
import type { AlarmDefinition, AlarmLimitKey, AlarmSeverity } from "./alarms";

/**
 * 数値の Text の文字色を警報の状態で変えるための状態の合成（純関数）。
 * 仕様: docs/design/graphics/alarm-value-color.md「状態の合成」。
 * 色の値ではなく意味を返す。意味から色への写像は見た目の側に置く。
 */

export type AlarmValueTone = "normal" | "severity" | "unknown";

export interface AlarmValueColor {
  /** `normal`: 配置の fill、`severity`: severity の色、`unknown`: 不明の灰色。 */
  tone: AlarmValueTone;
  /** tone が `severity` のときの severity。 */
  severity?: AlarmSeverity;
  /** 下線を引くときの severity（未確認の condition があるときだけ）。 */
  underline?: AlarmSeverity;
  /** 下線だけを点滅させる（`blinkUnacked` かつ下線があるとき）。 */
  blink: boolean;
  /** `aria-label`・`<title>` に足す警報の状態の文字。 */
  title: string;
}

const SEVERITY_RANK: Record<AlarmSeverity, number> = {
  high: 0,
  medium: 1,
  low: 2,
};
/** 限界の外側から。bit（限界なし）は同じ severity の限界の後。 */
const LIMIT_RANK: Record<AlarmLimitKey, number> = { hh: 0, ll: 1, h: 2, l: 3 };
const LIMIT_ORDER: readonly AlarmLimitKey[] = ["hh", "h", "l", "ll"];
const LIMIT_LABELS: Record<AlarmLimitKey, string> = {
  hh: "HH",
  h: "H",
  l: "L",
  ll: "LL",
};

interface Row {
  limit: AlarmLimitKey | null;
  view: AlarmView;
  severity: AlarmSeverity;
}

function compareRows(a: Row, b: Row): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    (a.limit ? LIMIT_RANK[a.limit] : 4) - (b.limit ? LIMIT_RANK[b.limit] : 4)
  );
}

function isActive(view: AlarmView): boolean {
  return view.state === "activeUnacked" || view.state === "activeAcked";
}

function rowText(row: Row): string {
  const text = alarmViewText(row.view);
  return row.limit ? `${LIMIT_LABELS[row.limit]} ${text}` : text;
}

/**
 * 指す定義の condition の表示状態を合成する。見る condition は、編集中の定義から出るもの
 * （しきい値は限界ごとの `${id}:${限界}`、bit は `id`）と、snapshot の `engine.conditions` にある
 * `id`・`${id}:hh|h|l|ll` の和集合。
 */
export function alarmValueColor(
  definition: Pick<AlarmDefinition, "id" | "name" | "source">,
  snapshot: AlarmSnapshot | null,
  projectId: string,
  blinkUnacked: boolean,
): AlarmValueColor {
  const { id } = definition;
  const candidates = new Map<string, AlarmLimitKey | null>();
  if (definition.source.kind === "threshold") {
    for (const key of LIMIT_ORDER)
      if (definition.source.limits[key]) candidates.set(`${id}:${key}`, key);
  } else candidates.set(id, null);
  const conditions = snapshot?.engine?.conditions;
  if (conditions) {
    if (Object.hasOwn(conditions, id)) candidates.set(id, null);
    for (const key of LIMIT_ORDER)
      if (Object.hasOwn(conditions, `${id}:${key}`))
        candidates.set(`${id}:${key}`, key);
  }
  const rows: Row[] = [...candidates].map(([conditionId, limit]) => {
    const view = alarmConditionView(snapshot, projectId, conditionId);
    return { limit, view, severity: view.severity ?? "high" };
  });
  rows.sort(compareRows);

  const prefix = `警報 ${definition.name}: `;
  if (rows.length === 0) {
    // 限界の無いしきい値の定義。Engine 側の状態が不明のときだけ不明にする。
    const probe = alarmConditionView(snapshot, projectId, id);
    const unknown = probe.state === "unknown" && probe.reason !== "notApplied";
    return {
      tone: unknown ? "unknown" : "normal",
      blink: false,
      title: prefix + (unknown ? alarmViewText(probe) : "正常"),
    };
  }

  const active = rows.find((row) => isActive(row.view));
  const unacked = rows.find(
    (row) =>
      row.view.state === "activeUnacked" ||
      row.view.state === "returnedUnacked",
  );
  const uncertain = rows.some(
    (row) => row.view.state === "unknown" || row.view.state === "unavailable",
  );
  const abnormal = rows.filter((row) => row.view.state !== "normal");
  const allUnknown = rows.every((row) => row.view.state === "unknown");
  const title =
    prefix +
    (abnormal.length === 0
      ? "正常"
      : allUnknown
        ? alarmViewText(rows[0].view)
        : abnormal.map(rowText).join("、"));

  return {
    tone: active ? "severity" : uncertain ? "unknown" : "normal",
    ...(active ? { severity: active.severity } : {}),
    ...(unacked ? { underline: unacked.severity } : {}),
    blink: blinkUnacked && unacked !== undefined,
    title,
  };
}
