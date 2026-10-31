# Historian／Trendの契約

2026-11-01（日本時間）。状態: **P5はPR #14でマージ済み。履歴サービスは未実装**。ユーザー指定によりAstraが主設計を担当した。[SOAK中の開発計画](../../project/soak-independent-runtime-plan.md)のP5を具体化する。[固定sourceの調査と共通利用](../../reviews/chronogazer-historian-reuse.md)を根拠とし、以下の「採用」は今後の実装契約を意味する。共有crateの切出し、Historyサービス、Trend画面の提供完了を意味しない。

H1の具体契約は[版付きJSONとfixture](historian-contract-fixtures.md)、保存方式の比較・復旧設計は[H2に向けた保存決定](historian-storage-decision.md)へ進めた。

## 1. 基準と今回の範囲

Industrial `v0.3.0-alpha.1`、完全rev `33410f6d25d36559c5ce81375e243eb6f3e85038`を静的調査した。SCADAはProject **0.35.0**、Banto **6.9.0**を維持する。P1／P2／P3a／P4はマージ済み。通常Appはofflineで、現在のReadHost／表示DTOは表示用途である。今回Project属性・schema・crate・アプリに実装を追加しない。ユーザー追加指示により、ChronoGazerに不足する契約はSCADA側で新しく設計し、後でChronoGazerへ還元してよい。既存実装への適合を理由に記録品質や検索要件を削らない。

S7 SOAK中はIndustrialへのwrite、Issue更新、実Hub／PLC／DB／設定／資格情報へのアクセス、サービス操作を行わない。ソースを読み、後続の契約と受入を定める。認証、製品transport、本番接続は[再開条件](transport-boundary.md)に従って保留する。

## 2. 責務と寿命

| 所有者               | 採用する責務                                                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Hub                  | 現在値と書込み。タグの解決・値Quality・値のsourceを提供する。History APIは追加しない。Hubのbackfill用tstoreをSCADAから直接読まない |
| SCADA server         | 警報評価、ACK、常時Event／Action、警報／操作イベントの正本。Historian障害を理由に停止しない                                        |
| Historian            | 記録計画の適用、周期記録、時系列の永続化、保持、系列catalog、検索、History API、容量と記録健全性の監視                             |
| Designer／Runtime UI | 記録計画の編集、適用状態の表示、ライブ／履歴Trend。記録の所有者にならず、DBやデータファイルを直接読まない                          |

Historianは論理的に独立させる。初期はSCADA serverと同一プロセスへ同梱できるが、呼出し境界はデータDTOと取消可能な非同期APIにし、DBハンドルやUI状態を渡さない。将来の独立サービスでも同じ契約を維持する。同一プロセスはCPU／メモリ／プロセスクラッシュを物理隔離しない。この制約は検索実行数・メモリ上限・専用保存経路で緩和し、強い可用性が必要なら独立サービスで検証する。

Historianはserver起動時に最後の適用済み計画から起動する。画面の開閉、表示タグの増減、Projectのローカル編集、UI通信切断で記録を開始／停止しない。記録タグ集合は画面の参照集合とは別で、表示されないタグも記録する。警報／操作イベントを時系列サンプルとして再記録しない。Trendへのイベント重畳はserverのイベントAPIとの合成であり、その契約は後続とする。

## 3. 記録設定の所有と配布

以下は将来の設定モデルの意味であり、現行Projectに存在するJSONフィールドではない。

| 設定                                                                                    | 所有者・保存先                     | 契約                                                                                     |
| --------------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------- |
| 記録対象、論理Hub参照、周期、系列の型、記録有効／無効                                   | Projectの記録計画（desired）       | 画面のwidgetと独立。数値／boolを初期対象にする。周期記録のみ、変化時記録・deadbandは後続 |
| Trendのペン、色、期間、軸                                                               | Projectの表示定義                  | ペン追加だけでは記録設定を変更しない。未記録を表示できる                                 |
| endpoint・資格情報参照、論理Hubと実接続の対応、保存先、容量上限、保持日数、writer所有権 | deployment／Historian管理設定      | Projectへ秘密・絶対パスを入れない。保持は初期にはstore単位。タグ別保持は後続             |
| 有効な系列ID対応表、計画hash／revision、適用時刻、記録状態                              | Historianの永続管理情報（applied） | Projectファイル名・revisionだけを同一性の根拠にしない。再起動で復元する                  |

