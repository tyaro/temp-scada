# 最新の警報の帯（alarmBanner）

作成: 2026-11-17（日本時間）。状態: **実装済み（段階3 3-D2）**。基準は[段階3の警報設計](../runtime/alarm-stage3-design.md)の §7「表示」の `alarmBanner`・§4.4（新しい順）・§4.5（評価不能）。状態の配り方と配色は[警報の小札](alarm-badge.md)（3-D1）と共通。アラーム一覧の窓・ACK（3-E）はまだ無い。

## 目的

画面の上端（運転表示の枠のヘッダーに置く想定）に、いま見るべき警報を 1 件と件数を出す。警報の Engine が動いていない・監視できていないときも空にせず理由を出し、「警報が無い」と読めないようにする。

## 保存の形

画面の `objects` に置く配置で、`shape.type` が `alarmBanner`。schema の `$defs/alarmBannerInstance`（小札と同じく画面の直下だけ。Symbol 定義の `objects` には無いので schema が拒む）。配置は幅・高さ・回転・不透明度（`opacity`）・名前・ロック・表示・フォルダーを持つ。**色（`fill`・`colorAlpha`）は持たない**。

| 項目    | 型       | 意味                                                                    |
| ------- | -------- | ----------------------------------------------------------------------- |
| `style` | 文字書式 | `fontSize`（0 より大きく 512 以下）・`fontWeight`（`normal`・`bold`）。 |

- 指す定義は無い（監視中の全 condition から選ぶ）ので、参照の検査は無い。警報の定義が無い Project にも置ける（その場合は停止中などの理由を出す）。
- 文字を含むので反転できない（`canFlip`）。参照を持たないので、clipboard のコピー・貼り付けも使える（Symbol 定義への貼り付けは拒む）。
- schemaVersion は 0.37.0 を据え置いた。

## 表示の導出

純関数 `apps/banto-scada/src/lib/alarm-banner.ts` の `alarmBannerView(snapshot, 編集中の Project id)`。結果の `kind` と主の文字:

| kind           | 条件                                                                       | 主の文字                                                 |
| -------------- | -------------------------------------------------------------------------- | -------------------------------------------------------- |
| `stopped`      | snapshot が無い                                                            | 警報 停止中（警報の状態を受け取っていません）            |
| `stopped`      | `status` が `running` でない、か Engine が無い                             | 警報 停止中（status のラベル）                           |
| `unmonitored`  | Engine 単位の評価不能（`engine.unavailable`）                              | 警報 監視できていません（未接続・受信の途絶）            |
| `otherProject` | 監視中か適用中の Project id が編集中と違う（小札の `otherProject` と同じ） | 警報 別の Project を監視中です                           |
| `alarm`        | 監視中で、候補がある                                                       | 時刻・名前・メッセージ（復帰・未確認なら「復帰」を前に） |
| `none`         | 監視中で、候補が無い                                                       | 警報なし                                                 |

- status のラベル: notApplied=未適用、noHub=Hub未設定、endpointChanged=接続先が変わりました、noConditions=警報の定義がありません、stopped=停止、terminalUnavailable=端末設定を開けません、alarmDbUnavailable=警報DBを開けません、invalidAppliedDefinition=適用済みの定義が不正です、engineStartFailed=開始できませんでした、engineStopped=Engineが止まりました、authExpired=Hubの認証が切れました（接続し直すと再開します）、connectionFailed=Hubとの通信に失敗しました、alarmDbFailed=警報DBに書けなくなりました、engineFailed=内部エラーで止まりました（この4つは Engine が自ら止まったときの理由。利用者の停止は stopped）、confirmationRequired=切替の確認待ち、switchRecoveryFailed=切替の復旧に失敗しました。未知の文字列はそのまま出す（Engine 単位の理由も同じ）。
- Engine 単位の評価不能のあいだは、選んだ 1 件も件数も出さない（警報が無いように見せず、古い 1 件を最新と見せない）。
- 候補: 表示状態（`alarm-view.ts` の `conditionDisplay`）が `activeUnacked`・`activeAcked`・`returnedUnacked` の condition。発生待ち（Pending）は Normal と同じに扱い、出さない。
- 時刻は `occurredAtMs` の端末のローカル時刻 `M/D HH:mm:ss`、無ければ「—」。名前とメッセージは `applied.displays[condition id]`、表示情報が無ければ名前に condition id を出す。
- 件数「警報 n 件（未確認 k 件）」: n は候補の数、k はそのうち未確認（`activeUnacked`・`returnedUnacked`）の数（下の c の絞り込みの前に数える）。
- 評価不能「評価不能 n 件（主な理由）」: Engine が動いて監視中（`alarm`・`none`）なら、`unavailable` が null でない condition（初期値待ちも数える）が 1 件以上のとき常に添える。主な理由は最多の理由、同数なら enum 順（initialValue・stale・bad・unresolved・noValue・typeMismatch・nonFinite、未知の理由はその後）。ラベル: 初期値待ち・更新停止・不良・未解決・値なし・型不一致・非有限。

