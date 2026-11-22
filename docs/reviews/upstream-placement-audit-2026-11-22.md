# 上流に置く方がよい実装の精査（2026-11-22）

状態: **調査の記録**。2026-11-22（日本時間）、`work` = `ebe95d80` で、実装済みのコードを上流（Banto v7.10.0、banto-industrial `6a08efbb`・`trend-v0.1.0`）と、ローカルの clone の main（Banto は 2026-11-22 に v7.11.0 を公開済み、banto-industrial は `20a8b464`）に照らした。§1〜§8 は調査の時点の記録で、そのときは起票・置換をしていない。起票の結果は §9 と [起票の記録](upstream-issue-drafts-2026-11-22.md)。Issue の open／closed は `gh` が不安定なため、多くは git log とソースで判断した。

分類:

- **A 上流にもうある → SCADA 側を置き換える**
- **B 汎用で上流に無い → 上流へ移す候補**（SCADA で作ったが、上流のパッケージにある方がよいもの）
- **C 上流の不足・不具合を SCADA が補っている → 上流で直す**
- **D 汎用に見えるが SCADA に残す**

## 1. すぐ動ける置き換え（A）

| 項目                             | SCADA の場所                                                                                        | 上流                                                                                 | 確かめたこと                                                                                     |
| -------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| raw の旧表示                     | `lib/history/RawTrendView.svelte`（372行）                                                          | `@banto-industrial/trend` の `kind: 'samples'`（#1274）                              | `trend-v0.2.0`（2026-11-21、#1278）に入っている。固定は v0.1.0。置き換えるのは描画だけ（下の注） |
| ペンの色の最近傍の枠への変換     | `lib/history/trend-adapter.ts:154-204`                                                              | trend の CSS の色（#1272）                                                           | 同上                                                                                             |
| 記録範囲・未確認区間の帯         | 今は文言だけ（`trend-model.ts` の coverage）                                                        | trend の `timeBands`・`timeMarks`（#1273）                                           | 同上                                                                                             |
| 自前の浮動パネル                 | `designer/controllers/floating-*.svelte.ts`・`floating-panel-layout.ts`・`PanelResizeHandle.svelte` | `@banto/dock-svelte` の `DockWindow` など                                            | D4 で置き換える予定のとおり                                                                      |
| ツリー（レイヤー・プロジェクト） | `designer/LayerTree.svelte`（723）・`controllers/layer-tree.svelte.ts`（634）                       | `@banto/tree-svelte`（v7.10.0 にある、未依存）                                       | 行内の操作・drop の事前判定などは上流に足りない（B と一緒に扱う）                                |
| CSV の直列化・解析               | `hub-tag-csv.ts:87-96`、`equipment-io-csv.ts`                                                       | `@banto/grid-svelte` の `toCsv`・`csvForExcel`・`parseCsv`（v7.10.0 にある、未依存） | 行の配列のまま使えるかは未確認。Shift_JIS の判定と列名の推定は上流に無い（B）                    |
| タグ選択・作業タブ               | `designer/TagPicker.svelte`（442）、`WorkTabs.svelte`                                               | tree-svelte の `TreeSelect`、ui の `Tabs`                                            | 推測。中身は照合していない                                                                       |

**raw の旧表示の置き換えの条件**: `kind: 'samples'` の入力の `Bin` は `tMs`・`min`・`max` だけで、観測の時刻・値・欠測の描画は置き換えられる。一方、`RawTrendView.svelte`（103〜176 行・223〜260 行）は記録のセッション・時計の世代・source の時刻・品質・区間の根拠も出していて、現場の履歴の診断に使う。先に描画だけを部品へ移し、これらの診断の情報をツールチップ・区間の帯・別の表示のどれかに残すことを、旧表示を消す条件にする。

`#1272`〜`#1274` が上流に入ったので、STATUS の「返事待ち」は「`trend-v0.2.0` へ上げて戻す」に変わる。

## 2. SCADA で作ったが、上流のパッケージにある方がよいもの（B）

### Banto