保存と配布を分離する。Projectを開く／保存するだけでは適用しない。管理側が対象deploymentと期待するapplied revisionを付けて計画を配布し、Historianが型、identity、上限、保存先、権限を検証する。競合は拒否し、同じ要求IDと内容の再送は同じ結果にする。新計画の永続化と切替点を記録してからappliedを進める。失敗時は旧appliedを維持し、desiredとの差と安全な理由を表示する。切替時の記録休止があればcoverageに残し、成功応答を偽らない。

初期は計画全体を原子的に適用し、不明identityを含む計画を部分的に成功させない。運転中のタグ消失などは系列ごとの状態に局所化する。停止は明示的な管理要求であり、停止後も既存履歴を検索できる。停止／削除した計画の過去系列と適用履歴を直ちに消さない。

記録計画の適用、接続設定、保持短縮／削除は管理権限、履歴参照は読取権限という能力境界を採用する。SCADA serverの操作監査に変更主体・要求ID・前後revision・結果を残し、Historianは適用結果を返す。具体的な認証方式・role名・匿名閲覧の範囲は未決で、認証延期中に外部公開の管理口を作らない。

保持日数はdeploymentで明示し、未設定のまま本番記録を開始しない。無制限は明示選択と容量監視を必要とする。設定読取失敗時に短い既定値へ倒して削除しない。短縮の適用前に削除対象のプレビューを返し、保存直後に削除を始めず、適用済みポリシーによる掃除で実行する。削除結果・失敗を運用診断へ残す。自動の容量対策で保持期限内データを黙って削除しない。

## 4. 系列identityとメタデータ

Historianが不変の`seriesId`を発行する。外部名は検索／Bindingの名前であり、系列IDではない。接続URLもidentityではない。deploymentで登録する不変の`hubInstanceId`（論理Hubの個体）と、そのHub内タグの継続性を確認した対応表を管理する。複数Projectが同じ系列を参照しても、同じ記録domainに二重writerを作らない。初期はdeploymentが一つの適用済み記録計画を所有し、複数Projectの計画マージは後続とする。

SDK catalogの`ids`／`tag_key`は継続性判断の材料になるが、DB復元・再作成を越える不変性まで今回の調査で保証されたとは扱わない。`run_id`、catalog revision、SDK generationは観測の世代であり、永久タグIDではない。

| 変化                                             | 採用動作                                                                                                                                  |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 外部名rename                                     | 旧名のBindingは自動追従させない。管理者が継続性を確認した明示的再割付なら同じseriesIdへ新名の有効区間を追加。それまで未解決として記録する |
| 削除後に同じ名前を再作成                         | 新しいseriesId。過去系列へ自動連結しない                                                                                                  |
| 別Hubで同じ名前／同じ数値ID                      | hubInstanceIdが違うので別系列                                                                                                             |
| endpoint変更、Hub再起動                          | それだけで系列を変えない。再接続後に対応を照合し、同一性が確認できれば継続。run_id変更は区間境界として残す                                |
| Hub DB復元・ID再利用・継続性を証明できない再接続 | `identityPending`として数値記録を保留し、coverageへ理由を残す。新系列開始か明示的継続かを管理側で決める                                   |
| 型変更／単位・尺度の意味変更                     | 新しい系列segmentを作り、異なる意味の値を一つの集約へ混ぜない。表示名・小数桁だけは有効期間付きメタデータ変更                             |
| 収集group移動／計画から除外                      | 過去の所在をHistorian catalogに保持し、現在のHub registryがなくても過去系列を検索できる                                                   |

