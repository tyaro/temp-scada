# ChronoGazer資産のHistorian／Trend共通利用調査

2026-11-01（日本時間）。状態: **固定sourceの静的調査完了・共通化は未実装**。[P5採用契約](../design/runtime/historian-trend-contract.md)の根拠資料。ソースへのリンクはIndustrial `v0.3.0-alpha.1`の完全rev `33410f6d25d36559c5ce81375e243eb6f3e85038`へ固定した。上流sourceを変更せず、サービスやテストを実行せずに調べた。DB／設定／資格情報を読んで得た運用結果ではない。

## 結論と既存の責務決定

保存／検索crate、時刻grid・世代管理・nullの規律は共有する価値がある。ただしQuality／source／record identityを満たす保存契約と、アプリ依存を外したサービス／UIが必要である。既存値表の拡張だけに限定しない。ユーザー追加指示に従い、不足機能は新たに設計し、SCADAで先行してからChronoGazerへ還元する。ChronoGazerを丸ごとSCADAへコピーする方針にはしない。

固定[scada-design.md §13](https://github.com/tyaro/banto-industrial/blob/33410f6d25d36559c5ce81375e243eb6f3e85038/docs/scada-design.md#L1565)は、ChronoGazerを単体商品として残すこと、保存／検索／Trend資産を共有すること、HubにHistory APIを足さずHubの既定7日backfill用tstoreもSCADAから読まないことを既に定めている。P5はこの境界を具体化する。上流Issue #726のHub API提案をこの設計より優先しない。

## sourceごとの再利用判断

| 資産・根拠                                                                                                                                                                                                                                                                                                                                                                                                                             | 固定sourceで存在する機能                                                                                                                    | 共通化する範囲／不足                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [banto-tstore lib](https://github.com/tyaro/banto-industrial/blob/33410f6d25d36559c5ce81375e243eb6f3e85038/crates/banto-tstore/src/lib.rs)、[config](https://github.com/tyaro/banto-industrial/blob/33410f6d25d36559c5ce81375e243eb6f3e85038/crates/banto-tstore/src/config.rs)、[schema](https://github.com/tyaro/banto-industrial/blob/33410f6d25d36559c5ce81375e243eb6f3e85038/crates/banto-tstore/src/schema.rs)                   | registry非依存のStoreConfig／GroupConfig／TagColumn、自己記述的SQLite。日次と構成変更でrotation。nullable REAL列とptime INTEGER PRIMARY KEY | 保存基盤を共通利用する。Quality、source、source時刻、ingest時刻、同時刻複数record、segment、coverageの保存契約が不足。現行formatをそのまま正本にしない       |
| [writer](https://github.com/tyaro/banto-industrial/blob/33410f6d25d36559c5ce81375e243eb6f3e85038/crates/banto-tstore/src/writer.rs)、[findable](https://github.com/tyaro/banto-industrial/blob/33410f6d25d36559c5ce81375e243eb6f3e85038/crates/banto-tstore/src/findable.rs)、[files](https://github.com/tyaro/banto-industrial/blob/33410f6d25d36559c5ce81375e243eb6f3e85038/crates/banto-tstore/src/files.rs)                        | buffer／flush、壁時計upsert、ファイル日付から検索可能なptime範囲の検証、保持の列挙・計画・削除                                              | findable／rotation／prune規律を共有。時計逆行で既存ptimeを上書きする仕様はSCADAで不採用。複数writer／稼働ファイル直接共有を許す根拠にはならない              |
| [banto-tsquery lib](https://github.com/tyaro/banto-industrial/blob/33410f6d25d36559c5ce81375e243eb6f3e85038/crates/banto-tsquery/src/lib.rs)、[types](https://github.com/tyaro/banto-industrial/blob/33410f6d25d36559c5ce81375e243eb6f3e85038/crates/banto-tsquery/src/types.rs)、[Cargo.toml](https://github.com/tyaro/banto-industrial/blob/33410f6d25d36559c5ce81375e243eb6f3e85038/crates/banto-tsquery/Cargo.toml)                | tstoreに依存するSQLite専用query。read_range、read_decimated、aggregate、catalog。registryを読まずファイルから検索                           | queryを共通利用。PostgreSQL backendは存在すると言わない。Quality／source別集約と新format対応、半開区間adapter、仕事量上限を追加                              |
| [catalog](https://github.com/tyaro/banto-industrial/blob/33410f6d25d36559c5ce81375e243eb6f3e85038/crates/banto-tsquery/src/catalog.rs)                                                                                                                                                                                                                                                                                                 | ファイル内の過去タグunion、groupのearliest／latest。タグ名・単位等は最新の該当ファイルを採用                                                | 削除タグ／移動前group検索の素材。個々の系列の完全coverage、メタデータ有効期間、Hub個体・再作成identityの完成APIではない                                      |
| [collect/history.rs](https://github.com/tyaro/banto-industrial/blob/33410f6d25d36559c5ce81375e243eb6f3e85038/apps/chronogazer/core/src/collect/history.rs)                                                                                                                                                                                                                                                                             | RESTとTauriの共通検証・history関数、初期窓minmax、timeout、現在registryによるtag/group対応                                                  | 上限検証・安全なエラー変換を参考にする。CollectorService／registry依存を外し、Historian catalog／DTOへ置換。serviceを丸ごとimportしない                      |
| [retention.rs](https://github.com/tyaro/banto-industrial/blob/33410f6d25d36559c5ce81375e243eb6f3e85038/apps/chronogazer/core/src/retention.rs)、[engine.rs](https://github.com/tyaro/banto-industrial/blob/33410f6d25d36559c5ce81375e243eb6f3e85038/apps/chronogazer/core/src/engine.rs)                                                                                                                                               | 起動／ローカル日付変更で掃除、設定失敗時に削除しない、active writer保護、stop／join、終了まで排他保持                                       | 純粋な掃除判定とlifecycle契約を共有候補にする。SettingsService／CollectorService／engine接続は各製品adapter。既存app serviceを直接再利用しない               |
| [banto-tagclient types](https://github.com/tyaro/banto-industrial/blob/33410f6d25d36559c5ce81375e243eb6f3e85038/crates/banto-tagclient/src/types.rs)、[handle](https://github.com/tyaro/banto-industrial/blob/33410f6d25d36559c5ce81375e243eb6f3e85038/crates/banto-tagclient/src/handle.rs)、[binding](https://github.com/tyaro/banto-industrial/blob/33410f6d25d36559c5ce81375e243eb6f3e85038/crates/banto-tagclient/src/binding.rs) | 世代整合snapshot、部分解決、値側Quality／source／t、latest watch。Bindingは名前基準でrenameを自動追従しない                                 | Hub購読の共通基盤。Historian専用所有者から周期snapshotに利用可能。全変化lossless feedではなく、恒久的タグidentityの決定もHistorian側で必要                   |
| [banto-collect external.rs](https://github.com/tyaro/banto-industrial/blob/33410f6d25d36559c5ce81375e243eb6f3e85038/crates/banto-collect/src/external.rs)、[task.rs](https://github.com/tyaro/banto-industrial/blob/33410f6d25d36559c5ce81375e243eb6f3e85038/crates/banto-collect/src/task.rs)                                                                                                                                         | external snapshotを周期でsample-and-hold。非Live／Stale等は記録null。ExternalReadingはvalueとqualityのみ。ローカルsimulationのappendを抑止  | スケジューラと薄いsource traitの構造を参考にする。Hub value_sourceを解釈しない現行仕様はSCADA要件と異なり、source／時刻／identityを消さない拡張が必要        |
| [trendLogic.ts](https://github.com/tyaro/banto-industrial/blob/33410f6d25d36559c5ce81375e243eb6f3e85038/apps/chronogazer/src/lib/monitor/trendLogic.ts)、[trendFeed.svelte.ts](https://github.com/tyaro/banto-industrial/blob/33410f6d25d36559c5ce81375e243eb6f3e85038/apps/chronogazer/src/lib/monitor/trendFeed.svelte.ts)                                                                                                           | 固定時刻grid、serverNowMs＋performance.nowの時計、Bad／Stale／失敗でnull、liveFromT以前だけ履歴merge、generationで旧応答拒否                | 純粋なgrid・時計・世代・mergeを共通packageへ抽出候補。独自collectAdmin型やDisplayGroup／threshold型を公共DTO／adapterへ分離。flush watermarkと包絡表示は追加 |
| [TrendPanel.svelte](https://github.com/tyaro/banto-industrial/blob/33410f6d25d36559c5ce81375e243eb6f3e85038/apps/chronogazer/src/lib/monitor/TrendPanel.svelte)、[package.json](https://github.com/tyaro/banto-industrial/blob/33410f6d25d36559c5ce81375e243eb6f3e85038/apps/chronogazer/package.json)                                                                                                                                 | @banto/chartsのLineChart、DisplayGroup等の製品型、--cg色token、Banto6.9.1依存                                                               | 描画基盤と製品adapterを分ける。SCADA6.9.0を勝手に更新せず、公開APIと包絡rendererを確認して共通化する                                                         |
| [historical/+page.svelte](https://github.com/tyaro/banto-industrial/blob/33410f6d25d36559c5ce81375e243eb6f3e85038/apps/chronogazer/src/routes/%28app%29/historical/+page.svelte)                                                                                                                                                                                                                                                       | R2で実装予定と明示したplaceholder                                                                                                           | 長期ヒストリカル画面の完成資産として移植しない                                                                                                               |

## 実装選択の分類

| 分類                | 対象                                                                                                                   | 方針                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 公開契約のまま利用  | 固定SDKのsnapshot／世代／Quality／値側source                                                                           | 周期snapshot方式に限って利用。全変化feedに読み替えない                                 |
| adapter・抽出で利用 | grid／表示時計／旧応答拒否、retentionの純粋判断、ファイルcatalog列挙                                                   | 製品型・設定・theme依存を外し、両製品共通fixtureで確認する                             |
| 新設して後日還元    | record identity、Quality／source付き保存、coverage／watermark、恒久的系列catalog、包絡renderer、長期検索API            | 新しい層と既存crate拡張を比較する。既存制約へ要件を縮めず、SCADA側の新契約を先行できる |
| 直接利用しない      | ChronoGazer app全体、historical placeholder、現在registry依存のHistory service、wall-clock upsertをSCADA正本にする構成 | 責務境界と履歴要件が合わない。共通API経由で必要機能を提供する                          |

新設／拡張の判断基準は、同時刻recordの非破壊保存、Quality／sourceと値の原子的commit、欠測と保持の説明可能性、長期間検索の有限な仕事量、既存ChronoGazerへの影響と移行費用である。共有SQLiteファイル形式への適合は最優先条件にしない。決定前にSCADA内のfake storeとfixtureで契約を検証し、SOAK終了後に共通層の配置とChronoGazer adapterの変更を戻す。既存ChronoGazerのデータを危険な自動変換で新契約へ見せかけない。

## 既存History APIの正確な範囲

`GET /api/collect/history?tagIds=&fromMs=&toMs=&bins=`とTauri `collect_history`は同じ検証とサービス関数を通る。現在値の収集停止中でも履歴を読める。ライフサイクルの操作キューを通さず読取専用queryを使う。

既存の制限は重複除去後8タグ、1時間（3,600,000ms）、2000bins／系列、tags×bins≦8000、検索10秒。範囲は**両端inclusive**。query層の素通しで点数が増える場合も`fit_to_bins`でAPI予算へ収める。これは既存sourceの事実であり、P5で別に採用した半開区間History契約そのものではない。

点は`{tMs,min,max}`。Quality、値側source、元の観測timestampは持たず、非有限・欠測・未記録等がnullに合流する。seriesの`simulation`は現在のregistryの値であり、過去の点ごとのSIM証拠にならない。消されたtagIdはunknownになり、現在のgroupしか引かないので移動前groupの履歴が欠測に見える。自己記述的ファイルcatalogがあることと、このAPIがそれを使って過去identityを解決することは別である。

1時間上限の変更だけでは長期履歴APIにならない。過去catalog、Quality／source、保持とcoverage、検索負荷、期間の分割、設定履歴、壊れたファイルの部分結果を先に設計する必要がある。

## SIMと値の由来で注意する差分

SDKの`ValueEntry`はwireの`tag/v/q/t/value_source`を保持する。既知sourceは`real/simulation/computed/derived_simulation/internal/db`、その他はUnknownである。catalogにもsourceやsimulationフラグがあるが、記録時に値側sourceを上書きする根拠にはしない。

banto-collectの`external.rs`は2026-10-11の決定として、HubからのGood値を**value_sourceに関係なく記録する**と明記する。`task.rs`のsimulation非記録はcollector自身のPLC接続simulationに対するもので、external HubのSIMを除外するものではない。history.rsの「simulation接続は非記録」という説明だけから全経路のSIM排除を推測してはいけない。

したがって既存ファイルの数値を一律realと解釈できず、既存NULLの理由を遡ってQualityやSIMに復元することもできない。新保存契約へ古いファイルを取り込む場合はprovenance不明のlegacy domainとし、本番Good集合へ無条件に混ぜない。移行／互換読取の実装方針はH2で決める。

## Trendの再利用で追加が必要な機能

既存LineChartはカテゴリxを等間隔に描くため、trendLogicは固定時刻gridを使う。serverNowMsを表示時計の基点にして端末のperformance.nowで進め、時計が得られる前は履歴窓を作らない。Bad／Stale／読み取り失敗で線を切り、旧generationの履歴を捨てる構造は共有する。

一方、既存の初期履歴はmin/maxの**中点を一本線**に変換する。山を残す包絡表示はR2へ残されており、boolの中点も実状態ではない。P5の包絡要件はこれから共通rendererに実装する。既存trendFeedの2秒flush graceは通常のflush遅延を見込んだ待機であり、保存成功や境界の完全性の保証ではない。SCADAではpendingFlushとcommit watermarkによる補修が必要になる。

共通packageの候補境界は「型付き系列・grid・時計・coverage・包絡のモデルとrenderer」。ChronoGazer側はDisplayGroup、tagThreshold、collectAdmin、--cg色tokenをadapterへ置き、SCADA側はProjectのTrend属性、Screen／Faceplate呼出、SCADAのtheme tokenをadapterへ置く。package名と配置はSOAK後に両製品の依存方向を確認して確定する。SCADAにアプリsourceを複写して後で共通化する段階は設けない。

## SOAK後に戻す作業

1. 新保存／検索層とtstore／tsquery拡張の比較から版付き記録契約を設計し、既存wall-clock upsert、NULL、保持・findableとの互換範囲を明示する。Quality／source、recordId、segment、coverage、commit位置を一貫して保存・検索できる受入を追加する。
2. Hub購読と周期recorderの共通source境界を作り、ExternalReadingで捨てているsource／時刻を保持する。ChronoGazerの既存SIM方針とSCADAの既定除外を製品ポリシーとして明示し、片方へ黙って統一しない。
3. retentionの純粋判断とlifecycleを共通化し、各製品の設定・排他・診断adapterを維持する。単一writer、停止完了、検索競合、Windows日付境界を検証する。
4. Trendの純粋モデルと包絡rendererを共通化し、ChronoGazerとSCADA双方で同じ契約fixtureを実行する。Banto6.9.1とSCADA6.9.0の差は独立した依存判断とし、今回更新しない。
5. 上流[#725](https://github.com/tyaro/banto-industrial/issues/725)の警報／ACK責務と[#726](https://github.com/tyaro/banto-industrial/issues/726)のHub History API案を現行責務決定へ整合する。今回は読み取りのみでIssueを変更しない。

共有部品の切出し、アプリの移行、実Hub／Windows／本番性能の検証は未実施。[採用契約の次工程と受入](../design/runtime/historian-trend-contract.md#historian-next-steps)に従って別の区切りで実装する。