| 項目                                                                                                  | SCADA の場所                                                  | 移す先                                | 手間 |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------- | ---- |
| 複数フォームの適用前検証（全部を先に確かめて 1 回の Undo で適用）                                     | `designer/drafts.svelte.ts`（249）・`form-commands.ts`（436） | `@banto/forms`（#432 の追加要件）     | 大   |
| ツリーの不足（明示の確定・行内の操作・drop の可否を利用側に問う口・IME 中のガード・外からの絞り込み） | `LayerTree.svelte` ほか約1400行                               | `@banto/tree-svelte`                  | 大   |
| CSV の文字コードの判定（Shift_JIS）と列名の推定                                                       | `equipment-io-csv.ts`                                         | `@banto/grid-svelte` の csv           | 中   |
| WCAG の相対輝度・コントラスト比                                                                       | `canvas-colors.ts:15-35`                                      | `@banto/theme` か `charts/core/color` | 小   |
| UTC とローカルの時刻入力の変換                                                                        | `history/time-input.ts`                                       | trend の `core/range.ts`、または ui   | 小   |

### banto-industrial

| 項目                                                        | SCADA の場所                                                                    | 移す先                                                                           | 手間                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------ |
| 警報の状態機械                                              | `crates/scada-alarm`（1237行、入出力なし）                                      | 上流設計 §11.6 の `banto-alarm`。評価の場所を決める Issue #725 は OPEN           | 名前替えだけなら中。先に #725 の決定が要る |
| coverage の投影（記録していない区間を証拠から保守的に出す） | `scada-historian/src/store/query/coverage.rs`・`evidence.rs`                    | `banto-tsquery`（上流は「データのあるファイル」しか持たない）                    | 大。SCADA の保存形式 7 と一体              |
| quality・segment つきの minmax・問い合わせの予算と取消し    | `store/query/minmax.rs`・`control.rs`                                           | `banto-tsquery`                                                                  | 大                                         |
| 時計の逆行の検出・削除の予行・復旧と checkpoint             | `store/retention/clock_guard.rs`・`preview.rs`・`recovery.rs`・`maintenance.rs` | `banto-tstore`（`plan_prune` と同じ考え）                                        | 中〜大                                     |
| 時系列の保存の新形式（同じ時刻の記録・quality・source）     | `store/mod.rs`・`types.rs`                                                      | `banto-tstore` の新形式（`historian-storage-decision.md` で「SOAK 後の還元先」） | 大。ChronoGazer の回帰に注意               |
| 数値の書式・品質の表示名                                    | `tag-presentation.ts:14-60`                                                     | Hub・ChronoGazer・SCADA で別々に作っている。共通の契約を先に決める               | 中。表示が変わる                           |
| SQLite の版の移行（`PRAGMA user_version`）                  | `operation_db.rs:286-370`、`alarm_db.rs`                                        | Banto の `banto-storage` に無い（grep の範囲だけで判断）                         | 中                                         |

## 3. 上流で直してもらうべきもの（C）

### banto-industrial（Hub・tagclient）

| 項目                                                                                                  | SCADA の回避                                                                                                | 確かめたこと                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 購読に heartbeat・配信の連番が無い。順序つきの変更の stream が無い                                    | `alarm_runtime/freshness.rs`（581行）で REST で読み直して生存を確かめる。評価周期より短いパルスは取りこぼす | main にも無い（Hub の grep）                                                                                                                                |
| `WriteRejected` が送る前の拒否（404・409・422・429・501）と送って失敗（502 `write_failed`）を分けない | 表示を「成立していません」にまとめる                                                                        | 固定の rev の `write.rs` で確かめた。main でも同じ                                                                                                          |
| 誤りに `audit_id` が無い                                                                              | 失敗の記録を Hub の監査と突き合わせられない                                                                 | `WriteReceipt` の成功時だけ                                                                                                                                 |
| Hub の安定したサーバー id が無い                                                                      | 接続先を endpoint の文字列の完全一致で見分ける。読み直しの接続を毎回作る                                    | tagclient の `HubStatus` が読むのは `version` と `capabilities` だけ。Hub の `/api/v1/status` は `run_id`（収集の実行の世代）ほかも返すが、設置の id は無い |
| Hub の書込みの制限値を取る API が無い                                                                 | 最小間隔 1 秒を固定値で合わせる                                                                             | —                                                                                                                                                           |

### Banto