削除タグの名前、単位、型、周期、source種別、配置先、記録開始／停止とretentionの履歴を自己記述的に保持する。検索で最新の単位を過去全期間へ上書きしない。過去ファイルのunionを列挙できる`banto-tsquery::catalog`は再利用候補だが、上記の有効期間管理は追加が必要である。

## 5. 初期recorderの記録保証

**初期採用は設定周期で最新snapshotを採るsample-and-hold方式**とする。Historian専用のHub購読所有者が、表示要求に依存せず同一世代snapshotを採る。SDKが判定するLive／Quality／再接続を使い、SCADAでPLC接続やStale判定を複製しない。

現在のReadHostはbounded-latestの表示用watchである。固定SDKの`TagClientHandle`自体もlatest snapshot／watchであり、SDKへ直接接続しても全変化を無損失で受け取る保証にはならない。周期より短いパルスや途中のQuality遷移は失われうる。各tickで読み取った状態を保存する契約とし、全PLCサンプル・全Hub通知の保存、exactly-once配送を約束しない。変更イベントを欠落なく記録する方式にはsource側sequence／replay／durable logの別設計が必要で、後続とする。

初期は遅延tickを追いつきの連続snapshotで捏造せず、飛ばした予定区間を`samplingMissed`にする。安定したGood値が複数tickに続く場合は周期ごとに記録できるが、同じsource時刻を保持し「毎回PLCが再測定した」と解釈させない。表示で作った補間値は記録しない。

### 時刻と重複

| 項目           | 意味                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| `sampleTimeMs` | Historianがtickでsnapshotを観測したUTC epochミリ秒。初期History検索の時間軸                                |
| `sourceTimeMs` | SDK `ValueEntry.t`。Hub値の観測時刻としてそのまま保存。値がない場合はnull。PLC自身の測定時刻とは断定しない |
| `ingestedAtMs` | Historianが記録要求を受領したUTC epochミリ秒。待ち行列・遅延の診断用                                       |
| `recordId`     | 記録session ID＋単調なtick sequence＋seriesIdで一意。保存再試行は同じIDを使う                              |
| `sourceEpoch`  | Hub run_id／catalog revision／SDK世代とseries segmentの対応。世代不整合を検知する情報                      |

スケジュールは単調時計で進め、UTC壁時計の逆行・跳躍を検知して`clockEpoch`境界と診断を残す。時刻を前回値へ丸めたり、source時刻を現在時刻に変造したりしない。同一ミリ秒に複数recordが存在してよい。rawは`sampleTimeMs, recordId`で安定順序とし、同時刻の異なるrecordを勝手に重複削除しない。時刻逆行後のrecordも過去recordを上書きしない。

これは現行tstoreの`ptime INTEGER PRIMARY KEY`＋wall-clock-wins upsertと異なる。`recordId`と時刻の分離、Quality／source／coverageを含む版付き保存契約が成立するまで、現行tstoreをそのままSCADA recorderの正本として採用しない。実現手段は既存crateの拡張に限定せず、新しい保存／検索層をSCADA側で設計し、後日共通化してChronoGazerへ還元する選択を同等に扱う。単に値表と非原子的sidecarを別々に書いても要件を満たさない。transaction／recoveryで対応が保証される保存方式を次工程で選ぶ。

### Quality・source・欠測

rawでは観測したQualityと値側`value_source`を保持する。catalogのSIMフラグや現在の設定から過去のprovenanceを推測しない。未知ラベルは長さ制限のある診断情報として保存できるが、既知sourceへ変換しない。値の公開と集約は次の規則による。

| 観測                                                     | 保存／History値                                                          | 集約                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------- |
| Live＋Good＋有限値、sourceがreal／computed／internal／db | 型付きnumber／bool、実際のQuality／source／時刻                          | 同一segment・同一sourceの有効値だけを対象 |
| Bad／Stale／未知Quality                                  | 値null、観測Qualityと理由を保持                                          | 数値集約から除外し件数・欠測として表示    |
| 未解決、タグ待ち、非Live、値なし、非有限、型不適合       | 値null、各理由を区別。未観測Quality／sourceはnull                        | Goodに補完しない                          |
| simulation／derived_simulation                           | **初期の本番記録では数値を除外**、`simulationExcluded`と観測sourceを保持 | 実値と混ぜない。ライブ表示のSIMとは独立   |
| UnknownSource                                            | 数値を除外し`unknownSource`。元のラベルは制限付き診断                    | real扱い・集約をしない                    |

