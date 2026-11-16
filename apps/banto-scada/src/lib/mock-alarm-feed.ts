import type { AlarmChange, AlarmSnapshot } from "./alarm-mirror";
import type { AlarmFeed } from "./project-file-service";

/**
 * e2e 用のモックの警報 feed（設計 alarm-stage3-design.md §5.5「IPC の境界でモックの警報
 * service を差し込めるようにする」）。ブラウザ版には Engine が無いので、e2e が
 * テスト用のエントリーだけを書き換えて `App` の `alarmFeed` に渡す（ほかの読取の fixture と
 * 同じ経路）。製品のコードはこのモジュールを import しない。
 */

/** e2e から操作する関数（テスト用のエントリーが `window.__bantoAlarmMock` に置く）。 */
export interface AlarmMockControl {
  /** 次に返す snapshot を差し替え、画面に取り直させる（host の Lagged と同じ経路）。 */
  setSnapshot(snapshot: AlarmSnapshot): void;
  /** `alarm_changed` 相当の event を送る。 */
  emit(change: AlarmChange): void;
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

export function createMockAlarmFeed(): {
  feed: AlarmFeed;
  control: AlarmMockControl;
} {
  let current = STOPPED;
  const subscribers = new Set<{
    change: (event: AlarmChange) => void;
    lagged: () => void;
  }>();
  return {
    feed: {
      snapshot: async () => structuredClone(current),
      subscribe: async (change, lagged) => {
        const entry = { change, lagged };
        subscribers.add(entry);
        return () => subscribers.delete(entry);
      },
    },
    control: {
      setSnapshot(snapshot) {
        current = structuredClone(snapshot);
        for (const entry of subscribers) entry.lagged();
      },
      emit(change) {
        for (const entry of subscribers) entry.change(structuredClone(change));
      },
    },
  };
}
