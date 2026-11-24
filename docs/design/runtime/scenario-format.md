# 時刻だけで値が決まる筋書きの形（版 1）

状態: **実装済み**（2026-11-24、Issue #389）。評価部は TypeScript の `apps/banto-scada/src/scenario/scenario.ts` と Rust の `crates/scada-scenario`。どちらもこの形だけを読む。共通の試験ケースは `crates/scada-scenario/tests/`。いまは temp-scada の中にあり、上流（banto-industrial。筋書きで動く模擬 PLC の banto-industrial#1335 と同じ形にする）へ移すときは、この 2 か所と試験ケースをそのまま持ち出す。製品のコード（`src/lib`）はこれを使わない。使うのは GitHub Pages のデモ（[デモの案内](../../guides/demo-pages.md)）だけ。

## 目的

同じ筋書きを、画面だけの模擬（ブラウザの中）と、サーバーの模擬（Rust）の両方で評価して、同じ時刻には同じ値を出す。値は時刻（UNIX 秒）だけで決まる。そのため、過去・未来のどの時刻の値も同じに作れ、現在値・警報・履歴が同じ筋書きを共有できる。

## 形

```json
{
  "format": "banto-scenario",
  "version": 1,
  "cycleSec": 180,
  "epochSec": 1767225600,
  "freezeAtSec": 70,
  "signals": {
    "Tank.Level": {
      "kind": "number",
      "points": [
        [0, 40],
        [60, 82],
        [180, 40]
      ],
      "digits": 1
    },
    "Inflow": {
      "kind": "number",
      "base": 62,
      "waves": [{ "amplitude": 34, "periodSec": 180, "shiftSec": 5 }]
    },
    "Inflow2": { "like": "Inflow", "shiftSec": 30 },
    "Hours": {
      "kind": "number",
      "base": 4212,
      "rampPerHour": 1,
      "rampWrap": 1000
    },
    "Pump.Run": { "kind": "bit", "value": true },
    "Lamp": { "kind": "bit", "periodSec": 2, "onSec": 1 }
  },
  "events": [
    { "atSec": 146, "durationSec": 22, "values": { "Pump.Run": false } }
  ]
}
```

| 項目                | 意味                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| `format`・`version` | `"banto-scenario"` と `1`。ほかは読まない                                                         |
| `cycleSec`          | 筋書きが一巡する秒（正の数）                                                                      |
| `epochSec`          | 時刻の基準（UNIX 秒、省くと 0）。周期の中の秒は `(t − epochSec)` を周期で割った余り。ランプの起点 |
| `freezeAtSec`       | 省略可。時刻を止める周期の中の秒（0 以上・周期未満）。止めた時刻は `epochSec + freezeAtSec`       |
| `signals`           | 信号の名前と定義。名前は空にしない                                                                |
| `events`            | 時刻つきの出来事。省略可                                                                          |

数値の信号（`kind: "number"`）の値は、次の順に足す。

1. `base`（省くと 0）
2. `waves` の各項: `amplitude · sin(2π · ((t − shiftSec_信号 − shiftSec_波) mod periodSec) / periodSec)`。sin は周期で余りを取ってから求めるので、大きな時刻でも言語の間で値がずれにくい
3. `points`（周期の中の秒と値の点列）を直線でつないだ値。周期の中の秒は `(t − shiftSec_信号 − epochSec) mod cycleSec`。点の秒は 0〜周期で、戻らない。同じ秒の点を続けると段差になる。最初の点より前は最初の値、最後の点より後は最後の値。点が無ければ 0
4. `rampPerHour · (t − epochSec) / 3600`。`rampWrap` が正なら、この分だけをその値で割った余りにする（運転時間・積算のような、周期で戻らない値）

`digits`（0〜9 の整数）があれば、最後に小数のその桁へ丸める（0.5 は 0 から遠い方）。

ビットの信号（`kind: "bit"`）は、`periodSec` が 0（既定）なら固定の `value`（既定 false）。正なら `(t − shiftSec) mod periodSec < onSec` の間だけ ON。

`like` は別の信号の定義を写し、自分が書いた項目だけを置き換える（対象ごとの位相のずらし・上書き）。`like` は続けてたどれるが、循環は誤り。種類（`kind`）は元と同じでなければならない。

出来事は、周期の中の秒 `atSec`（0 以上・周期未満）から `durationSec`（正・周期以下）の間、`values` の信号を固定の値に置き換える。周期の終わりをまたいでもよい（`atSec + durationSec > cycleSec`）。重なる出来事は、配列で後のものが勝つ。値の種類は信号と同じ（数値の信号に数、ビットの信号に true・false）。出来事の値は丸めない。

知らない項目、範囲を外れた数、無い信号への参照は、読込の誤りにする（TypeScript は `ScenarioError`、Rust は `ScenarioError`）。

## 言語の間の一致

- 余りは `r = x % d; if r < 0 { r += d }` で、両方で同じ手順を取る。丸めは `round(|x| · 10^digits) / 10^digits` に符号を戻す（10 の累乗は表で引く）。
- sin は言語の数学ライブラリの差で最後の桁がずれうる。共通の試験ケースは 1e-9 までの差を許す。丸めの境目のちょうど上で sin がずれると、丸めた値が 1 桁ずれる可能性は残る（試験ケースの時刻では起きていない）。
- 試験ケース（`crates/scada-scenario/tests/cases/*.json`）は、筋書き（`scenario`、または `scenarioFile` で別のファイル）・`frozenTimeSec`・時刻ごとの期待値を持つ。`basics.json` は手で計算した値。`water.json` は Pages のデモの筋書きを TypeScript の評価部で書いた値で、筋書きを変えたら `SCENARIO_BLESS=1 pnpm --filter banto-scada exec vitest run src/scenario` で書き直し、Rust の試験（`cargo test -p scada-scenario`）が同じ値を出すことを確かめる。誤りの例は `tests/invalid.json`。

## 決めていないこと

- 通信の途切れ（banto-industrial#1335 の `hang`）のような、値ではない出来事。版を上げて足す。
- 信号から別の信号を計算する式（例: 液位が 80 を越えたら ON）。版 1 では、しきい値を越える時刻を出来事に書き下す。