| 項目                                                                              | SCADA の回避                           | 確かめたこと                                                       |
| --------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------ |
| 「標準レイアウトに戻す」で divider を取り消すために `arrange` を一瞬 false にする | `App.svelte:486-491`                   | main の CHANGELOG に該当の修正なし。未起票                         |
| `ThreePaneDock` の左のタブの帯が既定の 240px で詰まる                             | 未対応                                 | 未起票                                                             |
| Toast の背景がダークで透ける                                                      | —                                      | `banto.css` の tint が `color-mix(... transparent)`。main でも同じ |
| `--banto-warning` と `--banto-chart-2` が近い橙                                   | —                                      | main でも同じ                                                      |
| メニューを開いたまま F1 でヘルプを開くとメニューが裏に残る                        | `designer-shortcuts.svelte.ts:190-232` | #670 で `closeOpenMenus` が入った。SCADA が使えるかは未確認        |

## 4. 直っていたもの（文書を直す）

- Menu の左のはみ出し（banto#668）: v7.6.0 で修正済み。固定の v7.10.0 に入っている。
- `persistent` の組み替えでフォーカスが外れる件: v7.10.0（#763、`isDockRearranging`）で解決済み。
- スクロール位置が先頭に戻る件（#768）: v7.11.0（2026-11-22）で公開済み。SCADA は v7.10.0 のまま。
- `shortcutAllowed` は削除済みで、上流の `shouldHandleShortcut` を使っている。`implementation-status.md:48` の記述は古い。
- Hub の版・能力の判定は上流の `supports_write_contract()` を使っている（#1224）。

## 5. SCADA に残すもの（D）

- 描画・編集の中核（線・接続・回転・多角形・文字の配置・Renderer・`editor/`）。上流に図形の編集の基盤が無く、置く先が無い。
- 警報の台帳・端末・ブザー、記録計画、host との記録の運用（`recording-*` 約1.1万行）、History の契約、Project のファイル、Tauri の IPC。
- `banto-secret-store`・`banto-safe-root`・`banto-instance-lock` は固定の rev にある。今の Tauri 単独の運用では keyring・`durable.rs`・single-instance で足りる。S9b でサービスにするときに置き換えを検討する。

## 6. 推奨の順序

1. **`@banto-industrial/trend` を `trend-v0.2.0` へ上げる**: 色の変換を消し、coverage の帯を出す。RawTrendView は描画を部品へ移し、診断の情報を残せてから消す（§1 の注）。上流はもう出ているので、すぐ動ける。
2. **Hub・tagclient へ起票する**: `WriteRejected` の分離と `audit_id`、サーバー id。小さく、#311・#312 の前に効く。heartbeat と連番は重いので、別の Issue で相談する。
3. **dock-svelte へ起票する（D3 の前）**: divider の取消しと左のタブの帯。
4. **#725（警報の評価の場所）の残りを決める**: 評価の場所は #533 で決まっている。ACK・履歴の置き場と、`scada-alarm` を移すか残すかを決める。
5. **tree-svelte・forms の不足を起票する**: 置き換えの効果は大きいが手間も大きい。D4 の後でよい。
6. **historian の還元（coverage・新形式）**: SOAK 後の方針どおり。ChronoGazer との共通化と一緒に計画する。

## 7. 上流の Issue との照合（2026-11-22 に `gh issue list --state all` で取得）

### 状態が変わっていたもの（SCADA の記録が古い）

| Issue                                                                    | 状態                                                                                                     | SCADA への影響                                                                       |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| banto#697 ユーザーへ個別に付ける権限（`equipment.operate`・`alarm.ack`） | CLOSED 2026-11-19。v7.7.0 で公開。SCADA の Rust の固定 `9caa238c`（= v7.10.0）に `permissions.rs` がある | **O5 は待ちではなく着手できる**。`operation_write.rs:362` の `TODO(O5)` が残っている |
| banto-industrial#1272・#1273・#1274                                      | CLOSED 2026-11-21。`trend-v0.2.0`                                                                        | §1 のとおり、版を上げて戻す                                                          |
| banto-industrial#1223（Hub が書込み契約を持つか確かめる手段）            | CLOSED 2026-11-19                                                                                        | SCADA は `supports_write_contract()` で使用済み                                      |
| banto#631（共通の 3 ペイン）・#655（ThreePaneLayout の回避 5 点）        | CLOSED                                                                                                   | D2 で `ThreePaneDock` へ移した                                                       |
| banto#668・#669・#670・#671                                              | CLOSED 2026-11-18                                                                                        | §4 のとおり。#670 の `closeOpenMenus` で F1 の手書きの分岐を外せるか確かめる         |
| banto#432〜#438                                                          | CLOSED 2026-10-21                                                                                        | #432（forms）と #433（dock）の採用は D3・D4 で判断                                   |