computed／internal／dbを実機直接値と呼ばない。source変更でsegmentを分ける。boolはfalseを0と混同して消さず、型として保持する。boolのmin/maxは区間にfalse／trueがあったことだけを示し、0.5の中点を実状態として描かない。

SIM数値を検証用に記録する機能は後続であり、本番系列と別domain／seriesId、明示的な選択、全点provenance、別集約を必須にする。初期APIで隠れたopt-inを提供しない。既存banto-collectはローカルsimulationを非記録にする一方、**外部HubのGood値はvalue_sourceを問わず記録する**。SCADAの採用契約はこれと異なり、既存collectorのそのまま利用では満たせない。

## 6. History APIの論理契約

History APIはHistorianの公開境界で、SCADA serverは同梱／gatewayの入口になれる。以下はtransport非依存の要求／結果であり、HTTP path、Tauri command、公開DTO schemaの実装は後続。Hubの`/api/v1/history`を新設する設計ではない。

### 要求と初期予算

`queryHistory`は`seriesIds, fromMs, toMs, mode, maxPointsPerSeries, requestId`を受ける。初期modeは`minmax`と`raw`。avg、帳票、export、1時間を超える検索は後続とし、非対応modeを黙って代替しない。

- UTC epochミリ秒の整数で`fromMs < toMs`、半開区間 **[fromMs, toMs)** を採用する。JS安全整数域と実装の時刻範囲の共通範囲を検証し、差分計算もoverflowさせない。表示timezoneはUIだけの設定。
- 初期上限は重複除去後1〜8系列、1時間、1〜2000点／系列、要求系列数×点数≦8000。これはSCADAの最初のライブTrend初期窓を有限予算で実装・受入するための採用値であり、長期Historianの要求上限ではない。画面幅程度の包絡点と複数ペンを賄い、最初の検索・応答負荷を制限する。ChronoGazerと同じ数値を初期基準にするが、性能実測済みのSCADA保証値ではなくH3で検証する。保存形式と系列catalogには1時間上限を埋め込まず、長期検索のために再保存を要求しない。minmaxの1点は1組の包絡で、minとmaxを各々隠れた追加点とは数えない。status／metadataにも個数・byte上限を持つ。
- minmaxは要求範囲を最大指定数の共通gridへ分割し、各binの`fromMs/toMs`を返す。境界の点は右binだけに属する。ネイティブ周期や既存queryの素通しを理由に点数上限を超えない。
- rawは同じ総点数予算を使う。収まらなければ`tooManyPoints`を返し、切り捨てた結果をcompleteとしない。初期は自動paginationを持たず、期間を狭めるかminmaxを選ぶ。
- サービス内deadlineは受理から結果生成まで最大10秒。検証はファイルアクセス前に行う。クライアント取消は検索へ伝播し、古い応答をUIで破棄する。DB workの解放完了まで実行枠を保持し、取消の連打で裏taskを増やさない。
- 同時実行・待機・走査ファイル・byteを有限に制限する。満杯なら`busy`＋再試行情報を返し、無制限にキューを伸ばさない。具体的な同時実行数等は負荷試験後にdeploymentで決めるが、制限実装は公開前の必須条件。

既存ChronoGazer／tsqueryは両端inclusiveなので、adapterが整数msの`[from,to-1]`へ正しく変換し、さらに返却binと点を半開区間へ整える。単にレスポンスの端点名を変えるだけでは不可。隣接期間の二重計上を契約試験にする。

### 長期間検索の拡張契約

