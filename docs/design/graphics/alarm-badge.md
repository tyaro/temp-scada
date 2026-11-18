# 警報の小札（alarmBadge）

作成: 2026-11-17（日本時間）。状態: **実装済み（段階3 3-D1）**。基準は[段階3の警報設計](../runtime/alarm-stage3-design.md)の §7「表示」の `alarmBadge`。帯は[最新の警報の帯](alarm-banner.md)（3-D2）。アラーム一覧の窓（3-E）はまだ無い。

## 目的

画面の機器のそばに「HH」「ALM」のような小さな札を置き、指した警報の状態を色と枠で示す。PLC が判定して HH などの bit を立てる案件では、小札が bit の定義を指し、文字に「HH」などを入れる。

## 保存の形

画面の `objects` に置く配置で、`shape.type` が `alarmBadge`。schema の `$defs/alarmBadgeInstance`（`navButton` と同じく画面の直下だけ。Symbol 定義の `objects` には無いので schema が拒む）。配置は幅・高さ・回転・不透明度（`opacity`）・名前・ロック・表示・フォルダーを持つ。**色（`fill`・`colorAlpha`）は持たない**。

| 項目      | 型                           | 意味                                                                         |
| --------- | ---------------------------- | ---------------------------------------------------------------------------- |
| `alarmId` | id                           | 指す警報の定義（`alarms.definitions[].id`）。                                |
| `limit`   | `hh` `h` `l` `ll`（任意）    | しきい値の定義なら必須で、その限界が定義にあること。bit の定義なら持たない。 |
| `text`    | 文字（200 字まで、改行無し） | 札に出す文字。空でもよい。                                                   |
| `style`   | 文字書式                     | `fontSize`（0 より大きく 512 以下）・`fontWeight`（`normal`・`bold`）。      |

- 小札が指す condition の id は、しきい値なら `${alarmId}:${limit}`、bit なら `alarmId`（host の `alarm_project.rs` と同じ）。
- 検査（TS の `parseProject` 経由の `validateAlarmBadges`、Rust の `crates/scada-model/src/alarms.rs` の `validate_badges`）: 指す定義が無い「警報の小札が指す警報の定義が見つかりません」、しきい値で限界が無い、限界が定義に無い「警報の小札が指す限界が警報の定義にありません」、bit で限界がある。
- 編集コマンドも `parseProject` で検査されるので、小札が指す定義の削除や、指している限界を外す・bit へ変える更新は拒否される。警報の設定（`editor/alarm-handler.ts`）は、その前に「この警報は警報の小札で使用中です：画面／小札。先に小札を削除するか、小札が指す警報を変えてください。」と使用中の小札を示す。
- 文字を含むので反転できない（`canFlip`）。
- clipboard（2026-11-18 追加）: コピー・切り取りは、小札が指す警報の定義だけを clipboard の `project.alarms.definitions` に添える（`blinkUnacked` は添えない）。`parseClipboard` は、どの小札も指さない定義や `blinkUnacked` を含む clipboard を「clipboardの警報の定義の形式が不正です」で拒む。貼り付けでは定義を取り込まず、小札は貼付け先の **同じ id** の定義と限界を指す（`alarm-badge.ts` の `assertAlarmBadgePasteTarget`）。無ければ「貼り付け先の Project に、警報の小札が指す警報「T-01 温度 HH」の定義がありません。…」で貼り付け全体を拒む。警報の定義の id は Project 内で振るので、貼り付けられるのはコピー元の Project か、その定義を引き継いだ Project（複製した Project など）。埋込画面と一緒に取り込む画面の中の小札も同じく確かめる。Symbol 定義へは貼り付けない（従来どおり）。
- schemaVersion は 0.37.0 を据え置いた。

## 状態の導出

純関数 `apps/banto-scada/src/lib/alarm-view.ts` の `alarmConditionView(snapshot, 編集中の Project id, condition id)`。host の snapshot は display を送らないので、`scada_alarm::ConditionState::display()` と同じ規則（`active`・`acked`・`timer.kind == "onDelay"`）で導く。