### 開いていて SCADA に関係するもの

| Issue                                                                      | 内容                                                        | 関係                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| banto-industrial#725 警報の評価をどこで行うか                              | OPEN（調査の時点でコメントなし。2026-11-22 にコメントした） | 2026-10-08 のオーナーの決定（#533）で、Hub は判定しないこと、PLC を正とし、計器に直接つなぐときは記録計・SCADA が判定することは決まっている。ACK・履歴の置き場と実装の Issue は #533 の範囲の外で、まだ決まっていない。閉じるなら、残りの確認か移す先を添える。`banto-alarm` を記録計（ChronoGazer）と SCADA で共有するなら、`scada-alarm` の還元に理由ができる |
| banto-industrial#1231 共通トレンドに足りない要件                           | OPEN                                                        | 常時トレンドの `liveAppend`・`hybridData` の計算量、並列度 1 の fetch は、ここへ足すか別に起票する                                                                                                                                                                                                                                                              |
| banto-industrial#1209 banto-scada のアプリ本体と SCADA Host の着手を決める | OPEN                                                        | temp-scada を industrial へ戻す時期。`scada-alarm`・historian の還元はこれと一緒に決める                                                                                                                                                                                                                                                                        |
| banto-industrial#726 外部 DB の履歴を間引いて読み返す API                  | OPEN                                                        | SCADA の minmax・coverage の還元先と重なる                                                                                                                                                                                                                                                                                                                      |
| banto-industrial#845 接続テストのタグ範囲を品質に反映                      | OPEN                                                        | SCADA の品質の表示名の共通化と関係                                                                                                                                                                                                                                                                                                                              |
| banto#786 ui-settings の条件付き PUT と保存の失敗の再送                    | OPEN                                                        | SCADA の `createSavedSetting` の 11 件に効く。入ったら採る                                                                                                                                                                                                                                                                                                      |
| banto#778 消せない組み込みの Admin、ログインなしの操作をその操作として扱う | OPEN                                                        | SCADA の「開発・初期設定のフェーズはログインなしで書ける」（操作の設計 §11-4）と同じ問題。認証の再開時に合わせる                                                                                                                                                                                                                                                |
| banto#780・#782 dock の「元の場所」の管理                                  | OPEN                                                        | D4（浮動の解禁）の前提。入るまで浮動は止めたままでよい                                                                                                                                                                                                                                                                                                          |
| banto#714 フォームの配置と型                                               | OPEN                                                        | 複数フォームの適用前検証の要件は、ここではなく別に起票する（範囲が違う）                                                                                                                                                                                                                                                                                        |

### 調査の時点で起票されていなかったもの（§2・§3 の候補。起票の結果は §9）

Issue の題で検索して該当が無かった。起票の候補:

- **banto-industrial**: 購読の heartbeat・配信の連番・順序つきの変更の stream／`WriteRejected` の「送る前の拒否」と「送って失敗」の分離と誤りの `audit_id`（#1202 は結果不明と `key_tripped` を分けたが、この 2 つは残った）／Hub の安定したサーバー id／書込みの制限値を `status` で返す／`banto-tstore` の quality・同じ時刻の記録・coverage
- **Banto**: dock の「標準に戻す」と divider の取消し（#433 は閉じているが SCADA に応急処置が残る。再現の手順を添える）／`ThreePaneDock` の左のタブの帯／ダークの Toast の透け／`--banto-warning` と `--banto-chart-2` の近さ／tree-svelte の不足（行内の操作・drop の事前判定・IME）／forms の複数フォームの適用前検証／grid-svelte の CSV の Shift_JIS と列名の推定／`banto-storage` の版の移行／コントラスト比の関数

## 8. Banto v7.11.0（2026-11-22）で変わったこと

v7.10.0 から v7.11.0 で、SCADA が直接使う 5 つのパッケージ（admin-core・dock-svelte・image-assets・theme・ui）のうち中身が変わったのは `@banto/dock-svelte` だけ。forms・tree-svelte も版の番号だけが上がった。SCADA が使っていない grid-svelte は下の表のとおり変わった。`banto-storage`・`banto-admin-services` は変わっていない。