日／月単位の検索はHistorianの必要機能として設計対象に含める。初期実装では未提供と明示し、1時間超の要求をクライアントが無条件に並列分割して制限を回避する方式にはしない。サービスは`capabilities`として対応mode、最大期間、最大系列・点数、利用可能な解像度、raw上限、結果byte上限、snapshot有効期限を返す。初期の公開値は上記予算で、長期実装時はデータ量別の走査ファイル／行数／CPU時間の予算とともに更新する。UIは非対応期間を選択不能または明示エラーにし、短い期間へ黙って縮めない。

長期minmaxでも全期間を一度にraw展開せず、partition索引と必要なら事前集約を使い、最終応答の点数を同じ有限予算に収める。事前集約もQuality／source／segment／欠測件数とmin/maxを保持し、平均値だけから包絡を再生成しない。raw保持と集約保持を別にする場合は解像度と期限を応答に明示し、集約しか残っていない区間をrawと呼ばない。保存形式の選択ではこの追加が可能なmetadataと索引境界を確保する。

期間を分割／ページ化するときは、サービス発行のquery snapshot IDと不透明cursorへ要求hash、系列segment、commit位置、grid原点、retention catalog版を束縛する。各chunkは半開区間で重ならず、同じbin境界と読取基準を保つ。新しいcommitを途中ページへ混ぜない。snapshotを保持できなくなった場合は`snapshotExpired`として再開始を要求し、異なるsnapshotの結果をcompleteへ接合しない。検索中にretentionが進む場合のpin時間も有限にし、履歴queryが削除を無期限に止めない。長いqueryは取消可能なjob方式も候補にするが、APIのjob化・実際の期間上限・性能目標はH6で確定する。

長期検索の受入では、日／月境界を跨ぐconfig変更・source変更・保持削除を含むfixtureを用い、単一snapshotの結果と分割した結果のmin/max・有効件数・coverageが一致すること、取消で仕事が止まること、snapshot失効が検知されることを確認する。

### 応答・集約とcoverage

全体結果は`ready | partial | invalidRequest | unavailable | busy | cancelled`を区別する。`ready`は検索が正常に完了した意味であり、無欠測やrecorder稼働を意味しない。各要求seriesIdに、同じ順序で結果または`unknownSeries`等の状態を返す。系列ごとの解決・検索がすべて正常に結論できればreadyとする。全件unknownSeriesでもready内の系列結果で不存在を示し、全件unrecorded／expiredでもready内のcoverageで説明する。これらをサービス障害のunavailableへ変換しない。I/O／破損／timeoutなどによるqueryUnavailableが一部にあり、他の系列は値・不存在・coverageを正常に回答できた場合はpartialとし、失敗系列だけを再要求できる。全要求系列がこの技術的障害で回答不能ならunavailable。timeoutを空履歴のreadyとして返さない。

返却には正規化した要求、query snapshot ID、生成時刻、系列メタデータ／segment、記録状態、coverage、読取可能範囲、commit watermarkを含める。サービス内部エラーの絶対パス、接続先、資格情報は公開せず、安全な理由codeと相関IDを返す。

minmax binは`min/max`、有効件数、無効理由別件数、観測Quality／sourceの要約、coverage状態を持つ。数値が一つもなければ両端null。GoodとBadが同居するbinはGood値だけの包絡を返せるが`partialCoverage`と無効件数を必須にし、完全なGood区間として線を連結しない。同じbinがsource／型／単位／clockEpochの境界をまたぐ場合は`mixedSegment`で数値包絡を返さず、境界を明示してズームを促す。混在値を一つの山にすることは採用しない。件数は保存された周期観測数であり、Hubの全通知件数ではない。

coverageは次を区別する。広い範囲は区間として圧縮し、bin要約へ反映する。上限を超える細部は`detailTruncated`を明記し、既知の欠測を完全区間に変えない。

