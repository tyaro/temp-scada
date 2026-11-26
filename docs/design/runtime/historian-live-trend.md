# 画面に置いたトレンドの常時表示（#359 の続き）

この文書は設計だけで、実装の完了を示さない（2026-11-21・日本時間）。画面に置いたトレンド部品（`TrendPainting`。いまは保存トレンドの名前を出す静的なカードで、押すと HistoryWorkspace を開く）を、Runtime と Editor の運転表示で**常時動く線**にする。部品は banto-industrial の `@banto-industrial/trend`（`trend-v0.1.0`）で、直近は `liveAppend`（ペンごとのリングバッファ）、過去は H1 の履歴、つなぎは `hybridData` と `createBoundaryLoader` が持つ。

[Trend定義の採用契約](historian-trend-definition.md#実装prの順序と受入)の「inline化を再開する時は、同時可視instance数、全体points/bytes、要求fairness、取消中資源、hidden/embedded/Popupの需要集約を先に決める」に、この文書が答える。HistoryWorkspace の controller（active 1・pending 最新 1・1 回 8 系列／8000 点／1 時間）はそのままにし、常時表示には別に active 1 の scheduler を置く。App 全体で host に待たせる問い合わせは**合計 2 まで**に改める（§2.3。Trend定義の「active Promise最大1」の文も同じ日に改めた）。[配送制御](historian-history-presentation.md)・[共通部品への置き換え](historian-history-presentation.md#共通部品への置き換え3592026-11-21日本時間)は変えない。

## 1. ペンとタグの対応づけ

### 1.1 許可（出典）

2026-11-21、オーナーが「トレンドのペン（履歴の `seriesId`）と Hub のタグ／記録計画の member を自動で対応づけてよい」と許可した。それまでは次の 2 つで禁止していた。この文書の採用に合わせて両方を改めた。

- [記録計画のProject保存](historian-recording-project.md)の「Trend namespace/series参照とdesired memberIdを自動対応させない」。
- [記録計画](historian-recording-plan.md)の「seriesId/incarnationIdは…外部名/SDK StableTagId/tag_keyから自動導出しない」。

許可は**表示のための対応づけ**に限る。系列の identity（`seriesId`／incarnation／segment）の発行と継続性の確認は、これまでどおり管理側の明示の登録が持つ（§1.4）。「タグの名前が同じだから同じ系列」とは扱わない。

### 1.2 案の比較

| 案                                                 | 内容                                                                                                                                                 | 良い点                                                                                                                                         | 悪い点                                                                                                                                                |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. host が適用済みの記録の対応から引く（推奨）** | ペンの（`historianNamespace`, `seriesId`）を、Recording host が適用して動かしている mapping の member で引き、ライブはその Recorder の観測から受ける | 過去（履歴）と直近（ライブ）が**同じ member・同じ時計・同じ周期**になる。Hub の接続も Recorder のものだけ。Project の形式を変えない。正が 1 つ | 記録していない系列・記録を止めている間はライブが無い（履歴だけ）。適用が変わると対応も変わる                                                          |
| B. ペンにタグ（`externalName`）を持たせる          | `TrendPen` に任意の `tag` を足し、読取Host でそのタグを購読する                                                                                      | 記録なしでもライブだけ描ける                                                                                                                   | ペンの `seriesId` とタグが食い違い得る（正が 2 つ）。読取の値は時刻の正本が履歴と違う（§3.2）。Project の形式の変更（Rust／TS／サンプル／検証）が要る |
| C. 名前の一致で推測する                            | ペンの名前・`seriesId`・タグ名の文字列の一致                                                                                                         | 設定が要らない                                                                                                                                 | 別 Hub の同名・同名再作成を区別できない。採らない                                                                                                     |

**A を採る。** 対応の正は host の適用済み mapping だけで、画面側はその結果を受けるだけにする。B（記録しないタグのライブだけのペン）は需要が出てから別に決める（後続。採るときも A の対応がある系列では A を優先し、食い違いは拒否する）。

### 1.3 対応の作り方（A）

- **先に既存の定義の解決を通す。** 保存トレンドの定義は（`historianNamespace`, `seriesId`）が鍵で、別 namespace の同じ ID は別物（[Trend定義](historian-trend-definition.md)）。画面側は HistoryWorkspace と同じ解決（`lib/history/workspace-model.ts`。定義の namespace と context の `historianNamespace` の一致、ペンの系列が context に全部あること）を通してから対応を引く。namespace が違えば、その配置は**履歴もライブも要求しない**（静的カードに理由）。
- host（`RecordingRuntime`）は `history_context` と同じ適用済みの計画から、系列ごとの**ライブの対応**を作る。いまの `HistoryCatalog` は `(seriesId, externalName)` を `label` として出しているだけなので、`valueType`・`periodMs`・いま記録している segment の ID と単位を足す。
- 出力: 系列ごとに `live: { segmentId, valueType, unit, periodMs }` か、使えない理由 `liveUnavailable`（§1.4）。HistoryContext の schema は `additionalProperties: false` で version 1／2 なので、version 3 にするか別の文書にするかを L1 で決める。どちらでも**同じ `contextId`（`applied:<revision>`）と `historianNamespace` に束縛**し、別の revision・namespace の対応を混ぜない。
- 画面に返すのは識別と型・単位・周期だけ。Hub の接続先・資格情報・SDK の run_id・activation pin は返さない（[読取Host](read-host.md)と同じ）。
- 画面側はペンの `seriesId` を、いま受けている context の `series` から完全一致で引く。`liveUnavailable` のペンは**履歴だけ**で描き、凡例に理由を出す。

### 1.4 引けないときと継続性

| 場合                                                                  | 扱い                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 適用済みの計画が無い・Project の計画 ID と違う（context 無し）        | 全配置が静的カードのまま（いまの表示）。問い合わせを出さない                                                                                                                                                                                                                                                                                                                                                                                                                |
| 定義の namespace が context と違う・ペンの系列が context に無い       | 既存の解決と同じく、その配置は静的カードに理由を出す（部分だけ描かない。HistoryWorkspace の「部分未解決拒否」と揃える）                                                                                                                                                                                                                                                                                                                                                     |
| 記録が止まっている（`Idle`・停止・`ActivationFailed`・`Blocked`）     | `liveUnavailable: recorderStopped`。履歴だけ描く。記録が始まったら新しいサンプルから `liveFrom` が始まる                                                                                                                                                                                                                                                                                                                                                                    |
| 別 Hub・同名の再作成（stable ID／`tag_key` が activation pin と違う） | 既存の契約どおり Recorder が SDK の run/source の変化で止まる。ライブも同じ観測から来るので止まり（`liveBreak`、理由は `recorderStopped`）、新しい登録と適用まで戻らない。画面は名前を比べない                                                                                                                                                                                                                                                                              |
| identity が登録待ち（`identityPending`）                              | 系列がまだ無いので context に出ない（上の「無い」と同じ）                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 適用の revision が変わった（新しい apply）                            | ライブの配送の batch に `contextId` を載せる。画面は持っている `contextId` と違う batch を受けたら、その batch を捨てて context を取り直し、全ペンを `liveBreakAll`、履歴も読み直す。H1 の応答は `contextId` を持たないので、要求の時に控えた `contextId` と現在の値を比べて旧 revision の応答を捨てる。記録が止まっていて batch が来ないときは、Editor は既存の取り直し（Project の ID・revision・計画 ID の変化）、両方とも運転表示を開いたとき・記録の操作の後に取り直す |
| segment が変わった（単位の変更など、記録中の新しい segment）          | そのペンを `liveBreak` し、新しい segment のペンへ積む（§3.4）                                                                                                                                                                                                                                                                                                                                                                                                              |
| ライブの配送が溢れた・画面の購読が切れた                              | 該当のペンを `liveBreak`。その間は履歴で埋める（§3.3）                                                                                                                                                                                                                                                                                                                                                                                                                      |

判定は host が持つ（Hub instance と activation pin を知っているのは Recorder だけ）。画面は理由のコードを表示に写すだけ。計画が disabled でも `HistoryCatalog` は登録済み mapping の系列を出す（過去の記録を読めるように）が、そのときも Recorder は動いていないので `recorderStopped` で、ライブは出ない。ライブは記録している間だけなので、「ライブはあるのに履歴に残らない」区間は生じない。

ライブの値は履歴で既に読める記録と同じもので、見せる範囲は History の照会と同じ（[運用時の認証方針](access-policy.md)の履歴の扱いに従う。新しい権限を足さない）。

## 2. 画面に複数置いたときの予算

### 2.1 需要の単位と集約

需要は「いま見えているトレンド部品の配置」ごとに登録する。登録の鍵は（Project の object、`contextId`、展開後の配置の経路、`definition.id`）。Project の object か `contextId` が変われば登録し直す（旧い鍵の要求は退役）。§2.3 の読み直しの回数の上限は（配置の経路、`definition.id`）で数え、登録し直しても持ち越す（Editor の運転表示の中で Project が変わるたびに上限が戻らないように）。

- **見えている**とは: Runtime では表示中の主画面・枠（ヘッダー／フッター）・開いている Popup・埋め込み画面の中にあり、表示条件で隠れていない配置。Editor では運転表示（`OperatorView`）の中だけ。編集キャンバスとプレビューの静的な描画は需要を出さない（いまの静的カードのまま）。
- 隠れた（画面の切替・Popup を閉じた・表示条件が偽・埋め込みの親が隠れた）配置は需要を取り下げる。取り下げた配置の問い合わせは論理的に退役し、結果を捨てる。
- **ライブの購読とリングバッファは系列（と segment）ごとに 1 つ**で、配置どうしで共有する。同じ系列を 2 つの配置が描いても購読は 1 つ。系列の需要が 0 になったら 30 秒の猶予の後にバッファを捨て、購読を外す（画面の行き来で毎回読み直さないため）。猶予中の系列も §2.2 の系列の数と件数の合計に数える。保持時間は、その系列を描く配置の `windowMs` の最大で決める。
- 窓（ウィンドウ）が隠れている間（`document.hidden`）は `hybridData` の作り直しと描画を止める（ライブの受信と積み上げは続ける）。
- **履歴は配置ごと**（表示範囲と描画域の幅が配置ごとに違うため）。ただし問い合わせの口は全配置で 1 つ（§2.3）。

### 2.2 上限

ライブは Recorder の観測なので、届く間隔は記録周期 `periodMs`（100 ms〜1 時間）より短くならない（§3.2。Hub の更新の速さには依らない）。

| 項目                                     | 上限                                                                                                                                                  | 根拠・超えたとき                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 同時に動かす配置                         | **4**                                                                                                                                                 | 5 つ目以降は静的カードに「同時に表示できるトレンドは 4 つまで」と出し、押すと HistoryWorkspace を開く（いまの動作）。**動いている配置は追い出さない。** 待ちは到着順で、同時に現れた配置（画面の切替）の中は 主画面の配置順 → 枠 → 埋め込み の順。Popup も優先しない（初回。需要が出たら見直す）。空きができたら待っている最初の配置が入る。動いている配置を押したときも HistoryWorkspace を開く |
| 配置あたりのペン                         | 定義の 8 本（既存の上限）                                                                                                                             | 変えない                                                                                                                                                                                                                                                                                                                                                                                         |
| 購読する系列（全配置の合計、重複を除く） | **8**                                                                                                                                                 | いまの記録計画の member の上限（1 group・8 member）と同じ。context の系列（schema では最大 256）がこれを超えるようになったら、需要の到着順で 8 までにし、残りは「ライブの上限」で履歴だけ。計画が広がったら見直す                                                                                                                                                                                |
| 保持時間                                 | `retainMs = liveRetainMs(windowMs)`（窓の 2 倍か 30 分の長い方）                                                                                      | 窓（最大 1 時間）を常にライブで覆うので、初回の履歴の後は追い出しで窓の中に穴ができない                                                                                                                                                                                                                                                                                                          |
| 系列あたりのライブのサンプル             | **ハード上限 80,000 件**（1 時間の窓・100 ms 周期の 2 時間ぶん 72,000 件 × 余裕 1.1 ≒ 79,200 を入れる）。部品の時間の追い出しとは別に、件数を強制する | 部品の `liveAppend` は保持時間の 1.1 倍を超えるまで追い出さないので、時間だけでは件数の上限にならない。包む関数が件数の上限を超えたら、上限の 90% まで先頭をまとめて落とし、`liveFrom` を残った最初の値の時刻に合わせる（部品の `normalize` と同じ規則）。1 件ずつ落とさないので、`liveFrom` が進むのは上限の 10% ぶんごと                                                                       |
| ライブのサンプルの合計                   | 8 系列 × 80,000 件 = **640,000 件**（`{ tMs, value }` を 1 件 40 バイトと見て約 25 MiB）                                                              | 実際は周期 1 秒なら 1 系列 7,200 件。100 ms 周期の 8 系列で 1 時間の窓を出したときだけ上限に近づく                                                                                                                                                                                                                                                                                               |
| 履歴の 1 回の問い合わせ                  | 既存の H1 の上限（8 系列・8000 点・1 時間）                                                                                                           | 配置の全ペンを 1 回にまとめる。区間の数は描画域の横幅（px）と `maxPointsPerSeries` と `floor(8000 / 系列数)` の小さい方                                                                                                                                                                                                                                                                          |
| 履歴の結果の保持                         | 配置ごとに直近の 1 件（区間）＋境界の読み直しの結果                                                                                                   | 1 件の応答は既存の 8 MiB の上限の内。区間の数は横幅で決まるので実際は数百 KiB                                                                                                                                                                                                                                                                                                                    |

定義の `mode`（raw／minmax）は HistoryWorkspace のためのもので、常時表示は常に minmax の区間で描く（`hybridData` は区間の `{ tMs, min, max }` で、ライブも格子の最小・最大にまとめる）。`mode: raw` の定義でも同じで、部品の下に「常時表示は区間の範囲で描きます（観測の点は履歴トレンドで）」と出す。bool は #376 と同じ 0／1 固定の段線にする（順序は §3.4）。記録周期が窓より長い系列は区間が 1 つ以下で線にならないので、凡例に「周期が窓より長い」と出す。

**計算量**: 部品の `liveAppend` は 1 件ごとに配列を写し、`hybridData` は呼ぶたびに全サンプルを格子にまとめ直す。上限の近く（8 系列 × 80,000 件、100 ms 周期）では毎秒の複製が多くなるので、L4 の受入で CPU と GC を測る。目安（主スレッドの占有が平均 10% 以内）を超えたら、件数の上限を下げ、上流へまとめて積む API を求める。

### 2.3 問い合わせの公平さ

host の `history_query` はもともと 1 件ずつ順に実行する。画面側は**全配置で 1 つの常時表示用の scheduler** を持ち、同時に host へ出す問い合わせを **1 件**にする。

- 配置ごとの待ちは、**通常の読み直し 1 件**（新しい要求で置き換える）と、**境界の読み直しを要求の署名（範囲とペン）ごとに 1 件**（ペンの数まで。置き換えるのは同じ署名だけ）。`createBoundaryLoader` は計画の要求を debounce の後に全部同時に `fetch` するので、それを scheduler の待ちに積んで 1 件ずつ出す。合計の待ちは 4 配置 × (1 + 8) = 36 件まで。確定待ちの再試行（§3.3）は、その要求の待ちの 1 件に「この時刻より前に出さない」期限を付けて戻したもので、件数は増えない。期限前の件は順番が来ても飛ばし、次の配置へ進む。
- 配置の間は**順番（round robin）**で、1 回の番に 1 件だけ出す。同じ配置の中では境界の読み直しを通常の読み直しより先に出す（小さく、待つ間その区間が欠測のため）。`createBoundaryLoader` の `fetch` はこの scheduler を通す。
- **利用者が HistoryWorkspace で明示した検索を優先する。** workspace の要求が待っている間、常時表示の scheduler は新しい問い合わせを出さない（実行中の 1 件は終わりを待つ。host は問い合わせを直列に待たせ、1 件の期限は 5 秒）。workspace の検索は利用者の操作ごとに 1 件で、終われば常時表示の順番に戻るので、常時表示が止まり続けることはない。App 全体で host に待たせるのは workspace の 1 件と常時表示の 1 件の合計 2 まで。
- 読み直しの回数の上限: 配置ごとに、通常の履歴の読み直し（§3.3 の穴埋め・確定待ち）は 10 秒に 1 回、合わせて 1 分に 6 回まで。境界の読み直しは `liveFrom` が進んだときだけで、件数の上限で進むのは上限の 10% ぶんごと（100 ms 周期で約 13 分に 1 回）、時間の追い出しで進むのは保持の 10% ぶんごと。
- 失敗した要求は自動で繰り返さない（`createBoundaryLoader` と同じ。要求の内容が変わったときにだけ読み直す）。

### 2.4 取消中の資源

- 需要の取り下げ・`contextId` の変化・Project の差替えでは、その配置の要求を `AbortController` で取り消し、host にも `history_cancel`（呼出し側の `callId`）を送る。
- **取消を受け付けたが応答が返っていない問い合わせは、settle するまで scheduler の active の 1 枠に数える。** 取消中に新しい問い合わせを足して host の実行待ちを積み上げない（[Trend定義](historian-trend-definition.md#要求の有限性と寿命)の「Abortを無視するsourceのPromiseはsettleまでactive枠に残す」と同じ）。
- 遅れて返った応答は（配置・`contextId`・要求の署名）の照合で捨てる。
- ライブの購読の解除も同じで、host 側の配送の終わりが確かめられるまで系列の数に数える。

## 3. データの流れ

### 3.1 全体

```
Recording host ── context（namespace・contextId・系列ごとの live の対応）─┐
     │                                                                   ▼
     ├─ Recorder の観測（tick ごと）─ ライブの配送 ────────→ 常時表示の controller（画面に 1 つ）
     │                                                        │  系列ごとの LivePen（liveAppend／liveBreak、件数の上限）
     └─ History host ─ history_query ←── scheduler（active 1）←┤  配置ごとの履歴（TrendData）と境界の結果
                                                              ▼
                                  配置ごと: hybridData({ history, live, penIds, binMs, boundary, sampleIntervalMs, nowMs })
                                                              ▼
                                                   TrendPainting → TrendChart
```

### 3.2 ライブ（Recorder の観測 → `liveAppend`）

**時刻の正本は履歴と同じ `sampleTimeMs`** にする。既存の履歴表示は `sampleTimeMs`（Historian が tick で snapshot を観測した時刻）を横軸とし、`sourceTimeMs` は診断（[配送制御](historian-history-presentation.md#rawは実sample点だけ)・[Historian／Trend契約](historian-trend-contract.md)）。

- そこで、ライブは読取Host の値（最新の値だけで時刻が無い。値が据え置かれると source の時刻も進まない）ではなく、**Recorder が記録のために観測した同じ snapshot** を host から配送する（L2）。値・品質・`sampleTimeMs`・segment は記録される record と同じで、届く間隔は記録周期になる。Hub の更新が周期より速くても件数は増えない。source の時刻が据え置かれても、観測の時刻は周期ごとに進むので線は右へ伸びる。
  - 1 件: `{ seriesId, segmentId, tMs: sampleTimeMs, value: number | null }`。品質が悪い・無値の record は `value: null`（`live.ts` の欠測）。bool は 0／1。`sourceTimeMs` は送らない（診断は HistoryWorkspace で見る）。batch には記録の `sessionId` と tick の `sequence`（record と同じ記録 session の通し番号）と、その session の最初の `sequence` を載せる。履歴の確定の判定（§3.3）に使う。
  - 時計が逆行した（`clockEpoch` が変わった）ときは、その系列に**途切れの印**を送る（`liveAppend` は前以下の時刻を捨てるため、印なしでは新しい epoch の値が積めない）。
  - **配送は commit が成功した tick だけ**にする（host 側の確定の根拠。commit は記録 session の中で `sequence` の順に進むので、`sequence` が `s` の件を受けた後に始めた H1 の照会は、同じ session の `s` 以前をすべて読める）。commit が失敗した tick は配送せず途切れの印を送る。表示は commit の間隔ぶん遅れる。
  - 配送は tick ごとにまとめた batch に `sequence` を付ける。配送は記録を止めない（受け手が遅くても Recorder の tick を待たせない）。キューが溢れたら古い件を黙って捨てず、捨てた系列に途切れの印を送る（画面は `liveBreak`）。
  - 記録の session が変わった（停止・再開・新しい apply）ときは、旧 session の件を捨て、全系列に途切れの印を送る。
- 画面は batch の件を系列ごとに `liveAppend`（1 件ずつ受ける API。同じ tick の複数の系列は `liveAppendAll`）で積み、§2.2 の件数の上限で包む。状態は不変なので `$state.raw` に載せる。`sampleIntervalMs` は対応の `periodMs` を渡す。

### 3.3 履歴（`hybridData`・`createBoundaryLoader`）

- **順序**: ライブの購読を先に始め、その後に履歴を読む（購読の前に読むと、読んだ終わりと最初のサンプルの間が埋まらない）。
- 配置が需要に入ったら、`[now - windowMs, now)` を minmax で 1 回読む（区間の数は §2.2）。結果は既存の `parseHistoryContract` で検証し、`trend-adapter.ts` で部品の区間へ写す。
- 描画は毎秒（と batch の受信のたび、ただし 1 秒に 4 回まで）`hybridData` を作り直す。表示範囲は追従で `[now - windowMs, now)`。
- `boundaryPlan` の要求は `createBoundaryLoader` へ毎回渡し、`fetch` は §2.3 の scheduler を通す。`fetch` は要求のペン（§3.4 の（`seriesId`, `segmentId`）のペン）を系列へ戻して H1 を 1 区間で読み、応答の segment をペンの segment で絞ってから返す。結果は `boundaryValuesFrom` で配置の `boundary` に足し、`pruneBoundary` で要らなくなったものを捨てる。
- **確定の証拠は coverage の理由ではなく commit watermark**: いまの SQLite の reader は、commit 前の tick を読んだとき record を返さず、coverage を `unknownCoverage`・`watermark` を null にする（`pendingFlush` とは書かない。`crates/scada-historian/src/store/query/tests.rs` の `uncommitted_append_is_absent_and_never_labelled_as_pending_flush`）。そこで coverage の理由で確定を決めない。H1 の系列の結果の `watermark`（`sessionId`・`committedThrough`。[Historian／Trend契約](historian-trend-contract.md)の「記録session／sequenceごとのcommit済み位置」）と、ライブの batch の `sessionId`・`sequence` を比べる。
  - ペンの `liveFrom` の件の `sequence` を `s` とする。応答が `[a, liveFrom)` について**確定**とは、(1) `watermark.sessionId` がライブの session と同じで `committedThrough ≥ s - 1`、または (2) `s` がその session の最初の `sequence`（区間がすべて前の session に入り、今の session で commit を待つ tick が無い）のどちらかで、**かつ要求の `toMs ≥ liveFrom`**。`watermark` は要求の時刻の範囲と無関係に、その系列の最新の session の最後の `sequence` から作られる（`crates/scada-historian/src/store/query/mod.rs`）ので、(1) だけでは、要求の `toMs` と `liveFrom` の間の commit 済みの値が応答に入ったことを示さない。
  - 確定でない応答（`watermark` が null・別 session・`committedThrough` が足りない）は、値があっても最終の結果として扱わない。§3.2 の「commit 後だけ配送」があるので、`liveFrom` の件を受けた後に始めた照会はふつう確定になる。この判定は、照会が commit の前の snapshot を読んだ場合（照会の開始と配送の競合）の守りとして残す。
- **境界の結果がまだ確定していないとき**: loader は成功した要求を読み直さないので、`fetch` の論理の要求は確定するまで settle させない。ただし**待つ間は scheduler の実行枠を持たない**。物理の照会は応答が settle した時点で枠を返し、次の試行は「10 秒後から」の期限付きで同じ配置の待ち（境界の署名の 1 件）に戻す。その間、ほかの配置の照会は順番どおり進む。試行は最大 6 回で、確定しなければ `fetch` を失敗として返し、その区間は欠測のまま（線が切れる）にする。
- **履歴の「確定した終わり」**: 上の証拠で確定した範囲の終わりを使い、**要求の `toMs` を超えない**（要求していない範囲を確定とは扱わない）。H1 の `watermark` 自体は tick の時刻を持たないので、`committedThrough` を時刻に引くのは、画面が受けたライブの件（`sequence` → `sampleTimeMs`）からだけにする。確定の (1)・(2) が成り立てば確定した終わりは `min(liveFrom, toMs)`。`toMs < liveFrom`（初回の照会の `toMs` を決めた後に最初のライブの件が届いた）なら、`[toMs, liveFrom)` は穴として下の穴埋めで読み直す。成り立たず、`committedThrough` の tick の時刻も画面が知らないときは、**何も確定していない**（確定した終わり = 要求の始まり）と扱う。応答の値のある区間の終わりなどから推測しない。とくに全区間が欠測の minmax の応答を、要求の末尾まで確定とは扱わない。`pendingFlush` も確定に含めない（[契約](historian-trend-contract.md)の「pendingFlushは未確定として残す」）。
- **穴埋め**: 理由を問わず、確定した終わりがペンの `liveFrom` より前にある（切断・途切れ・記録の再開の後、件数の上限で `liveFrom` が進んだ後、または初回の応答が確定でない）ときは履歴を読み直す。**読み直すのは、いまの表示窓 `[now - windowMs, now)` 全体を初回と同じ予算（区間の数は §2.2）で 1 回読み、履歴を丸ごと置き換える**。窓の外の穴は追わない（長い停止の後でも、窓 ≤ 1 時間なので 1 回の H1 の上限に収まり、24 時間開いたままの画面でも再開できる）。間隔と回数は §2.3（10 秒に 1 回・1 分に 6 回。確定待ちの再試行と同じく、待つ間は実行枠を持たない）。確定するまで続け、記録が追いつけば埋まる。それまでは穴のまま（線が切れる）で正しい。
  - **穴の部分だけを読んで既存の履歴に結合しない**: いまの H1 の minmax は `[fromMs, toMs)` 全体を点数で等分する（`crates/scada-historian/src/store/query/minmax.rs` の Grid）。既存の [0, 300) を 3 区間で読んだ境界は 0／100／200／300 だが、穴 [100, 250) を 2 区間で読むと 100／175／250 になり、既存の幅と揃わない。始まりを既存の格子へ切り下げても、終わりの端は揃わず、左端が窓の外へ出て 1 時間の上限を超え得る。そこで初版は結合をせず、置き換えだけにする（H1 を変えずに成り立つ）。置き換えた履歴の取得範囲は読み直しの範囲で、境界の結果（`boundary`）は `pruneBoundary` で新しい履歴に合わせて捨て直す。区間を結合する方式は、端の揃わない区間の扱いを決めてから後続で検討する。
  - 置き換えの照会は通常の読み直しの 1 件（新しい要求で置き換える）で、§2.3 の回数の上限に入る。
- 保持時間が窓より長い（§2.2）ので、通常の追従では `liveFrom` より前に窓の左端は来ない。初回の履歴の後は、窓の左端が履歴の範囲の外へ出るだけで、読み直しは要らない（窓の中はライブが描く）。件数の上限で `liveFrom` が窓の中まで進んだとき（上限の計算より周期が短い場合が将来生じたとき）も、同じ穴埋めの規則で表示窓を読み直して置き換える。

### 3.4 segment とペン

#376 の写しは segment が複数ある系列を segment ごとのペンに分ける（いまの ID は `seriesId~番号` で応答の中の順）。部品の `hybridData` は同じペンの ID で履歴とライブを引くので、常時表示では**ペンの ID を（`seriesId`, `segmentId`）から作る**（L4 で写しに選択肢を足す。HistoryWorkspace の表示は変えない）。

- ライブの件は自分の `segmentId` のペンへ積む。いま記録している segment が履歴の応答にまだ無い（記録が始まったばかり・新しい segment）ときは、そのペンを新しく作り、凡例の名前と単位は context の対応から出す。
- segment が変わったら旧 segment のペンのライブは `liveBreak` し、旧 segment の履歴はそのまま残す（線は segment をまたいでつながらない。#376 の決め）。
- **bool の段線の順序**: `hybridData` と `boundaryPlan` には、segment に分けただけの素の区間（`tMs` が整数の ms）を渡す。#376 の `boolSteps`（区間を始め・中・終わりに割り、`tMs` が小数になる）は `hybridData` の**出力**にだけ当てる。先に割ると、境界の要求の `fromMs` が整数でなくなり H1 の要求として不正になるうえ、割った前の小区間が読み直されずに残る。出力に当てれば、ライブの格子と境界の区間も同じ段線になる。

### 3.5 どこで動かすか

| 場所                                         | 常時表示 | context の取り方                                                                                                  | ライブ                                                       |
| -------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Runtime（`RuntimeShell`／`RuntimeOperator`） | する     | `runtime_history_context`（起動時の Project）                                                                     | 同じプロセスの Recording host の配送（記録しているときだけ） |
| Editor の運転表示（`OperatorView`）          | する     | `history_context`（いま表示している Project。ID・revision・計画 ID の変化で取り直す既存の `createNativeHistory`） | 同上                                                         |
| Editor の編集キャンバス・プレビュー          | しない   | —                                                                                                                 | —（静的カードのまま。編集中に問い合わせを出さない）          |
| ブラウザ（GitHub Pages のデモ）              | 後続     | デモの history service はあるが、ライブの対応が無い                                                               | デモで見せるかは別に決める                                   |

ライブは Recorder から来るので、読取Host（Hub の表示用の接続）には依らない。Hub の表示用の接続が切れていても記録が続いていれば線は伸び、表示用の接続があっても記録が止まっていれば履歴だけになる。

controller は App（Editor）と RuntimeShell にそれぞれ 1 つで、`createNativeHistory` とライブの配送の口を受ける。Editor でも Runtime でも同じ controller を使い、違いは context の取り方だけにする（O0b の「Editor と共用」の作法）。運転表示を閉じる・Project を差し替える・Editor で Project を編集して ID・revision・計画 ID が変わるときは、context を取り直し、旧 context の需要・購読・問い合わせをすべて退役する（[Trend定義](historian-trend-definition.md#要求の有限性と寿命)の「Project編集／差替え」と同じ）。ローカル編集はログイン不要のまま（認証の延期の指示を維持）。

## 4. 実装の区切りと受入

| 区切り | 内容                                                                                                                                                                                                       | 受入                                                                                                                                                                                                                                                                                                                                                                 |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L0     | この設計と、2 文書の禁止の改訂                                                                                                                                                                             | Fable の通しレビューとオーナーのレビュー。現行実装と未実装の区別                                                                                                                                                                                                                                                                                                     |
| L1     | host のライブの対応（§1.3・§1.4）。HistoryContext の拡張か別文書かを決め、Rust／TS の schema・生成した検査関数・fixture を揃える（**2026-11-26 実装済み**: 同じ文書の `version: 3` とし、v1／v2 は外した） | 一時 SQLite の試験で、適用済みの計画から対応（segment・型・単位・周期）が出る・記録の停止／revision の変化で理由が出る・接続先や資格情報や pin が出ない。TS の検査の一致。IPC 試験                                                                                                                                                                                   |
| L2     | Recorder の観測のライブの配送（§3.2）と Tauri の開始・停止の command（Editor・Runtime の区分を `command_list.rs` に足す）                                                                                  | Rust の試験で、記録される record と同じ値・`sampleTimeMs`・segment の件・`sequence`・溢れたときの途切れの印・受け手が遅くても tick が遅れない・session と `clockEpoch` の変化で途切れの印・需要のある系列だけを送る。**source の時刻が据え置かれた値でも周期ごとに件が出る**、**source の時計がずれていても `tMs` は観測の時刻**。`mode_tests.rs` の照合             |
| L3     | 画面側の純粋な部品: 需要の登録と集約、§2.2 の上限（件数の上限の包み）、§2.3 の scheduler、§2.4 の取消の数え方（`lib/history/` に置く）                                                                     | 単体試験: 重複の除去・5 つ目の待ち・空きで入る・round robin・workspace の優先と終わった後の再開・取消中は枠を空けない・遅れた応答を捨てる・30 秒の猶予・件数の上限で 90% までまとめて落とし `liveFrom` が残りの最初の値になる・境界の読み直しの回数が §2.3 の内・別 namespace の同じ ID で履歴もライブも要求しない                                                   |
| L4     | `TrendPainting` の常時表示（`liveAppend`・`hybridData`・`createBoundaryLoader`）を Runtime に入れる。写しに（`seriesId`, `segmentId`）のペンの ID を足す                                                   | Playwright（IPC の mock と模擬の配送）で、線が右へ伸びる・境界がつながる・切断で切れて穴埋めされる・**commit 前の読取（`unknownCoverage`・`watermark` null）→ commit 後の読み直しで埋まる**（初回と境界の両方。`pendingFlush` の場合も）・新しい segment が履歴に無いときに新しいペンが出る・記録停止／対応なしの理由・5 配置・両テーマ。Runtime の既存の e2e の回帰 |
| L5     | Editor の運転表示、Popup・埋め込み・枠の需要の集約                                                                                                                                                         | Playwright で、Popup を開く／閉じる・画面の切替・表示条件で需要が出入りし、問い合わせと購読の数が上限を超えない。運転表示を閉じる・Project を編集して revision が変わると止まり、旧結果を出さない                                                                                                                                                                    |
| L6     | 実機の確認（WebView2・実 Hub）                                                                                                                                                                             | [実Hub・S7接続計画](../../project/real-hub-connection-plan.md)の接続ができた後に、記録中の系列で 1 時間の常時表示を見て、メモリと問い合わせの数を記録する                                                                                                                                                                                                            |

各区切りは別の PR にする。L1 と L3 は互いに依らないので並べてよい。L2 は L1 の後（配送する系列と segment を L1 の対応で決める）、L4 は L1〜L3 の後。

表に加えて、各区切りで次も受入に入れる。

- L1: 計画が disabled・適用済みだが未 activation のとき `recorderStopped` になる。namespace が違う context で対応を引かない。
- L2: batch の `sessionId`・`sequence` が記録される record と一致し、H1 の `watermark` と比べられる。commit が成功した tick だけを配送し、失敗した tick は途切れの印になる。一時 SQLite で「未確定（`unknownCoverage`・`watermark` null）→ commit → 配送 → 再取得で確定」を確かめる（mock だけで確定の入口を試さない）。
- L3: 確定の判定（§3.3 の (1)・(2)、`watermark` null・別 session・`committedThrough` 不足、`committedThrough` を時刻に引けないときは何も確定しない、全区間が欠測の応答を末尾まで確定としない、`watermark` が合っていても `toMs < liveFrom` なら確定した終わりは `toMs` で `[toMs, liveFrom)` を読み直す）、**配置 A の確定待ちの間に配置 B の照会が進む**（待つ間は実行枠を持たない）、穴埋めが表示窓全体の読み直しと履歴の置き換えになる（3 時間の停止の後でも 1 回の照会が窓の範囲・1 時間以内、置き換えの後に古い境界の結果が残らない）、保持が窓より短い場合（件数の上限）の穴埋めの読み直しの回数、境界の要求が同じ配置で複数あるときの待ち、猶予中の系列を数に入れる。
- L4: bool の段線（`hybridData` の出力に当てる）、複数 segment、ライブの batch の `contextId` の変化で取り直す、`mode: raw` の定義の注記、ブラウザ（デモ）では静的カードのままの回帰、CPU と GC の計測（§2.2）。
- L5: 運転表示の中で Project が変わる、枠の配置、窓が隠れている間は描画を止める。
- 各区切り: [コード地図](../../engineering/code-map.md)と[実装状況](../../project/implementation-status.md)の更新。形式を変える区切り（L1）は Rust／TS／サンプル／fixture／検証を揃える。

## 5. まだ決めないこと

- 記録しないタグのライブだけのペン（§1.2 の B）。採るなら時刻の正本（読取の値に観測の時刻を付ける）から決める。
- 1 時間を超える窓（H1 の 1 回の上限を超える問い合わせの分割と、定義の schema の `windowMs` ≤ 3,600,000 の変更）。
- 表示範囲の拡大・パン（追従を止める操作）。いまは追従だけ。
- coverage・segment の切れ目・品質の帯（上流の [banto-industrial#1273](https://github.com/tyaro/banto-industrial/issues/1273) を待つ）、ペンの色（[#1272](https://github.com/tyaro/banto-industrial/issues/1272)）。常時表示も HistoryWorkspace の minmax と同じ扱いで、画面にその旨を出す。
- サーバ（S9b 以降）へ移したときの購読の共有。この文書の controller は 1 つの webview の中の予算で、複数の端末の合計は扱わない。