| 変更                                                                              | Issue            | SCADA への影響                                                                       |
| --------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------ |
| `persistent` の pane のスクロール位置を、組み替えとタブの切り替えのたびに戻す     | #768             | D2 で残した問題が直る。版を上げれば SCADA 側の作業はない                             |
| 隠れたパネルを戻すときの位置と比率（外周へ移したパネル、split の `share` のずれ） | #743・#777・#781 | D4（浮動の解禁）と「表示」メニューの前提が強くなる。`ThreePaneDock` の試験も足された |
| 「元の場所」の性質テスト                                                          | #782 の PR1      | #782 の本体（影の木）はまだ OPEN                                                     |
| `BantoGrid` の行の右クリックの口 `onRowContextMenu`                               | #784             | SCADA は grid-svelte を使っていないので、今は影響なし                                |

v7.11.0 でも変わっていないもの: Toast の透け、`--banto-warning` と `--banto-chart-2` の近さ、`ThreePaneDock` の左のタブの帯、divider の取消し（`arrange` の応急処置）、#786・#778。§3 と §7 の起票の候補はそのまま。

SCADA を v7.11.0 へ上げるときは、`apps/banto-scada/package.json` の 5 つのパッケージと、Rust の固定（`crates/scada-host/Cargo.toml` の `9caa238c`）を同じ版にそろえる。Rust の crate は v7.10.0 から変わっていないので、Rust 側は上げなくても動きは変わらない。

## 9. 起票の精査（2026-11-22、ソースで確かめた結果）

§2・§3・§7 の候補を、上流のソース（banto-industrial `20a8b464`、Banto v7.11.0）で 1 つずつ確かめ、「立てる」「既存の Issue にコメントする」「見送る」に分けた。2026-11-22 に起票・コメントした（番号は `upstream-issue-drafts-2026-11-22.md` の冒頭）。

### 立てる

| #   | 上流                               | 題（案）                                                                            | 確かめたこと                                                                                                                                                                                                                                                                       | 効く所                                                                                                                                                   |
| --- | ---------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | banto-industrial（tagclient）      | 書込みの誤りに、Hub が返す理由の code・`audit_id`・`correlation_id` を持たせる      | Hub は誤りの応答の本文に code と `audit_id`・`correlation_id` を入れている（`rest/write.rs:189-196`）。tagclient の `Error` は `kind` だけの `Copy` の型で、それらを捨てる（`error.rs:142`）。そのため 404・409・422・429・501 と 502 `write_failed` が同じ `WriteRejected` になる | 操作の結果の表示と、Hub の監査との突き合わせ。#311・#312 の前                                                                                            |
| I2  | banto-industrial（tagclient）      | Live の間も定期的に `ping` を送り、`pong` が来なければ切れたとみなす                | Hub は `{"op":"ping"}` に `pong` を返す（`stream.rs:755`）。tagclient が `ping` を送るのは Unbound のときだけ（`worker.rs:543`）。on_change の購読は値が変わらなければ何も届かないので、Live の間は無言の停止を見分けられない                                                      | 接続の生存は分かる。値・品質の配信の抜けは pong では分からないので、`freshness.rs`（235〜267 行・339〜346 行）の値・品質の照合は、別の手段が入るまで残す |
| I3  | banto-industrial（Hub・tagclient） | Hub の設置ごとに変わらない id を `status` で返し、tagclient の `HubStatus` に載せる | `/api/v1/status` には `run_id`（収集の実行の世代。設置の id でもプロセスの起動の id でもない）はあるが、設置の id は無い。tagclient の `HubStatus` は `version`・`capabilities` だけを読む（`types.rs:247`）                                                                       | 警報 DB の接続先、書き用キーの組、読み直しの接続の同一性。今は endpoint の文字列の完全一致                                                               |
| B1  | Banto（theme）                     | ダークの Toast の背景が透ける                                                       | ダークの `--banto-*-tint` は `color-mix(... 18%, transparent)`（`css/banto.css:552-556`）で、`ToastHost` はそれをそのまま背景にする                                                                                                                                                | 通知が下の画面に重なって読みにくい                                                                                                                       |
| B2  | Banto（theme）                     | `--banto-warning` と `--banto-chart-2` が両テーマで近い橙                           | ライト `oklch(0.555 0.132 58)` と `#da7306`、ダーク `oklch(0.769 0.165 70)` と `#f48815`（`css/banto.css:339,373,506,514`）                                                                                                                                                        | トレンドの管理線を越えた区間と 2 本目のペン。警報の色                                                                                                    |
| B3  | Banto（dock-svelte）               | 進行中の操作（divider のドラッグなど）を取り消す公開の口                            | `arrange` を false にすると内部で `gesture.cancel('api')` が呼ばれる（`DockHost.svelte:410-420`）。直接の口は無い。SCADA は `arrange` を一瞬 false にして使っている（`App.svelte:486-491`）                                                                                        | 応急処置をやめられる。急がない                                                                                                                           |