| 状態                                               | 意味・表示                                                                   |
| -------------------------------------------------- | ---------------------------------------------------------------------------- |
| `unrecorded`                                       | 適用履歴から、その期間は記録計画の対象外だったと分かる                       |
| `expired`                                          | 保持ポリシーと削除記録から削除済みと分かる。単なる古い空ファイルで推測しない |
| `pendingFlush`                                     | 受理済みだがquery snapshotに未commitの記録がある。欠測確定にしない           |
| `sourceUnavailable`／Quality等                     | 保存済みの無効観測や既知の切断区間                                           |
| `recorderStopped`／`samplingMissed`／`storageLoss` | 停止・tick未実行・保存失敗など、記録側の既知の不連続                         |
| `unknownCoverage`                                  | crashなどで範囲・理由を確定できない。補間しない                              |
| `queryUnavailable`                                 | ファイル破損、アクセス不能、timeout等。データなしとは異なる                  |

watermarkは単なる最大timestampではなく、**記録session／sequenceごとのcommit済み位置**と、query snapshot時点で検索できる区間を返す。clock逆行時に最大UTC値まで完全だと主張しない。commit済みはDBの設定されたcommit保証であり、停電耐性まで自動的に保証しない。電源断耐性・fsync方針は別受入事項とする。

保持掃除と検索が競合してファイルが消えた場合も、読めなかった部分を空として成功させない。query snapshotのファイルpin／読取lease、または限定再試行後にpartial/unavailableとする。具体的な手段は共有保存層で選ぶが、応答の意味は変えない。

## 7. ライブと履歴のhandoff

ライブTrendは現在値表示の一時バッファであり、履歴保存の証明ではない。履歴とライブの出所をUI状態とtooltipで区別する。初期窓、再接続、範囲変更では次の手順を採用する。

1. Project／deployment／系列集合／期間／gridの組にUI session tokenを付け、ライブを先に購読する。同一性確認後の最初のライブgrid境界を`liveFromT`として保持する。旧sessionの履歴・ライブは適用しない。
2. Historianの時計情報を基準に窓を作り、端末の単調経過時間で表示時計を進める。端末壁時計で履歴時刻を補正しない。HubとHistorianの時計差が検出された場合は境界不確かを表示し、source時刻をsample時刻へ読み替えない。
3. 初期履歴を`[windowStart, liveFromT)`へ要求し、`liveFromT`以降のライブを上書きしない。gridのまたがるbinは切り分けて要求／再集約し、同じbinを二重描画しない。初期履歴が失敗してもライブは継続する。
4. `pendingFlush`は未確定として残す。commit watermarkが進んだ後、重複する狭い窓を再要求して履歴側だけを補修する。固定2秒待機でflush完了を保証しない。再試行に上限・backoff・取消を持たせる。
5. ライブ切断、Bad／Stale、世代不整合は線を切る。再接続時は旧値を延長せず、系列対応を再確認して新しいライブ区間を始める。切断中にHistorianが記録できていれば、その閉じた区間を履歴として取得できるが「ライブが連続していた」とは見せない。
6. 閉じたライブ区間を正式履歴へ切り替えるときは、確定したquery snapshotとsegment対応を検証して区間単位で交換する。現在追記中の区間へ遅い履歴を混ぜない。時計逆行では旧切替境界を再利用せず、新clockEpochとして再同期する。

包絡の山を残す表示を初期Trendの受入条件とする。min/maxを中点一本線に潰さない。カテゴリ等間隔チャートを使う場合は共通gridへ載せ、欠測の補間と追加間引きによる山の消失を防ぐ。包絡rendererの共通化とBanto6.9.0での対応確認ができるまで、ChronoGazerのTrendPanelを完成部品として取り込まない。

## 8. 保存・障害分離と運用

保存先ごとにwriterを一つに限定し、プロセスをまたぐ排他も持つ。初期は単一hostの排他を採用し、複数端末からの計画適用は同じ管理ownerがrevision比較で直列化する。旧ownerの停止／join完了前に新ownerへ書込み権限を渡さない。将来の複数host failoverではleaseだけで旧writerを止めたと見なさず、storeが古いfencing tokenのappendを拒否する契約を追加する。それが成立するまで自動failover／active-activeを提供しない。ChronoGazerとSCADAが同じデータディレクトリを別writerとして開く運用や、ネットワーク共有上のSQLiteファイルをUI／別サービスが直接共有する運用は採用しない。共通化するのはcrateと契約であり、稼働中データファイルの所有権ではない。

