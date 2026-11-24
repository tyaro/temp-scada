/**
 * Pages のデモだけが使う模擬値の筋書き。製品のコード（`src/lib`・`App.svelte`）は
 * このフォルダーを import しない。
 */
import {
  evaluateScenario,
  frozenTimeSec,
  parseScenario,
} from "../scenario/scenario";

export type DemoValue = number | boolean;

export interface DemoScenario {
  /** 筋書きが一巡する秒数。 */
  cycleSec: number;
  /**
   * 時刻（UNIX 秒）だけで決まるタグの値。同じ時刻には同じ値を返すので、
   * 現在値・警報・履歴トレンドが同じ筋書きを共有できる。
   */
  values(tSec: number): Record<string, DemoValue>;
  /**
   * 筋書きを止める時刻（UNIX 秒）。`atSec` は周期の中の秒で、省くと筋書きの既定
   * （無ければ `null` で止めない）。
   */
  frozenTimeSec(atSec?: number): number | null;
}

/** 現在時刻の入れ口。`at` を指定すると、筋書きのその秒で止める（検証・画面写真用）。 */
export interface DemoClock {
  readonly frozen: boolean;
  nowMs(): number;
  /** 1 秒ごと（止めているときは最初の 1 回だけ）に呼ぶ。戻り値で解除する。 */
  every(run: () => void): () => void;
}

export function createDemoClock(
  scenario: Pick<DemoScenario, "cycleSec" | "frozenTimeSec">,
  atSec?: number,
): DemoClock {
  const frozen = scenario.frozenTimeSec(atSec);
  if (frozen === null)
    return {
      frozen: false,
      nowMs: () => Date.now(),
      every(run) {
        run();
        const timer = setInterval(run, 1000);
        return () => clearInterval(timer);
      },
    };
  const fixed = frozen * 1000;
  return {
    frozen: true,
    nowMs: () => fixed,
    every(run) {
      run();
      return () => {};
    },
  };
}

/** 版つきの JSON の筋書き（`src/scenario`）をデモの筋書きにする。 */
export function demoScenarioFrom(json: unknown): DemoScenario {
  const scenario = parseScenario(json);
  return {
    cycleSec: scenario.cycleSec,
    values: (tSec) => evaluateScenario(scenario, tSec),
    frozenTimeSec: (atSec) => frozenTimeSec(scenario, atSec),
  };
}