### 既存の Issue にコメントする

- **banto#791**（保存してよい配置が確定したことを知らせる口、`dockLayoutStore` のパッケージ化）: 本文が temp-scada の Designer にも触れている。SCADA も 1100px で狭い表示へ切り替えるので、確定前の `layoutSnapshot()` を保存してしまう同じ穴に当たる。**D3 の配置の自動保存は、#791 の口を待つか、入るまで狭い表示の切り替え中は保存しない形にする**。写しの `dockLayoutStore` は作らない。この方針と、SCADA の要件（保存のキーは 1 つ、「標準に戻す」で消す）をコメントする。
- **banto-industrial#725**（警報の評価をどこで行うか）: 評価の場所は 2026-10-08 のオーナーの決定（#533）で決まっている。ACK・履歴の置き場と実装の Issue は残っているので、閉じるなら残りの確認か移す先を添える。`banto-alarm` を記録計と SCADA で共有する crate にする議論へ切り替える案もコメントする。
- **banto-industrial#1231**（共通トレンドに足りない要件）: 常時トレンドの `liveAppend`・`hybridData` の計算量は、L4 で測ってからここへ足す。今はコメントしない。

### 見送る（理由）

- **順序つきの変更の stream（短いパルスを取りこぼさない）**: Hub の on_change は 250ms ごとに現在値を見て差分を送る作り（`stream.rs` の `EVAL_TICK_MS`）で、収集もグループの周期で読む。上流に求めても取りこぼしは無くならない。短いパルスは PLC で保持する、を SCADA の制約として書く。
- **書込みの制限値を返す API**: Hub は超えたとき 429 `rate_limited` を返す。I1 で code が取れれば、SCADA は固定の 1 秒のままでも誤りを正しく出せる。
- **`ThreePaneDock` の左のタブの帯が詰まる**: 今は起票しない。ただし見た目のためだけに `close: false` を使ってはいけない。`close: false` は ✕ を消すだけでなく、`DockHost.setPanelVisible(id, false)` を `refused` にする（v7.11.0 `DockHost.svelte:490-507`）。Designer はこの口でツールバーの操作やプレビューのときにパネルを隠すので、それが壊れる。狭い帯の見た目と、今の表示・非表示の操作を分けて確かめてから、SCADA 側で直すか上流に起票するかを決める。
- **tree-svelte・forms・grid-svelte の CSV・コントラスト比・`banto-storage` の版の移行**: SCADA はこれらのパッケージを使っていない。`banto-contribution-candidates.md` の手順どおり、小さい利用側の fixture で今の API との差を確かめてから起票する。
- **tstore の quality・coverage・新しい保存形式**: SOAK 後の方針どおり、banto-industrial#1209（banto-scada の本体の着手）と一緒に計画する。

### industrial から Banto へ立った Issue（2026-11-22）と SCADA

| Issue     | 内容                                                                            | SCADA への影響                                                                                                                                                                 |
| --------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| banto#790 | `Identity` に再利用されないアカウント ID を載せ、`sessionOwnerKey` をそれで作る | SCADA は今 `sessionOwnerKey` を使っていない。認証の再開時、利用者ごとの UI 設定を持つなら関係する                                                                              |
| banto#791 | 保存してよい配置が確定したことを知らせる口、`dockLayoutStore` のパッケージ化    | **D3 に直接効く**（上のコメントの項）                                                                                                                                          |
| banto#792 | パネルが実際に画面に出ているか（`isOnScreen`）                                  | SCADA の `isVisible` は「閉じていない」の意味で使っていて合っている（`designer-dock.svelte.ts:122`）。常時トレンドなどを dock のパネルの中で「見えている間だけ読む」ときに使う |
| banto#793 | 書込みの handler を接続の切断から切り離して最後まで走らせる                     | 今の SCADA は Tauri だけで HTTP の server を持たない。S9b（scada-server）で要る                                                                                                |