保存と検索は別の実行予算・キューを持ち、履歴queryがHub購読や警報評価を待たせない。容量不足／I/O失敗時はHistorianをdegradedにし、ライブ・警報・Actionを継続する。boundedな受理キューが満杯なら記録を捨てた区間・件数を診断し、`storageLoss`を残す。診断自体を書けないcrash／disk fullでは再起動後にunknownCoverageとする。無制限retryや過去値の補間で穴を隠さない。

初期はメモリキュー／flush前のデータ損失を許容する周期記録であり、永続spoolによる配送保証は後続。記録要求の受理と永続化完了を分け、再試行はrecordIdで冪等にする。停止は購読停止→受理停止→期限付きflush→writer／retention taskのjoinの順とし、失敗／時間切れを正常停止と報告しない。未完了taskがある間はwriter排他を解放しない。

保持は起動時と保存先のローカル日付変化時に掃除する契約を共通利用候補とし、保存先timezoneをdeploymentで固定する。API時刻はUTCのまま。active writerファイルを保護し、日付rotation・設定変更rotation・clock逆行・DSTで検索可能性を失わせない。現行tstoreのfindable契約を壊さず、新しい保存形式で検証する。

監視項目はapplied計画、系列ごとの解決状態、最終tick／commit、commit遅延、キュー使用率、落とした記録数、最終保存失敗、容量／保持掃除結果、query拒否数とする。History unavailableをライブ切断や警報復帰と混同しない。プロセス再起動／電源断／Windowsサービスの運用保証は後続受入で決める。

<a id="historian-next-steps"></a>

## 9. 次工程・未決と再開条件

P5の完了は本契約、source根拠、共通化境界、下記の受入・未決が揃うこと。以下は未実装の後続工程であり、P5完了をそれらの完了と読み替えない。

| 順序                       | 次の成果物                                                                                                                | 着手条件／未決                                                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1 契約fixtureと保存設計   | raw／minmax／coverage／identity／時刻のRust・TS共通fixture、保存方式の比較とtransaction／recovery設計                     | SOAK中でもSCADA内の純粋なモック設計・実装は可能。DTOの具体的名称、metadata上限、周期の許容範囲を確定する                                                                                           |
| H2 共有保存・検索層        | 新保存／検索層またはtstore／tsquery拡張によるrecordId、Quality／source、segment、coverage、watermarkとChronoGazer還元計画 | SCADA内の新設計・モック実装は独立して進められる。上流変更・共通部品切出し・ChronoGazer移行はSOAK終了後。版付きformat／既存ファイル読取方針を決める。古いNULLからQualityやSIMを復元したことにしない |
| H3 Historian core          | 計画適用、専用周期recorder、検索、retention、障害診断をUI非依存で実装                                                     | H1／H2の契約成立。Hubの個体／タグ継続性、queue／容量／fsync方針と数値予算を受入で確定                                                                                                              |
| H4 共通TrendとSCADA widget | grid／時計／merge／包絡rendererを共通化し、SCADA属性adapterを接続                                                         | Banto6.9.0での機能確認と依存整理。ChronoGazer全体をコピーしない。SCADA内fixture表示は実Hubなしで可能                                                                                               |
| H5 製品host／運用受入      | transport、認証、管理権限、deployment、実Hub接続、サービス化                                                              | P3bと認証の再開条件を満たし、SOAK対象の作業制約解除後。実Hub／PLC／DB／資格情報を扱う具体的な範囲を確定                                                                                            |
| H6 長期検索                | 日／月単位の期間選択、partition／索引、段階的minmax、期間別の予算と取消、保持境界                                         | 長期履歴は必要な後続機能。H3でデータ量・期間・応答時間目標を具体化し、新検索層も比較する。初期1時間制限をそのまま最終仕様にしない                                                                  |
| 拡張                       | 永続spool／全変化記録、SIM別domain、CSV／avg／帳票、複数Project計画統合、外部DB                                           | 初期受入後の別工程。PostgreSQL採用やHistory APIのHub移設を暗黙に含めない                                                                                                                           |

