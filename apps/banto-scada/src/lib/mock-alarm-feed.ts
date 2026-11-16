import type { AlarmChange, AlarmSnapshot } from "./alarm-mirror";
import type {
  AlarmAckResult,
  AlarmEventRead,
  AlarmFeed,
  AlarmHistoryQuery,
  UnackedOccurrence,
} from "./project-file-service";

/**
 * e2e 用のモックの警報 feed（設計 alarm-stage3-design.md §5.5「IPC の境界でモックの警報
 * service を差し込めるようにする」）。ブラウザ版には Engine が無いので、e2e が
 * テスト用のエントリーだけを書き換えて `App` の `alarmFeed` に渡す（ほかの読取の fixture と
 * 同じ経路）。製品のコードはこのモジュールを import しない。
 */

/** e2e から操作する関数（テスト用のエントリーが `window.__bantoAlarmMock` に置く）。 */
export interface AlarmMockControl {
  /**
   * 次に返す snapshot を差し替え、画面に取り直させる（host の Lagged と同じ経路）。
   * `notify: false` なら画面に知らせない（画面が古い回を見ている状態を作る）。
   */
  setSnapshot(snapshot: AlarmSnapshot, options?: { notify?: boolean }): void;
  /** `alarm_changed` 相当の event を送る。 */
  emit(change: AlarmChange): void;
  /** `alarm_history` が返す警報イベント（seq は呼び出し側が付ける）。 */
  setHistory(events: AlarmEventRead[]): void;
  /** 次の `alarm_ack` を要求ごと拒む理由（unauthorized など）。null で解く。 */
  refuseAck(reason: string | null): void;
  /** 受けた `alarm_ack` の要求（呼ばれた順）。 */
  ackRequests(): UnackedOccurrence[][];
  /** 受けた `alarm_history` の条件（呼ばれた順）。 */
  historyQueries(): AlarmHistoryQuery[];
  /** 以後の `alarm_history` の応答を `releaseHistory` まで待たせる（照会中の競合を作る）。 */
  holdHistory(): void;
  /** 待たせた `alarm_history` の応答を返し、以後は待たせない。 */
  releaseHistory(): void;
  /** 受けた `alarm_buzzer_silence` の回数。 */
  silenceRequests(): number;
}

const STOPPED: AlarmSnapshot = {
  monitored: null,
  applied: null,
  engine: null,
  status: "notApplied",
  pendingConditionChanges: false,
  pendingDisplayChanges: false,
  historyWriteFailure: null,
  rereadFailure: null,
};

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };

export function createMockAlarmFeed(): {
  feed: AlarmFeed;
  control: AlarmMockControl;
} {
  let current = structuredClone(STOPPED) as Mutable<AlarmSnapshot>;
  let events: AlarmEventRead[] = [];
  let refusal: string | null = null;
  const acks: UnackedOccurrence[][] = [];
  const queries: AlarmHistoryQuery[] = [];
  let silences = 0;
  let held: Promise<void> | null = null;
  let release: (() => void) | null = null;
  const subscribers = new Set<{
    change: (event: AlarmChange) => void;
    lagged: () => void;
  }>();
  const notify = () => {
    for (const entry of subscribers) entry.lagged();
  };

  /** host の `alarm_ack` と同じ照合（Engine の停止 → 履歴 → 無い → 別の回 → 確認済み）。 */
  function ackOne(item: UnackedOccurrence): AlarmAckResult["result"] {
    const engine = current.engine;
    if (current.status !== "running" || !engine)
      return { kind: "engineStopped", reason: current.status };
    if (current.historyWriteFailure) return { kind: "historyUnavailable" };
    const condition = Object.hasOwn(engine.conditions, item.conditionId)
      ? engine.conditions[item.conditionId]
      : undefined;
    if (!condition) return { kind: "notFound" };
    if (
      condition.occurrence !== item.occurrence ||
      condition.recurrence !== item.recurrence
    )
      return { kind: "otherOccurrence" };
    if (condition.acked) return { kind: "alreadyAcked" };
    condition.acked = true;
    engine.seq += 1;
    if (!condition.active) {
      // 復帰・未確認の ACK で Normal に戻る。
      condition.occurrence = null;
      condition.orderKey = null;
      condition.occurredAtMs = null;
    }
    return { kind: "accepted" };
  }

  return {
    feed: {
      snapshot: async () => structuredClone(current) as AlarmSnapshot,
      subscribe: async (change, lagged) => {
        const entry = { change, lagged };
        subscribers.add(entry);
        return () => subscribers.delete(entry);
      },
      async ack(items) {
        acks.push(structuredClone([...items]));
        if (refusal) throw new Error(refusal);
        const results = items.map((item) => ({
          conditionId: item.conditionId,
          result: ackOne(item),
        }));
        if (results.some((row) => row.result.kind === "accepted")) notify();
        return results;
      },
      async silenceBuzzer() {
        silences += 1;
        // host と同じく、鳴っているときだけ「停止中」にする（ACK ではない）。
        if (current.buzzer === "ringing") {
          current.buzzer = "silenced";
          notify();
        }
        return current.buzzer ?? "quiet";
      },
      async history(query) {
        queries.push(structuredClone(query));
        if (held) await held;
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
    },
    control: {
      holdHistory() {
        held ??= new Promise((resolve) => (release = resolve));
      },
      releaseHistory() {
        release?.();
        held = null;
        release = null;
      },
      setSnapshot(snapshot, options) {
        current = structuredClone(snapshot) as Mutable<AlarmSnapshot>;
        if (options?.notify !== false) notify();
      },
      emit(change) {
        for (const entry of subscribers) entry.change(structuredClone(change));
      },
      setHistory(next) {
        events = structuredClone(next);
      },
      refuseAck(reason) {
        refusal = reason;
      },
      ackRequests: () => structuredClone(acks),
      historyQueries: () => structuredClone(queries),
      silenceRequests: () => silences,
    },
  };
}
