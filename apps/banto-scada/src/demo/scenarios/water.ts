import {
  piecewise,
  ripple,
  within,
  type DemoScenario,
  type DemoValue,
} from "../scenario";

/**
 * 架空の排水処理設備の筋書き（3 分で一巡）。タグ名は `examples/demo-water.project.json` と
 * 対応する。実在の設備・計測値ではない。
 *
 * - 0〜75 秒: 流入が増えて原水槽の液位が上がる。60 秒で予備ポンプ P-102 が起動し、
 *   液位の H（80 %）・HH（90 %）の警報が出る。
 * - 75〜146 秒: 2 台で送水して液位が下がる。104〜122 秒は P-102 が故障し、下がり方が鈍る。
 * - 146〜168 秒: 液位が L（20 %）を下回り、P-101 が止まる。
 * - 168〜180 秒: 送水を再開し、最初の液位へ戻る。
 */
const CYCLE = 180;
const LEVEL = [
  [0, 40],
  [60, 82],
  [75, 92],
  [85, 90],
  [104, 62],
  [122, 56],
  [146, 19],
  [168, 21],
  [180, 40],
] as const;
/** ポンプ・ブロワーの状態（0=停止、1=運転、2=故障）。 */
const STOP = 0,
  RUN = 1,
  FAULT = 2;
const round = (value: number, digits = 2) => Number(value.toFixed(digits));
const wave = (phase: number, periodSec: number, shiftSec = 0) =>
  Math.sin((2 * Math.PI * (phase - shiftSec)) / periodSec);

export const waterScenario: DemoScenario = {
  cycleSec: CYCLE,
  values(tSec) {
    const phase = ((tSec % CYCLE) + CYCLE) % CYCLE;
    const p101 = within(phase, [0, 146], [168, CYCLE]) ? RUN : STOP;
    const p102 = within(phase, [104, 122])
      ? FAULT
      : within(phase, [60, 104], [122, 140])
        ? RUN
        : STOP;
    const run1 = p101 === RUN,
      run2 = p102 === RUN;
    const feeding = run1 || run2;
    const ph = 7.3 + 1.3 * wave(phase, CYCLE, 20);
    const dosing = ph > 7.8;
    const dissolved = 2.3 + 0.8 * wave(phase, 90);
    const assist = dissolved < 2.0;
    const treated = 50 + 28 * wave(phase, CYCLE, 40);
    const discharging = treated > 52;
    const returning = within(phase, [30, 55], [120, 145]);
    const values: Record<string, DemoValue> = {
      "WWT.Inflow.Flow": round(
        62 + 34 * wave(phase, CYCLE, 5) + ripple(tSec, 1),
        1,
      ),
      "WWT.RawTank.Level": round(piecewise(LEVEL, phase), 1),
      "WWT.P101.State": p101,
      "WWT.P101.Run": run1,
      "WWT.P101.Current": run1 ? round(18.4 + 0.4 * ripple(tSec, 2), 1) : 0,
      "WWT.P101.Hours": round(4212 + ((tSec / 3600) % 1000), 1),
      "WWT.P102.State": p102,
      "WWT.P102.Run": run2,
      "WWT.P102.Fault": p102 === FAULT,
      "WWT.P102.Current": run2 ? round(16.1 + 0.4 * ripple(tSec, 3), 1) : 0,
      "WWT.P102.Hours": round(1876 + ((tSec / 7200) % 1000), 1),
      "WWT.V101.Open": run1,
      "WWT.V102.Open": run2,
      "WWT.Feed.Flowing": feeding,
      "WWT.Feed.Flow": feeding
        ? round((run1 ? 42 : 0) + (run2 ? 36 : 0) + 1.2 * ripple(tSec, 4), 1)
        : 0,
      "WWT.Feed.Pressure": feeding
        ? round(0.31 + (run1 && run2 ? 0.05 : 0) + 0.004 * ripple(tSec, 5), 3)
        : 0.02,
      "WWT.Feed.Total": round((tSec * 0.021) % 1_000_000, 0),
      "WWT.Chem.Level": round(64 + 10 * wave(phase, CYCLE, -45), 1),
      "WWT.P201.State": dosing ? RUN : STOP,
      "WWT.P201.Run": dosing,
      "WWT.React.Level": round(62 + 6 * wave(phase, 60), 1),
      "WWT.React.pH": round(ph + 0.02 * ripple(tSec, 6), 2),
      "WWT.Aer.Level": round(71 + 3 * wave(phase, 90, 10), 1),
      "WWT.Aer.DO": round(dissolved + 0.04 * ripple(tSec, 7), 2),
      "WWT.B301.State": RUN,
      "WWT.B301.Run": true,
      "WWT.B302.State": assist ? RUN : STOP,
      "WWT.B302.Run": assist,
      "WWT.Air.Flow": round((assist ? 24.6 : 12.4) + 0.3 * ripple(tSec, 8), 1),
      "WWT.Clar.Level": round(66 + 4 * wave(phase, CYCLE, 70), 1),
      "WWT.Clar.Sludge": round(1.2 + 0.3 * wave(phase, CYCLE, 100), 2),
      "WWT.V401.Open": returning,
      "WWT.Return.Flow": returning ? round(8.5 + 0.3 * ripple(tSec, 9), 1) : 0,
      "WWT.Treated.Level": round(treated, 1),
      "WWT.Treated.Turbidity": round(
        1.8 + 0.6 * wave(phase, 45) + 0.08 * ripple(tSec, 10),
        2,
      ),
      "WWT.P501.State": discharging ? RUN : STOP,
      "WWT.P501.Run": discharging,
      "WWT.Out.Flow": discharging ? round(64 + 1.5 * ripple(tSec, 11), 1) : 0,
    };
    return values;
  },
};
