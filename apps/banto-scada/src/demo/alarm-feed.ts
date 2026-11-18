import type {
  AlarmConditionDisplay,
  AlarmConditionState,
  AlarmSnapshot,
} from "../lib/alarm-mirror";
import { ALARM_LIMIT_KEYS, type AlarmDefinition } from "../lib/alarms";
import type { Project } from "../lib/project";
import type {
  AlarmAckResult,
  AlarmEventRead,
  AlarmFeed,
} from "../lib/project-file-service";
import type { DemoClock, DemoScenario, DemoValue } from "./scenario";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
interface Condition {
  id: string;
  definition: AlarmDefinition;
  display: AlarmConditionDisplay;
  /** 発生の判定。`active` は今の状態（deadband の戻りの判定に使う）。 */
  judge(value: DemoValue | undefined, active: boolean): boolean | undefined;
  limit: number | boolean;
  state: Mutable<AlarmConditionState>;
}

const SESSION = { id: "demo", generation: 1 };
const normal = (): Mutable<AlarmConditionState> => ({
  active: false,
  occurrence: null,
  recurrence: 0,
  acked: true,
  timer: null,
  unavailable: null,
  reportedUnavailable: null,
  orderKey: null,
  occurredAtMs: null,
  observation: null,
});

function conditions(definitions: readonly AlarmDefinition[]): Condition[] {
  const rows: Condition[] = [];
  for (const definition of definitions) {
    if (!definition.enabled) continue;
    const source = definition.source;
    if (source.kind === "bit") {
      rows.push({
        id: definition.id,
        definition,
        display: {
          name: definition.name,
          message: definition.message ?? "",
          severity: definition.severity ?? "medium",
          limitLabel: null,
        },
        judge: (value) =>
          typeof value === "boolean" ? value === source.activeWhen : undefined,
        limit: source.activeWhen,
        state: normal(),
      });
      continue;
    }
    const deadband = source.deadband ?? 0;
    for (const key of ALARM_LIMIT_KEYS) {
      const limit = source.limits[key];
      if (!limit) continue;
      const high = key === "hh" || key === "h";
      rows.push({
        id: `${definition.id}:${key}`,
        definition,
        display: {
          name: definition.name,
          message: limit.message ?? definition.message ?? "",
          severity: limit.severity,
          limitLabel: key.toUpperCase(),
        },
        judge(value, active) {
          if (typeof value !== "number") return undefined;
          const edge = active ? deadband : 0;
          return high
            ? value >= limit.value - edge
            : value <= limit.value + edge;
        },
        limit: limit.value,
        state: normal(),
      });
    }
  }
  return rows;
}

/**
 * 模擬の警報 feed。Project の警報の定義を筋書きの値で評価し、製品の警報 host と同じ
 * snapshot の形で渡す。発生・復帰・確認（ACK）と、その履歴をブラウザの中だけで持つ。
 * 遅延（onDelay・offDelay）は使わず、ブザーは鳴らさない。
 */
