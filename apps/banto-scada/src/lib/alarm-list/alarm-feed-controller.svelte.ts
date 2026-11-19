import { AlarmMirror, type AlarmSnapshot } from "../alarm-mirror";
import { alarmHealthy, alarmStatusLabel } from "./alarm-status";
import { AlarmRefreshQueue } from "../alarm-refresh-queue";
import { alarmSoundFallbackNotice } from "../alarm-settings";
import { setAlarmViewSnapshot } from "../alarm-view-state.svelte";
import type { AlarmFeed } from "../project-file-service";

/**
 * 警報の host（alarm feed）を購読し、snapshot と取得の失敗を持つ controller。
 * Editor（App）と Runtime の窓が同じものを使う（警報設計 §5.2・Runtime モード設計 §6-4）。
 *
 * - feed が変わるたびに購読し直す。change は mirror に当て、追えないときは取り直す。
 * - 取得した snapshot を画面側の表示（小札・帯）へ配る（`setAlarmViewSnapshot`）。
 *
 * 部品の初期化中（`$effect` を張れる所）で作ること。
 */
export function createAlarmFeedController(options: {
  feed: () => AlarmFeed | undefined;
  /** いま表示している Project の ID（別の Project を監視中かの判定）。 */
  projectId: () => string;
  /** ブザー停止の失敗など、利用者へ知らせる文。 */
  onerror: (message: string) => void;
}) {
  const mirror = new AlarmMirror();
  let queue: AlarmRefreshQueue<AlarmSnapshot> | null = null;
  let snapshot = $state<AlarmSnapshot | null>(null);
  let readError = $state<string | null>(null);
  let unavailableReason = $state<string | null>(null);

  const label = $derived(
    alarmStatusLabel(
      snapshot,
      readError,
      unavailableReason,
      options.projectId(),
    ),
  );
  /** 監視中で、知らせることが何も無い。 */
  const healthy = $derived(alarmHealthy(snapshot, options.projectId()));
  const soundNotice = $derived(alarmSoundFallbackNotice(snapshot?.buzzerSound));

  function refresh() {
    queue?.refresh();
  }

  // 小札などの画面側の表示へ配る（編集・プレビュー・運転表示で同じ状態）。
  $effect(() => setAlarmViewSnapshot(snapshot));
  $effect(() => {
    const feed = options.feed();
    if (!feed) return;
    const current = new AlarmRefreshQueue(
      () => feed.snapshot(),
      (next) => {
        readError = null;
        if (mirror.acceptSnapshot(next)) snapshot = mirror.current;
      },
      (error) => (readError = String(error)),
    );
    queue = current;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void feed
      .subscribe(
        (change) => {
          if (disposed) return;
          const decision = mirror.acceptChange(change);
          if (decision === "refresh") refresh();
          else if (decision === "applied") snapshot = mirror.current;
        },
        () => refresh(),
      )
      .then((off) => {
        if (disposed) off();
        else {
          unsubscribe = off;
          refresh();
        }
      })
      .catch((error) => {
        if (!disposed) readError = String(error);
      });
    return () => {
      disposed = true;
      current.dispose();
      if (queue === current) queue = null;
      unsubscribe?.();
    };
  });

  return {
    get snapshot() {
      return snapshot;
    },
    get readError() {
      return readError;
    },
    /** 適用などで host が返した「監視できない理由」（snapshot が動いていない間だけ文に出る）。 */
    get unavailableReason() {
      return unavailableReason;
    },
    set unavailableReason(reason: string | null) {
      unavailableReason = reason;
    },
    get label() {
      return label;
    },
    get healthy() {
      return healthy;
    },
    get soundNotice() {
      return soundNotice;
    },
    /** ブザー停止を host が受け付けるか。 */
    get canSilence() {
      return !!options.feed()?.silenceBuzzer;
    },
    refresh,
    /** ブザー停止（設計§6）。ACK ではなく、ログインも要らない。状態は host から取り直す。 */
    silenceBuzzer() {
      const feed = options.feed();
      if (!feed?.silenceBuzzer) return;
      feed
        .silenceBuzzer()
        .then(refresh, (error) =>
          options.onerror(`ブザーを止められませんでした: ${String(error)}`),
        );
    },
  };
}

export type AlarmFeedController = ReturnType<typeof createAlarmFeedController>;
