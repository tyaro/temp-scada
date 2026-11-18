import type { AlarmChange, AlarmSnapshot } from "./alarm-mirror";
import {
  ALARM_SETTINGS_DEFAULTS,
  type AlarmSettings,
  type AlarmSettingsView,
} from "./alarm-settings";
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
  /** `alarm_settings_get` が返す端末設定を差し替える（警告・現況・代替の理由を含む）。 */
  setAlarmSettings(view: AlarmSettingsView): void;
  /** 以後の変更（set・import・reset）を拒む理由（unauthorized など）。null で解く。 */
  refuseAlarmSettings(reason: string | null): void;
  /**
   * 次の `alarm_sound_import` の結果。`{ name }` は取り込み、null は取り消し、
   * `{ reason }` は拒否（`invalidSound:notWav` など）。
   */
  nextSoundImport(result: { name: string } | { reason: string } | null): void;
  /** 受けた `alarm_settings_set` の値（呼ばれた順）。 */
  alarmSettingsRequests(): AlarmSettings[];
  /** 受け付けた `alarm_sound_test` の回数。 */
  soundTests(): number;
  /**
   * 以後の `alarm_settings_get` を 1 回ずつ待たせる（開き直しの競合を作る）。
   * 応答は呼ばれた時点の値。
   */
  holdAlarmSettingsReads(): void;
  /** 待たせた `alarm_settings_get` のうち `index` 番目（呼ばれた順、0 から）を返す。 */
  releaseAlarmSettingsRead(index: number): void;
}

const STOPPED: AlarmSnapshot = {
  monitored: null,
  applied: null,
  engine: null,
  status: "notApplied",
  pendingConditionChanges: false,
  pendingDisplayChanges: false,
  pendingUnknown: false,
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
  let settings: AlarmSettingsView = {
    ...structuredClone(ALARM_SETTINGS_DEFAULTS),
    sound: { kind: "default" },
    soundFallback: null,
    warnings: [],
    retentionStatus: null,
  };
  let settingsRefusal: string | null = null;
  let soundImport: { name: string } | { reason: string } | null = null;
  const settingsRequests: AlarmSettings[] = [];
  let soundTests = 0;
  let holdReads = false;
  const heldReads: (() => void)[] = [];
  const RANGES = { days: [1, 3650], count: [10_000, 10_000_000] } as const;
  /** host と同じ範囲と相互の関係（§2）。 */
  function validSettings({ retention, reread }: AlarmSettings): boolean {
    const within = (value: number, min: number, max: number) =>
      Number.isInteger(value) && value >= min && value <= max;
    return (
      ["days", "count"].includes(retention.kind) &&
      within(retention.days, ...RANGES.days) &&
      within(retention.count, ...RANGES.count) &&
      within(reread.intervalSec, 2, 300) &&
      within(reread.timeoutSec, 1, reread.intervalSec) &&
      within(reread.failureLimitSec, reread.intervalSec * 2, 3600) &&
      within(reread.reconnectFailures, 1, 10)
    );
  }
  /** 音の変更を snapshot の `buzzerSound` にも映し、画面に取り直させる。 */
  function soundChanged() {
    current.buzzerSound = {
      kind: settings.sound.kind,
      fallback: settings.soundFallback,
    };
    notify();
  }
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
      async alarmSettings() {
        const answer = structuredClone(settings);
        if (holdReads) {
          await new Promise<void>((resolve) => heldReads.push(resolve));
        }
        return answer;
      },
      async setAlarmSettings(next) {
        settingsRequests.push(structuredClone(next));
        if (settingsRefusal) throw new Error(settingsRefusal);
        if (!validSettings(next)) throw new Error("invalidSettings");
        settings = {
          ...settings,
          retention: structuredClone(next.retention),
          reread: structuredClone(next.reread),
          warnings: [],
        };
        notify();
        return structuredClone(settings);
      },
      async importAlarmSound() {
        if (settingsRefusal) throw new Error(settingsRefusal);
        const result = soundImport;
        soundImport = null;
        if (!result) return null;
        if ("reason" in result) throw new Error(result.reason);
        settings = {
          ...settings,
          sound: {
            kind: "custom",
            name: result.name,
            size: 1024,
            hash: "0".repeat(64),
          },
          soundFallback: null,
        };
        soundChanged();
        return structuredClone(settings);
      },
      async resetAlarmSound() {
        if (settingsRefusal) throw new Error(settingsRefusal);
        settings = {
          ...settings,
          sound: { kind: "default" },
          soundFallback: null,
        };
        soundChanged();
        return structuredClone(settings);
      },
      async testAlarmSound() {
        // host と同じく、鳴っている間は拒む（権限は要らない）。
        if (current.engine && current.buzzer === "ringing")
          throw new Error("buzzerRinging");
        soundTests += 1;
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
      setAlarmSettings(view) {
        settings = structuredClone(view);
      },
      refuseAlarmSettings(reason) {
        settingsRefusal = reason;
      },
      nextSoundImport(result) {
        soundImport = structuredClone(result);
      },
      alarmSettingsRequests: () => structuredClone(settingsRequests),
      soundTests: () => soundTests,
      holdAlarmSettingsReads() {
        holdReads = true;
      },
      releaseAlarmSettingsRead(index) {
        heldReads[index]?.();
      },
    },
  };
}
