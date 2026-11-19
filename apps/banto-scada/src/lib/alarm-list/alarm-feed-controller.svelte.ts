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
 * - 購読に失敗したら `subscribeError` を持ち、間隔を延ばしながら張り直す。`refresh()` でもすぐ試す。
 *   その間も snapshot は取る（一覧・帯は出す）が、張り直せるまで上端は「変化を受け取れません」のまま。
 * - 取得した snapshot を画面側の表示（小札・帯）へ配る（`setAlarmViewSnapshot`）。
 *
 * 部品の初期化中（`$effect` を張れる所）で作ること。
 */
/** 購読の張り直しの間隔（失敗のたびに倍にし、上限で止める）。 */
export const ALARM_SUBSCRIBE_RETRY_MS = { first: 2_000, max: 30_000 };

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
  let subscribeError = $state<string | null>(null);
  /** 購読が張れていなければ張り直す（feed ごとの effect が入れる）。 */
  let ensureSubscribed: (() => void) | null = null;
  let unavailableReason = $state<string | null>(null);

  const label = $derived(
    alarmStatusLabel(
      snapshot,
      readError,
      unavailableReason,
      options.projectId(),
      subscribeError,
    ),
  );
  /** 監視中で、知らせることが何も無い。 */
  const healthy = $derived(
    alarmHealthy(snapshot, options.projectId(), subscribeError),
  );
  const soundNotice = $derived(alarmSoundFallbackNotice(snapshot?.buzzerSound));

  function refresh() {
    ensureSubscribed?.();
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
    let subscribing = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = ALARM_SUBSCRIBE_RETRY_MS.first;
    const subscribe = () => {
      if (disposed || subscribing || unsubscribe) return;
      subscribing = true;
      clearTimeout(retryTimer);
      retryTimer = undefined;
      void feed
        .subscribe(
          (change) => {
            if (disposed) return;
            const decision = mirror.acceptChange(change);
            if (decision === "refresh") current.refresh();
            else if (decision === "applied") snapshot = mirror.current;
          },
          () => current.refresh(),
        )
        .then(
          (off) => {
            subscribing = false;
            if (disposed) return off();
            unsubscribe = off;
            subscribeError = null;
            retryDelay = ALARM_SUBSCRIBE_RETRY_MS.first;
            current.refresh();
          },
          (error) => {
            subscribing = false;
            if (disposed) return;
            subscribeError = String(error);
            retryTimer = setTimeout(subscribe, retryDelay);
            retryDelay = Math.min(retryDelay * 2, ALARM_SUBSCRIBE_RETRY_MS.max);
            // 変化は届かないが、いまの状態は取って一覧・帯に出す。
            current.refresh();
          },
        );
    };
    ensureSubscribed = subscribe;
    subscribe();
    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      current.dispose();
      if (queue === current) queue = null;
      if (ensureSubscribed === subscribe) ensureSubscribed = null;
      subscribeError = null;
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
    /** 変化の購読を張れなかった理由（張り直せたら null）。 */
    get subscribeError() {
      return subscribeError;
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
