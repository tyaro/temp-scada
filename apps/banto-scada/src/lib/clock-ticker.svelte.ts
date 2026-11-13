import { createSubscriber } from "svelte/reactivity";

/**
 * 時計の共有タイマー。購読者（描画中の時計）がいる間だけ 1 つの
 * interval が動き、1 秒ごとに now() を読む場所を更新する。
 * 秒の境目に合わせるため、次の秒までの待ちで刻み直す。
 */
const subscribe = createSubscriber((update) => {
  let timer: ReturnType<typeof setTimeout>;
  const schedule = () => {
    timer = setTimeout(
      () => {
        update();
        schedule();
      },
      1000 - (Date.now() % 1000),
    );
  };
  schedule();
  return () => clearTimeout(timer);
});

/** 現在の epoch ms。$derived・テンプレートの中で読むと 1 秒ごとに再評価される。 */
export function clockNow(): number {
  subscribe();
  return Date.now();
}
