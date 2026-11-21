# 画面に置いたトレンドの常時表示（#359 の続き）

この文書は設計だけで、実装の完了を示さない（2026-11-21・日本時間）。画面に置いたトレンド部品（`TrendPainting`。いまは保存トレンドの名前を出す静的なカードで、押すと HistoryWorkspace を開く）を、Runtime と Editor の運転表示で**常時動く線**にする。部品は banto-industrial の `@banto-industrial/trend`（`trend-v0.1.0`）で、直近は `liveAppend`（ペンごとのリングバッファ）、過去は H1 の履歴、つなぎは `hybridData` と `createBoundaryLoader` が持つ。

[Trend定義の採用契約](historian-trend-definition.md#実装prの順序と受入)の「inline化を再開する時は、同時可視instance数、全体points/bytes、要求fairness、取消中資源、hidden/embedded/Popupの需要集約を先に決める」に、この文書が答える。HistoryWorkspace の単一 controller（active 1・pending 最新 1・1 回 8 系列／8000 点／1 時間）と、[配送制御](historian-history-presentation.md)・[共通部品への置き換え](historian-history-presentation.md#共通部品への置き換え3592026-11-21日本時間)は変えない。

## 1. ペンとタグの対応づけ

### 1.1 許可（出典）

2026-11-21、オーナーが「トレンドのペン（履歴の `seriesId`）と Hub のタグ／記録計画の member を自動で対応づけてよい」と許可した。それまでは次の 2 つで禁止していた。この文書の採用に合わせて両方を改めた。

- [記録計画のProject保存](historian-recording-project.md)の「Trend namespace/series参照とdesired memberIdを自動対応させない」。
- [記録計画](historian-recording-plan.md)の「seriesId/incarnationIdは…外部名/SDK StableTagId/tag_keyから自動導出しない」。

許可は**表示のための対応づけ**に限る。系列の identity（`seriesId`／incarnation／segment）の発行と継続性の確認は、これまでどおり管理側の明示の登録が持つ（§1.4）。「タグの名前が同じだから同じ系列」とは扱わない。

### 1.2 案の比較

| 案                                                 | 内容                                                                                                                                   | 良い点                                                                                                                      | 悪い点                                                                                                                                           |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A. host が適用済みの記録の対応から引く（推奨）** | ペンの `seriesId` を、Recording host が適用済みの mapping（`seriesId` ↔ member の `externalName`・`valueType`・`periodMs`・Hub）で引く | 過去（履歴）と直近（ライブ）が**同じ member** であることを host が保証する。Project の形式を変えない。記録と表示の正が 1 つ | 記録していない系列にはライブが無い（履歴も無いので一貫する）。適用が変わると対応も変わる                                                         |
| B. ペンにタグ（`externalName`）を持たせる          | `TrendPen` に任意の `tag` を足し、ライブはそのタグを購読する                                                                           | 記録なしでもライブだけ描ける                                                                                                | ペンの `seriesId` とタグが食い違い得る（正が 2 つ）。食い違いの検査が結局 A の対応を要る。Project の形式の変更（Rust／TS／サンプル／検証）が要る |
| C. 名前の一致で推測する                            | ペンの名前・`seriesId`・タグ名の文字列の一致                                                                                           | 設定が要らない                                                                                                              | 別 Hub の同名・同名再作成を区別できない。採らない                                                                                                |

**A を採る。** 対応の正は host の適用済み mapping だけで、画面側はその結果を受けるだけにする。B（記録しないタグのライブだけのペン）は需要が出てから別に決める（後続。採るときも A の対応がある系列では A を優先し、食い違いは拒否する）。

### 1.3 対応の作り方（A）

host（`RecordingRuntime`）が `history_context` を作るときと同じ適用済みの計画から、**ライブの対応**を作る。

- 入力: 適用済みの計画の `HistoryCatalog`（`plan_id`・`applied_revision`・member ごとの `seriesId` と identity の `externalName`）。いまの catalog は `(seriesId, externalName)` を `label` として出しているだけなので、ライブ用に `valueType`・`periodMs`・`hubRef`、member の識別に使う activation pin（SDK の stable ID／`tag_key`、Hub の instance）を足す。
- 出力: 系列ごとに `live: { externalName, valueType, periodMs }` か、使えない理由 `liveUnavailable`（§1.4）。HistoryContext に足すか別の文書にするかは L1 で決めるが、**同じ `contextId`（`applied:<revision>`）に束縛**し、別の revision の対応を混ぜない。
- 画面に返すのは外部名と型と周期だけ。Hub の接続先・資格情報・SDK の run_id は返さない（[読取Host](read-host.md)と同じ）。
- 画面側はペンの `seriesId` を、いま受けている context の `series` から完全一致で引く。見つからない・`liveUnavailable` のペンは**履歴だけ**で描き、凡例に理由を出す。

### 1.4 引けないときと継続性

| 場合                                                           | 扱い                                                                                                                                                                                         |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 適用済みの計画が無い・Project の計画 ID と違う（context 無し） | 全ペンが静的カードのまま（いまの表示）。問い合わせを出さない                                                                                                                                 |
| ペンの `seriesId` が context に無い                            | そのペンは「記録の対応なし」。ほかのペンは描く                                                                                                                                               |
| 読取の接続先の Hub が mapping の Hub instance と違う（別Hub）  | `liveUnavailable: hubMismatch`。同名のタグがあっても購読しない。履歴は描く                                                                                                                   |
| 同名の再作成（stable ID／`tag_key` が activation pin と違う）  | `liveUnavailable: continuityUnknown`。そのタグのライブを止め（`liveBreak`）、新しい登録と適用まで戻さない。記録側も既存の契約どおり SDK の run/source の変化で止まるので、過去と食い違わない |
| identity が登録待ち（`identityPending`）                       | 系列がまだ無いので context に出ない（上の「無い」と同じ）                                                                                                                                    |
| 適用の revision が変わった（新しい apply）                     | context を取り直し、全ペンを `liveBreakAll`、履歴も読み直す。旧 revision の応答・サンプルは捨てる（`contextId` の照合）                                                                      |
| 読取が切れた・認証が失効した                                   | 該当のペンを `liveBreak`。再接続後は新しいサンプルから `liveFrom` が始まり、その間は履歴で埋める（§3.3）                                                                                     |

判定は host が持つ（Hub instance と activation pin を知っているのは host だけ）。画面は理由のコードを表示に写すだけで、自分で名前を比べない。

## 2. 画面に複数置いたときの予算

### 2.1 需要の単位と集約

需要は「いま見えているトレンド部品の配置」ごとに登録する。登録の鍵は（Project の object、`contextId`、展開後の配置の経路、`definition.id`）。

- **見えている**とは: Runtime では表示中の主画面・枠（ヘッダー／フッター）・開いている Popup・埋め込み画面の中にあり、表示条件で隠れていない配置。Editor では運転表示（`OperatorView`）の中だけ。編集キャンバスとプレビューの静的な描画は需要を出さない（いまの静的カードのまま）。
- 隠れた（画面の切替・Popup を閉じた・表示条件が偽・埋め込みの親が隠れた）配置は需要を取り下げる。取り下げた配置の問い合わせは論理的に退役し、結果を捨てる。
- **ライブの購読とリングバッファは系列ごとに 1 つ**で、配置どうしで共有する。同じ系列を 2 つの配置が描いても購読は 1 つ。系列の需要が 0 になったら 30 秒の猶予の後にバッファを捨て、購読を外す（画面の行き来で毎回読み直さないため）。
- **履歴は配置ごと**（表示範囲と描画域の幅が配置ごとに違うため）。ただし問い合わせの口は全配置で 1 つ（§2.3）。

### 2.2 上限

| 項目                                     | 上限                                                                      | 根拠・超えたとき                                                                                                                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 同時に動かす配置                         | **4**                                                                     | 5 つ目以降は静的カードに「同時に表示できるトレンドは 4 つまで」と出し、押すと HistoryWorkspace を開く（いまの動作）。順は登録順（主画面の配置順 → 枠 → 埋め込み → Popup を開いた順）。空きができたら待っている最初の配置が入る |
| 配置あたりのペン                         | 定義の 8 本（既存の上限）                                                 | 変えない                                                                                                                                                                                                                       |
| 購読する系列（全配置の合計、重複を除く） | **32**                                                                    | いまの記録計画は member 最大 8 なので実際は 8 以下。上限を超える系列は「ライブの上限」で履歴だけ                                                                                                                               |
| 系列あたりのライブのサンプル             | **20,000**（`retainMs = min(liveRetainMs(windowMs), 20,000 × periodMs)`） | 周期 100 ms なら約 33 分。保持より古い部分は履歴が描く（`hybridData` が `liveFrom` より前を履歴に任せる）                                                                                                                      |
| ライブのサンプルの合計                   | **160,000**（約 8 系列 × 20,000）                                         | `{ tMs, value }` を 1 件 40 バイトと見て約 6.4 MiB。超える分は保持を系列で均等に縮める                                                                                                                                         |
| 履歴の 1 回の問い合わせ                  | 既存の H1 の上限（8 系列・8000 点・1 時間）                               | 配置の全ペンを 1 回にまとめる。区間の数は描画域の横幅（px）と `maxPointsPerSeries` と `floor(8000 / ペン数)` の小さい方                                                                                                        |
| 履歴の結果の保持                         | 配置ごとに直近の 1 件（区間）＋境界の読み直しの結果                       | 1 件の応答は既存の 8 MiB の上限の内。4 配置で最大 32 MiB だが、区間の数は横幅で決まるので実際は数百 KiB                                                                                                                        |

定義の `mode`（raw／minmax）は HistoryWorkspace のためのもので、常時表示は常に minmax の区間で描く（`hybridData` は区間の `{ tMs, min, max }` で、ライブも格子の最小・最大にまとめる）。bool は #376 と同じ 0／1 固定の段線にする。

### 2.3 問い合わせの公平さ

host の `history_query` はもともと 1 件ずつ順に実行する。画面側は**全配置で 1 つの常時表示用の scheduler** を持ち、同時に host へ出す問い合わせを **1 件**にする。

- 待ち行列は配置ごとに最新の 1 件だけ（古い要求は新しい要求で置き換える）。配置の間は**順番（round robin）**で出し、1 つの配置が続けて取らない。
- 境界の読み直し（`createBoundaryLoader` の要求）は小さいので、同じ配置の通常の読み直しより先に出す。ただし配置の順番は守る。`createBoundaryLoader` の `fetch` はこの scheduler を通す。
- **利用者が HistoryWorkspace で明示した検索を優先する。** workspace の要求が待っている間、常時表示の scheduler は新しい問い合わせを出さない（実行中の 1 件は終わりを待つ）。
- 読み直しの間隔の下限: 配置ごとに通常の履歴の読み直しは 30 秒に 1 回まで（切断の後の穴埋め・表示範囲の変更）。`liveFrom` の追い出し（`live.ts` の 1.1 倍でまとめる追い出し）で起きる境界の読み直しは数分に 1 回なので数に入れない。
- 失敗した要求は自動で繰り返さない（`createBoundaryLoader` と同じ。要求の内容が変わったときにだけ読み直す）。

### 2.4 取消中の資源

- 需要の取り下げ・`contextId` の変化・Project の差替えでは、その配置の要求を `AbortController` で取り消し、host にも `history_cancel`（呼出し側の `callId`）を送る。
- **取消を受け付けたが応答が返っていない問い合わせは、settle するまで scheduler の active の 1 枠に数える。** 取消中に新しい問い合わせを足して host の実行待ちを積み上げない（[Trend定義](historian-trend-definition.md#要求の有限性と寿命)の「Abortを無視するsourceのPromiseはsettleまでactive枠に残す」と同じ）。
- 遅れて返った応答は（配置・`contextId`・要求の署名）の照合で捨てる。
- ライブの購読の解除も同じで、Rust 側の stream の join が終わるまで系列の数に数える。

## 3. データの流れ

### 3.1 全体

```
Recording host ── context（seriesId ↔ live の対応、contextId）──┐
                                                                ▼
Hub ─ SDK ─ 読取Host ─ トレンド用 stream（系列ごとのサンプル）─→ 常時表示の controller（画面に 1 つ）
                                                                │  系列ごとの LivePen（liveAppend／liveBreak）
History host ─ history_query ←── scheduler（active 1）←────────┤  配置ごとの履歴（TrendData）と境界の結果
                                                                ▼
                                    配置ごと: hybridData({ history, live, penIds, binMs, boundary, sampleIntervalMs, nowMs })
                                                                ▼
                                                     TrendPainting → TrendChart
```

### 3.2 ライブ（Hub の購読 → `liveAppend`）

- いまの読取の更新（`ReadDisplayUpdate`）は数値 Text と slot の**最新の値だけ**で（bounded latest。途中の値はまとめられる）、Text には時刻が無い。トレンドにはサンプルの時刻が要るので、読取Host に**トレンド用の stream** を足す（L2）。
  - 購読するタグ: §1.3 の対応の `externalName` のうち、需要のある系列だけ。読取Host の要求集合に足し、同じ SDK handle を共有する（外部名の重複排除は既存のとおり）。
  - 1 件: `{ seriesId, tMs: sourceTimestampMs, value: number | null }`。品質が悪い・現在値が無いときは `value: null`（`live.ts` の欠測）。bool は 0／1。
  - 配送は件数と時間でまとめた batch（例: 250 ms ごと、最大 2,000 件）に `sequence` を付ける。キューが溢れたら古い件を黙って捨てず、捨てた系列に**途切れの印**を送る（画面は `liveBreak`）。
  - 読取の session が変わったら（[読取Host](read-host.md)の新 token）、旧 stream の件を捨て、全系列を `liveBreak` する。
- 画面は系列ごとに `liveAppend(pen, samples, { retainMs })` で積む（不変の状態なので `$state.raw` に載せる）。`retainMs` は §2.2 の式。`sampleIntervalMs` は対応の `periodMs` を渡す。

### 3.3 履歴（`hybridData`・`createBoundaryLoader`）

- 配置が需要に入ったら、`[now - windowMs, now)` を minmax で 1 回読む（区間の数は §2.2）。結果は既存の `parseHistoryContract` で検証し、`trend-adapter.ts` で部品の区間へ写す。segment が複数ある系列は #376 の決めどおりペンを分ける。
- 描画は毎秒（と batch の受信のたび、ただし 1 秒に 4 回まで）`hybridData` を作り直す。表示範囲は追従で `[now - windowMs, now)`。
- `boundaryPlan` の要求は `createBoundaryLoader` へ毎回渡し、`fetch` は §2.3 の scheduler を通す。結果は `boundaryValuesFrom` で配置の `boundary` に足し、`pruneBoundary` で要らなくなったものを捨てる。
- **穴埋め**: `liveFrom` が履歴の取得範囲の終わりより後になった（切断・途切れの後）ときは、`[履歴の終わり, liveFrom)` を含むように履歴を読み直す（30 秒に 1 回まで）。記録が追いつく前は穴のまま（線が切れる）で正しい。
- 追従の窓が進んでも、履歴は読み直さない（左端が窓の外へ出るだけ。右はライブが描く）。保持がサンプルの上限で窓より短いときは、`liveFrom` より前の部分を履歴が描く。

### 3.4 どこで動かすか

| 場所                                         | 常時表示 | context の取り方                                                                                                  | 読取                                                |
| -------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Runtime（`RuntimeShell`／`RuntimeOperator`） | する     | `runtime_history_context`（起動時の Project）                                                                     | `runtime_read_start`（Hub 接続後）                  |
| Editor の運転表示（`OperatorView`）          | する     | `history_context`（いま表示している Project。ID・revision・計画 ID の変化で取り直す既存の `createNativeHistory`） | `hub_read_start`（Editor の Hub 接続）              |
| Editor の編集キャンバス・プレビュー          | しない   | —                                                                                                                 | —（静的カードのまま。編集中に問い合わせを出さない） |
| ブラウザ（GitHub Pages のデモ）              | 後続     | デモの history service はあるが、ライブ用の対応が無い                                                             | 模擬の読取。デモで見せるかは別に決める              |

controller は App（Editor）と RuntimeShell にそれぞれ 1 つで、`createNativeHistory` と読取の source を受ける。Editor でも Runtime でも同じ controller を使い、違いは context と読取の取り方だけにする（O0b の「Editor と共用」の作法）。運転表示を閉じる・Project を差し替える・Hub を切るときは controller を止め、需要・購読・問い合わせをすべて退役する。ローカル編集はログイン不要のまま（認証の延期の指示を維持）。

## 4. 実装の区切りと受入

| 区切り | 内容                                                                                                                             | 受入                                                                                                                                                                               |
| ------ | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L0     | この設計と、2 文書の禁止の改訂                                                                                                   | Fable の通しレビュー。現行実装と未実装の区別                                                                                                                                       |
| L1     | host のライブの対応（§1.3・§1.4）。HistoryContext の拡張か別文書かを決め、Rust／TS の schema・生成した検査関数・fixture を揃える | 一時 SQLite の試験で、適用済みの計画から対応が出る・別 Hub／pin の違い／revision の変化で理由が出る・接続先や資格情報が出ない。TS の検査の一致。IPC 試験                           |
| L2     | 読取Host のトレンド用 stream（§3.2）と Tauri の開始・停止の command（Editor・Runtime の区分を `command_list.rs` に足す）         | Rust の試験で、時刻付きの batch・`sequence`・溢れたときの途切れの印・session の変化で旧件を捨てる・需要のある系列だけを購読する。`mode_tests.rs` の照合                            |
| L3     | 画面側の純粋な部品: 需要の登録と集約、§2.2 の上限、§2.3 の scheduler、§2.4 の取消の数え方（`lib/history/` に置く）               | 単体試験: 重複の除去・5 つ目の待ち・空きで入る・round robin・workspace の優先・取消中は枠を空けない・遅れた応答を捨てる・30 秒の猶予                                               |
| L4     | `TrendPainting` の常時表示（`liveAppend`・`hybridData`・`createBoundaryLoader`）を Runtime に入れる                              | Playwright（IPC の mock と模擬の stream）で、線が右へ伸びる・境界がつながる・切断で切れて穴埋めされる・別 Hub／対応なしのペンの理由・5 配置・両テーマ。Runtime の既存の e2e の回帰 |
| L5     | Editor の運転表示、Popup・埋め込み・枠の需要の集約                                                                               | Playwright で、Popup を開く／閉じる・画面の切替・表示条件で需要が出入りし、問い合わせと購読の数が上限を超えない。運転表示を閉じると止まる                                          |
| L6     | 実機の確認（WebView2・実 Hub）                                                                                                   | [実Hub・S7接続計画](../../project/real-hub-connection-plan.md)の接続ができた後に、記録中の系列で 1 時間の常時表示を見て、メモリと問い合わせの数を記録する                          |

各区切りは別の PR にする。L1 と L3 は互いに依らないので並べてよい。L4 は L1〜L3 の後。

## 5. まだ決めないこと

- 記録しないタグのライブだけのペン（§1.2 の B）。
- 1 時間を超える窓（H1 の 1 回の上限を超える問い合わせの分割）。
- 表示範囲の拡大・パン（追従を止める操作）。いまは追従だけ。
- coverage・segment の切れ目・品質の帯（上流の [banto-industrial#1273](https://github.com/tyaro/banto-industrial/issues/1273) を待つ）、ペンの色（[#1272](https://github.com/tyaro/banto-industrial/issues/1272)）。常時表示も HistoryWorkspace の minmax と同じ扱いで、画面にその旨を出す。
- サーバ（S9b 以降）へ移したときの購読の共有。この文書の controller は 1 つの webview の中の予算で、複数の端末の合計は扱わない。
