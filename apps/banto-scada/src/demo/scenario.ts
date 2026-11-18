/**
 * Pages のデモだけが使う模擬値の筋書き。製品のコード（`src/lib`・`App.svelte`）は
 * このフォルダーを import しない。
 */
export type DemoValue = number | boolean;

export interface DemoScenario {
  /** 筋書きが一巡する秒数。 */
  cycleSec: number;
  /**
   * 時刻（UNIX 秒）だけで決まるタグの値。同じ時刻には同じ値を返すので、
   * 現在値・警報・履歴トレンドが同じ筋書きを共有できる。
   */
  values(tSec: number): Record<string, DemoValue>;
}

/** 現在時刻の入れ口。`at` を指定すると、筋書きのその秒で止める（検証・画面写真用）。 */
export interface DemoClock {
  readonly frozen: boolean;
  nowMs(): number;
  /** 1 秒ごと（止めているときは最初の 1 回だけ）に呼ぶ。戻り値で解除する。 */
  every(run: () => void): () => void;
}

export function createDemoClock(
  scenario: Pick<DemoScenario, "cycleSec">,
  atSec?: number,
): DemoClock {
  if (atSec === undefined)
    return {
      frozen: false,
      nowMs: () => Date.now(),
      every(run) {
        run();
        const timer = setInterval(run, 1000);
        return () => clearInterval(timer);
      },
    };
  // 筋書きの位相が 0 になる固定の時刻を基準にする。
  const base =
    Math.floor(Date.UTC(2026, 0, 1) / 1000 / scenario.cycleSec) *
    scenario.cycleSec;
  const fixed = (base + atSec) * 1000;
  return {
    frozen: true,
    nowMs: () => fixed,
    every(run) {
      run();
      return () => {};
    },
  };
}

/** 点列 `[秒, 値]` を直線でつなぎ、周期の中の位相 `phase` の値を返す。 */
export function piecewise(
  points: readonly (readonly [number, number])[],
  phase: number,
): number {
  for (let i = 1; i < points.length; i++) {
    const [t0, v0] = points[i - 1],
      [t1, v1] = points[i];
    if (phase <= t1) return v0 + ((v1 - v0) * (phase - t0)) / (t1 - t0);
  }
  return points[points.length - 1][1];
}

/** `phase` が区間 `[from, to)` のどれかに入るか。 */
export function within(
  phase: number,
  ...ranges: readonly (readonly [number, number])[]
): boolean {
  return ranges.some(([from, to]) => from <= phase && phase < to);
}

/** 時刻だけで決まる小さな揺らぎ（-1〜1）。`seed` で系列を変える。 */
export function ripple(tSec: number, seed: number): number {
  return (
    0.6 * Math.sin(tSec * 0.83 + seed * 1.7) +
    0.4 * Math.sin(tSec * 2.31 + seed * 0.9)
  );
}
