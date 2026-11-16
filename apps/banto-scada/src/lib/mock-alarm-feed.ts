import type { AlarmChange, AlarmSnapshot } from "./alarm-mirror";
import type { AlarmFeed } from "./project-file-service";

/**
 * e2e 用のモックの警報 feed（設計 alarm-stage3-design.md §5.5「IPC の境界でモックの警報
 * service を差し込めるようにする」）。ブラウザ版には Engine が無いので、開発サーバーで
 * e2e が印を置いたときだけ main.ts が動的 import で差し込む（製品ビルドには入らない）。
 */

/** e2e が `addInitScript` で置く印。 */
export const ALARM_MOCK_MARKER = "__BANTO_ALARM_MOCK__";

/** e2e から操作する関数（`window.__bantoAlarmMock`）。 */
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

/** 印があれば feed を作り、操作する関数を window に出す。 */
export function installMockAlarmFeed(
  target: Window & { __bantoAlarmMock?: AlarmMockControl },
): AlarmFeed | undefined {
  if (!(ALARM_MOCK_MARKER in target)) return undefined;
  const { feed, control } = createMockAlarmFeed();
  target.__bantoAlarmMock = control;
  return feed;
}