上流[#725](https://github.com/tyaro/banto-industrial/issues/725)は警報評価とACKの置場が未決だった整理を、SCADA server決定へ整合させる必要がある。[#726](https://github.com/tyaro/banto-industrial/issues/726)のHub History API案は今回採用せず、Historian API境界としてSOAK後に再整理する。2026-11-01（日本時間）の読み取り時点で両Issueはopen。今回はIssueを更新していない。

## 10. 後続実装の受入ケース

以下は**実装時に実行する受入**であり、今回実行済みの試験ではない。

| ケース                                                           | 合格条件                                                                                      |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| UIを閉じる／表示タグを外す／別Projectを編集する                  | applied計画の記録が継続し、画面が一つもなくても履歴が増える                                   |
| 不正計画、競合revision、同じ適用要求を再送、切替中crash          | 旧applied維持または一意に新applied復元。部分計画・二重writer・適用成功の誤表示なし            |
| rename／同名再作成／同名の複数Hub／Hub DB復元                    | 明示対応以外で系列を接続せず、identityPendingと新系列を区別する                               |
| group移動／タグ削除／単位変更                                    | 過去catalogから検索でき、異なる意味のsegmentを同じ集約へ混ぜない                              |
| Good 0／false、Bad、Stale、未知Quality／source、SIM・derived SIM | 0／falseを保持。無効理由とsourceを保持し、既定SIM数値の除外、Goodへの推測補完なし             |
| 一つのbinにGood／Bad、source変更、bool両状態                     | 部分coverageと件数。mixedSegmentは数値null。bool 0.5を実状態として描かない                    |
| 同一msの2record、同ID再試行、時計逆行／跳躍                      | 異なるrecordを保持し同IDだけ冪等化。既存過去値の上書き・時刻捏造なし                          |
| 高速変化・tick遅延・Hub切断／再起動                              | 周期記録の限界を明示し、取り逃しをlosslessと称さない。samplingMissed／不連続を表示            |
| 境界上の点、隣接2窓、UTC日付とローカル日付／DST                  | [from,to)で二重計上なし。rotation後も検索に漏れない                                           |
| 8系列／2000点／総8000点の境界と超過、巨大metadata                | 上限内のみ成功。raw超過は明示拒否。応答サイズ・検索仕事量とも有限                             |
| query timeout／取消／過負荷／一部ファイル破損                    | 枠が解放され、partial／unavailable／busyを区別。ライブと警報の処理が継続                      |
| 未記録／期限削除／recorder停止／query停止                        | 空のreadyにまとめずcoverage・サービス状態を区別。停止後も保存済み履歴を取得可能               |
| flushを2秒以上遅らせる／後からcommitする                         | pendingFlushを欠測確定にせず、watermark進行後に境界を補修。ライブ区間を遅い履歴で上書きしない |
| 履歴応答中にProject・系列・期間変更／再接続                      | 旧tokenを拒否し、旧値の持越し・二重点・架空の連続線なし                                       |
| 一点の鋭い山を含むminmax・画面resize                             | 包絡を保持。中点化やチャート追加間引きで山を消さない                                          |
| disk full／queue満杯／crash／正常停止／flush失敗                 | degraded・損失／unknownCoverageを通知。受理済みを永続化済みと偽らず、終了前に排他を返さない   |
| 保持設定読取失敗／active file／掃除とquery競合                   | 誤った既定値で削除しない。active writer保護。query結果の欠落を成功に偽装しない                |
| 読取権限で設定変更、秘密入りエラー                               | 管理操作を拒否し、公開応答に秘密・絶対パスがない                                              |

P5自体の検証は固定sourceとの照合、文書整形、参照リンク、現行実装との境界確認とする。サービス・実Hub・PLC・DB・本番負荷・停電耐性は未検証である。