export function createDemoAlarmFeed(
  project: Project,
  scenario: DemoScenario,
  clock: DemoClock,
): AlarmFeed {
  const rows = conditions(project.alarms?.definitions ?? []);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const displays = Object.fromEntries(rows.map((row) => [row.id, row.display]));
  const appliedAtMs = clock.nowMs();
  const events: AlarmEventRead[] = [];
  const listeners = new Set<() => void>();
  let seq = 0,
    order = 0,
    occurrences = 0,
    ticking = false;

  function record(
    row: Condition,
    kind: string,
    atMs: number,
    detail: Record<string, unknown>,
  ) {
    events.push({
      seq: events.length + 1,
      sessionId: SESSION.id,
      event: {
        atMs,
        conditionId: row.id,
        kind,
        detail: {
          occurrence: row.state.occurrence,
          recurrence: row.state.recurrence,
          ...detail,
        },
      },
      display: row.display,
    });
    // ブラウザの中だけの履歴なので、古いものから捨てる。
    if (events.length > 2000) events.splice(0, events.length - 2000);
  }
  function evaluate() {
    const nowMs = clock.nowMs();
    const values = scenario.values(nowMs / 1000);
    let changed = false;
    for (const row of rows) {
      const tag = row.definition.source.tag;
      const value = Object.hasOwn(values, tag) ? values[tag] : undefined;
      const active = row.judge(value, row.state.active);
      const unavailable = active === undefined ? "unresolved" : null;
      if (row.state.unavailable !== unavailable) {
        row.state.unavailable = row.state.reportedUnavailable = unavailable;
        changed = true;
      }
      if (active === undefined || active === row.state.active) continue;
      const judgement = { limit: row.limit, value, sourceTimestampMs: nowMs };
      const mode = row.definition.ackMode ?? "manual";
      changed = true;
      if (active) {
        if (row.state.occurrence === null) {
          row.state.occurrence = `demo-${++occurrences}`;
          row.state.recurrence = 0;
        } else row.state.recurrence += 1;
        row.state.active = true;
        row.state.acked = mode === "none" || mode === "noneWithSound";
        row.state.orderKey = { generation: SESSION.generation, seq: ++order };
        row.state.occurredAtMs = nowMs;
        record(row, "occurred", nowMs, { judgement });
      } else {
        row.state.active = false;
        record(row, "returned", nowMs, { judgement });
        if (mode === "autoOnReturn" && !row.state.acked) {
          row.state.acked = true;
          record(row, "autoAcked", nowMs, {});
        }
        if (row.state.acked) Object.assign(row.state, normal());
      }
    }
    if (changed) {
      seq += 1;
      for (const lagged of listeners) lagged();
    }
  }
  function snapshot(): AlarmSnapshot {
    return structuredClone({
      monitored: { projectId: project.manifest.projectId },
      applied: {
        projectId: project.manifest.projectId,
        projectRevision: project.manifest.projectRevision,
        appliedAtMs,
        displays,
      },
      engine: {
        session: SESSION,
        seq,
        unavailable: null,
        conditions: Object.fromEntries(rows.map((row) => [row.id, row.state])),
      },
      status: "running",
      pendingConditionChanges: false,
      pendingDisplayChanges: false,
      historyWriteFailure: null,
      rereadFailure: null,
    });
  }
  function start() {
    if (ticking) return;
    ticking = true;
    clock.every(evaluate);
  }

  return {
    async snapshot() {
      start();
      return snapshot();
    },
    async subscribe(_change, lagged) {
      start();
      listeners.add(lagged);
      return () => listeners.delete(lagged);
    },
    async ack(items) {
      const nowMs = clock.nowMs();
      const results = items.map((item): AlarmAckResult => {
        const row = byId.get(item.conditionId);
        const result = ((): AlarmAckResult["result"] => {
          if (!row) return { kind: "notFound" };
          if (
            row.state.occurrence !== item.occurrence ||
            row.state.recurrence !== item.recurrence
          )
            return { kind: "otherOccurrence" };
          if (row.state.acked) return { kind: "alreadyAcked" };
          row.state.acked = true;
          record(row, "acked", nowMs, { user: "デモ" });
          if (!row.state.active) Object.assign(row.state, normal());
          return { kind: "accepted" };
        })();
        return { conditionId: item.conditionId, result };
      });
      if (results.some((row) => row.result.kind === "accepted")) {
        seq += 1;
        for (const lagged of listeners) lagged();
      }
      return results;
    },
    async history(query) {
      return events
        .filter(
          (row) =>
            (query.beforeSeq === null || row.seq < query.beforeSeq) &&
            (query.fromMs === null || row.event.atMs >= query.fromMs) &&
            (query.toMs === null || row.event.atMs <= query.toMs) &&
            (query.kind === null || row.event.kind === query.kind),
        )
        .sort((a, b) => b.seq - a.seq)
        .slice(0, query.limit)
        .map((row) => structuredClone(row));
    },
  };
}