### 1 件の選び方

1. 未確認（`activeUnacked`・`returnedUnacked`）があれば、その組だけを残す（確認済みより先）。
2. その組の中で severity の最も高いもの（high > medium > low）だけを残す。severity は `applied.displays[id].severity`、無い・不正は low 扱い。
3. 残った中で、同じ定義（condition id の `:` の前）に上位の限界がある下位を落とす（`hh` が残っていれば `h` を、`ll` が残っていれば `l` を落とす）。
4. 残りを新しい順に並べて先頭を選ぶ: `orderKey`（generation, seq）の降順、同じなら `occurredAtMs` の降順、最後は condition id の昇順（決定的にする）。`orderKey`・時刻が無いものは最も古い扱い。

3 を比較関数に入れず、絞り込みで行う理由: 「同じ定義なら上位の限界を先に、違う定義なら新しい順」を 1 つの比較関数にすると推移律が崩れる。例えば H（新しい）＞別定義の X ＞ HH（古い）と並ぶのに HH ＞ H となり、並べ替えの結果が入力の順に依存する。1・2 で同じ組に残ったものの中で、上位の限界がある下位を先に取り除けば、4 は単純な全順序で済む。上位の限界が 1・2 で落ちた（確認済み・severity が低い）ときは、下位の限界を出す。

## 見た目

色は部品で固定し、Project では変えない。色だけに頼らないよう、`<g role="img">` の `aria-label` と `<title>` に全文（「最新の警報: 主の文字 ／ 件数 ／ 評価不能」）を入れる。

| 表示                                 | 地・枠                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------- |
| 発生中（確認済み）                   | 小札の発生中と同じ severity の地（high 赤・medium 橙・low 黄）と文字色 |
| 未確認（発生中）                     | 発生中と同じ地に、内側に文字色の 2px の枠（点滅なしでも区別できる）    |
| 復帰・未確認                         | 薄い地 `#f9fafb`、severity の濃い色の文字と 3px の枠                   |
| 停止中・監視できていない・別 Project | 小札の「不明」と同じ中間の灰 `#9ca3af` に斜線の模様                    |
| 警報なし                             | 中立の薄い灰 `#f3f4f6`・文字 `#374151`                                 |
| 評価不能 n 件                        | 右端の別の区画。灰 `#d1d5db` の地に破線の枠                            |

- 件数は評価不能の区画の左に右寄せで出す。主の文字は残りの幅に収まらなければ末尾を「…」で省略する（SVG の文字を測る。画面が隠れていて測れないときは枠で切るだけ）。
- 点滅は Project の `alarms.blinkUnacked: true` のときだけ、選んだ 1 件が未確認（発生中・復帰）の間 CSS animation で点滅させる。`prefers-reduced-motion: reduce` では止め、枠の表示だけにする。
- 状態は小札と同じく `alarm-view-state.svelte.ts`（`alarmBannerViewOf`）から読み、編集モード・プレビュー・運転表示のどこで描いても同じ表示になる。

## 編集

- 追加: 部品パネル（オブジェクトの分類）・お気に入り・右クリックの挿入・メニューの「最新の警報の帯を追加」。画面の直下だけで、Symbol 定義の編集中は出さない。警報の定義が無くても置ける。
- 既定: 480×28、文字サイズ 14・標準。
- Inspector（「変更を適用」で確定）: 文字サイズ、文字の太さ。色・不透明度（色）の欄は出さない。
- 編集コマンドは `update` の `alarmBanner`（`style` を置き換える）。

## 検証

- 共通の契約: `examples/alarm-banner-cases.json`（Rust `shared_alarm_banner_contract`、TS `alarm-banner.test.ts`。基は `examples/process.project.json`、`"alarms": null` は `alarms` を外す）。
- 表示の導出・追加・Inspector のフォーム: `alarm-banner.test.ts`。
- ブラウザ: `e2e/alarm-banner.spec.ts`（`alarm-badge.spec.ts` と同じく `main.ts` の `mount` を書き換えてモックの警報 feed を渡す。モックなしの停止中、モックありで未適用→警報なし＋評価不能→HH が新しい H より先→未確認が確認済みより先→severity と新しい順→復帰＋評価不能→長いメッセージの省略→監視できていない→別 Project、点滅と「動きを減らす」。時刻は `timezoneId` を固定）。

## 後続・未対応

- 帯から一覧の窓を開く操作・ACK（3-E）、運転表示の枠のヘッダーへの既定配置。
- 色の Project ごとの変更、文字揃え・複数行。
- Tauri 実機（実 Engine の snapshot）での見た目は未確認。