| 状態              | 条件                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unknown`（不明） | snapshot が無い・`status` が `running` でない・Engine が無い・Engine 単位の評価不能（`engine.unavailable`）・監視中か適用中の Project id が編集中と違う・condition が無い |
| `normal`          | Normal と発生待ち（Pending）                                                                                                                                              |
| `activeUnacked`   | 発生中・未確認                                                                                                                                                            |
| `activeAcked`     | 発生中・確認済み                                                                                                                                                          |
| `returnedUnacked` | 復帰・未確認                                                                                                                                                              |
| `unavailable`     | Normal（発生待ちを含む）で condition 単位の評価不能（初期値待ちを含む）                                                                                                   |

- 発生中（未確認・確認済み）で condition 単位の評価不能が重なったら、状態はそのままに `unavailableMark`（「?」の印）を立てる（発生中を隠さない）。
- severity は `applied.displays[condition id].severity`（high・medium・low 以外は捨てる）。
- 画面全体へは、時計と同じくモジュールの $state（`alarm-view-state.svelte.ts`）で配る。`App.svelte` が `alarmSnapshot` と編集中の Project（id・`blinkUnacked`・定義）を書き、小札は編集・プレビュー・運転表示のどこで描いても同じ状態を読む。

## 見た目

色は部品で固定し、Project では変えない。色だけに頼らないよう、`<g role="img">` の `aria-label` と `<title>` に「警報の小札 T-01 温度 HH: 未確認（発生中）」のように状態の文字を入れる（不明は理由付き）。

| 状態               | 地                                                                   | 文字                                                 | 枠・印                                            |
| ------------------ | -------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------- |
| 正常               | 薄い灰 `#f3f4f6`                                                     | 濃い灰 `#374151`                                     | 灰 `#9ca3af`                                      |
| 発生中             | severity（high 赤 `#dc2626`、medium 橙 `#f97316`、low 黄 `#facc15`） | high は白、他は `#111827`                            | severity の濃い色                                 |
| 未確認（発生中）   | 発生中と同じ                                                         | 発生中と同じ                                         | 内側に文字色の 2px の枠（点滅なしでも区別できる） |
| 復帰・未確認       | 薄い `#f9fafb`                                                       | severity の濃い色（`#b91c1c`・`#c2410c`・`#a16207`） | severity の濃い色の 3px の枠                      |
| 評価不能（Normal） | 灰 `#d1d5db`                                                         | `#374151`                                            | 破線の枠と右上の「?」（文字が空なら文字が「?」）  |
| 発生中で評価不能   | 発生中の色                                                           | 発生中の色                                           | 右上に「?」の印を足す                             |
| 不明               | 中間の灰 `#9ca3af` に斜線の模様                                      | `#111827`                                            | `#4b5563`                                         |

- 点滅は Project の `alarms.blinkUnacked: true` のときだけ、未確認の 2 状態（発生中・復帰）を CSS animation で点滅させる。`prefers-reduced-motion: reduce` では止め、枠の表示だけにする。

## 編集

- 追加: 部品パネル（オブジェクトの分類）・お気に入り・右クリックの挿入・メニューの「警報の小札を追加」。画面の直下だけで、Symbol 定義の編集中は出さない。Project に警報の定義が無いときはボタンを無効にし、title と部品パネルの説明に「警報の定義がありません」と出す。
- 既定: 48×24、最初の定義（しきい値なら定義にある最上位の限界 hh→h→l→ll の最初）を指し、文字は限界名（`HH` など）、bit なら「ALM」。文字サイズ 12・太字。
- Inspector（「変更を適用」で確定）: 「警報」（定義名と限界の組を 1 つの select で。例「T-01 温度 HH」）、文字、文字サイズ、文字の太さ。色・不透明度（色）の欄は出さない。
- 編集コマンドは `update` の `alarmBadge`（`type` 以外の全項目を置き換える。`limit` が無ければ外す）。

## モックの警報 feed（e2e）

設計 §5.5 の「IPC の境界でモックの警報 service を差し込めるようにする」。`src/lib/mock-alarm-feed.ts` が `ProjectFileService.alarmFeed` と同じ interface（`AlarmFeed`）を満たす。`App` は `alarmFeed` を props で受け（無ければ `projectFileService?.alarmFeed`）、製品のコードはこのモジュールを import しない。e2e はほかの読取の fixture と同じく、テスト用に `main.ts` の `mount(App, …)` を書き換えて `alarmFeed` を渡し、操作する関数を `window.__bantoAlarmMock` に置く。e2e は `window.__bantoAlarmMock.setSnapshot(snapshot)`（画面に取り直させる）と `emit(change)`（`alarm_changed` 相当）で状態を変える。ヘッダーの「警報を適用」ボタンはデスクトップ版（`projectFiles.native`）だけなので、モックでは出ない。

## 検証

- 共通の契約: `examples/alarm-badge-cases.json`（Rust `shared_alarm_badge_contract`、TS `alarm-badge.test.ts`。基は `examples/process.project.json`）。
- 状態の導出: `alarm-view.test.ts`。追加・Inspector のフォーム・定義の削除と限界の削除の拒否・モックの feed・clipboard のコピーと貼り付け（同じ id の定義へ・定義や限界が無い貼付け先の拒否・余分な定義の拒否）: `alarm-badge.test.ts`。
- ブラウザ: `e2e/alarm-badge.spec.ts`（モックなしで「不明」・定義の無い Project でボタンが無効・指す定義の削除の拒否、モックありで正常→未確認→確認済み→評価不能の印→復帰・未確認→正常→評価不能→Engine 単位の評価不能（不明）→別の Project（不明）、点滅と「動きを減らす」、メニューのコピー・貼り付けと、定義の無い Project への貼り付けの拒否）。

## 後続・未対応

- Symbol 定義の中の小札（設計 §8）、一覧の窓・ACK（3-E）、小札から一覧を開く操作。
- 色の Project ごとの変更、文字揃え・複数行。
- Tauri 実機（実 Engine の snapshot）での見た目は未確認。
