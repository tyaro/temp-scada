# Historian H1: 保存方式とtransaction／recoveryの決定

2026-11-01（日本時間）。状態: **H2へ向けた暫定採用設計・実DB未検証**。ユーザー指定に従いAstraが主設計した。[P5](historian-trend-contract.md)と[H1契約fixture](historian-contract-fixtures.md)を満たす保存・検索層を比較し、初期実装の方向を決める。H1ではDB接続、ファイル作成、recorder、実Hub購読、サービスを追加しない。

## 決定

**新しいSQLite保存・検索層をSCADA側で先行する案を、H2の暫定採用とする。** SQLiteのtransactionを使い、観測・メタデータ・coverage・commit位置を一つの正本DBへ原子的に保存する。現行tstoreのwall-clock upsertへ合わせて同時刻recordやQuality／sourceを捨てる設計にはしない。初期は単一host・単一writer・単一deploymentのローカルDBとし、rawを時系列検索できる索引を持つ。

「暫定」は契約を曖昧にする意味ではなく、H2の障害注入・容量試験前にはDB実装の性能と耐障害性を保証できないという意味である。採用継続条件は後述する。失敗した場合は契約を弱めず、schema／query方式またはbackendを再比較する。

実装配置は`scada-historian`の純粋契約と保存adapterを分ける。将来の共有crate名・配置はSOAK後に確定し、ChronoGazerはadapterから利用できるようにする。今回SQLライブラリや新versionを追加しない。H2で既存workspaceの利用可能なSQLite依存を再確認し、依存追加とその検証を別の変更として扱う。

## 比較

| 案                                | 契約適合と利点                                                                                                            | 費用・制約                                                                                                                                                          | 判断                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 現行tstore／tsqueryをそのまま使用 | 日次rotation、自己記述metadata、query／retentionの実績を使える                                                            | ptime主キーのupsert、nullable REALのみでQuality／source／recordIdなし。過去値非破壊・意味保存を満たさない                                                           | 不採用                                                  |
| tstore／tsqueryの新formatを拡張   | 既存製品と保存・query資産を直接共有できる                                                                                 | 主キー、値型、metadata、coverage、commit位置が広く変わる。日次DBを跨ぐ管理情報とデータの原子性、既存ファイル互換、ChronoGazer回帰が必要。SOAK中に上流を変更できない | SOAK後の還元先候補。今回の必須前提にしない              |
| 新SQLite保存・検索層              | recordId主キー、型付き値、transaction、snapshot読取、SQL集約と索引を一つの契約で設計できる。SCADA内の一時DBだけで検証可能 | 新schema・query・保持・recovery試験が必要。単一writer・WAL成長・長い読取・容量の制約を受ける                                                                        | H2の暫定採用                                            |
| PostgreSQL等の外部DB              | 複数client、運用済みDBでのsnapshot／索引／容量管理、将来の大規模検索に候補                                                | DB配備、資格情報、ネットワーク、認証、運用・backupの契約が増える。tsqueryが既に対応するわけではない                                                                 | H1／初期記録では保留。容量・HA要件が判明した段階で比較  |
| ログファイル＋別metadata DB       | sequential appendとspoolに向く                                                                                            | 値ログとmetadata／commit位置の二重書込み回復、索引再構築、保持とsnapshotが複雑。単純sidecarでは原子性なし                                                           | 初期不採用。全変化durable logが必要なら別契約として検討 |

根拠となる固定sourceと既存制限は[ChronoGazer調査](../../reviews/chronogazer-historian-reuse.md)に集約した。既存データを無検証で読み書きする方法は採用しない。新formatへ既存NULLや数値を取り込む場合、未知のQuality／sourceをGood／realへ補完しないlegacy domainとする。そのimportはH2の最小実装からも独立させる。

## 最小の論理schema

以下はH2で実装するDBの概念表であり、H1で実行するDDLではない。DB format versionをJSON契約versionと別に持つ。migrationはwriter停止・backup／復元手順とともに後続で実装する。

| 表／主キー候補                                 | 内容・不変条件                                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| store_meta / singleton                         | format version、store ID、deployment ID、現在のcommitVersion。未知formatをwriteで開かない                                            |
| applied_plans / planRevision                   | 計画の内容hash、適用要求ID、前revision、適用結果と切替commit。要求ID＋内容の再送は同じ結果、同ID別内容はconflict                     |
| series / seriesId                              | hubInstanceId、incarnationId、作成／廃止情報。Hub＋incarnationと系列の対応を永続化。名前を主キーにしない                             |
| segments / (seriesId, segmentId)               | externalName、型、単位、period、source、valid-fromの記録位置／commit、有効区間。意味変更時に追記し、過去metadataを更新で塗り替えない |
| sessions / sessionId                           | 適用plan、clockEpoch情報、起動／終了状態、commit済みsequence、終了診断。sessionは再起動で新規発行                                    |
| observations / (seriesId, sessionId, sequence) | segmentId、clockEpoch、sample／source／ingest時刻、Quality、source、型付き値、reason、commitVersion。同じtimestampの複数行を許す     |
| coverage / coverageId                          | seriesId、session／clockEpoch、可能ならsequence範囲、半開時刻区間、理由、commitVersion。確定不能な境界はunknownCoverageとして表す    |
| commit_batches / commitVersion                 | 受理batch識別、入力内容の照合情報、sessionごとのcommit位置、applied変更、確定時刻。response紛失時の再照会にも使う                    |
| retention_runs / retentionRevision             | 適用ポリシーとtimezone、対象範囲、実行結果／削除commit。expiredの根拠を値削除後も残す                                                |

数値はSQLite REAL、boolは別のINTEGER 0／1、値なしは両方NULLとし、CHECK制約で型と値列を一致させる案を採る。Quality／source／reasonと値の整合はadapter検査とDB制約を併用する。finite数値はSQLへ渡す前に検査する。DB driverがNaNをNULLに変える挙動を意味保存として利用しない。

`observations(seriesId,sampleTimeMs,sessionId,sequence)`と`commitVersion`を検索の基本索引にする。recordId一意制約と時刻索引は別であり、`ON CONFLICT(sampleTimeMs) DO UPDATE`を使わない。内部の大きなsequenceをJSONで丸めない。H1のsafe整数域を越える前にsessionを分ける。

metadataを含む正本をまず同一DBに置くことで、日次ファイルと外部管理DBを跨ぐ二重writeを避ける。これは日次rotationが不要という一般論ではない。容量試験でpartitionが必要になったら、catalogのcommit manifestとsealed segmentの公開手順を別formatとして設計する。後からファイル名だけでseries identityを復元する設計にはしない。

### source世代を保持する内部metadata

P5のsourceEpoch（Hub run_id、catalog revision、SDK generation）はH1公開DTOに含めていないが、記録時に失ってよい情報ではない。H2では`source_epochs`等の内部表へHub個体、run_id（存在しない場合はnull）、catalog revision、SDK generationと解決済みsegmentの対応を保持し、各observationから参照する。値と同一のSDK snapshotから採った情報を同transactionで記録し、後から最新catalogを結合して過去の世代を補完しない。clockEpochとsourceEpochは別で、前者の一致がHub世代の一致を意味しない。公開DTOを改版する場合もこの内部情報を根拠に投影する。

## append transactionと冪等性

入力はH1の検査に加え、適用済みplan、永続identity対応、writer ownership、期待sequenceを照合する。外部clientのsampleBatch.committedThroughを信用してDBのcommit位置を進めない。commit位置はstore自身だけが生成する。

1. writer排他の下で、受理batchの安定したIDと入力内容を固定する。メモリキューへ入っただけならacceptedであり、durableではない。
2. transactionを開始し、必要なseries／segment／session／planを照合・追加する。既存seriesのHub個体／incarnationを書き換えない。
3. observations、既知の欠測coverage、commit_batchesを同transactionへ書く。recordId既存なら内容を比較し、完全一致は既存結果を返す。同ID別payloadはconflictにし、既存行を更新しない。比較は検証済みの型付き論理payloadを正規化して行い、JSON objectのfield順や整数の`1`／`1.0`という表記差ではconflictにしない。numberの1とboolのtrueは区別する。nullと値、意味を持つ配列順、source／Quality／時刻等は保持する。finiteな数値の等価性と−0／0の扱いも両言語で揃え（v1は数値として同値）、raw JSON文字列のhashだけを同一性としない。hashは比較の高速化に使えても、衝突しないと仮定して異なる値を受理しない。
4. 処理対象tickと計画上の系列が、観測または明示的欠測として説明される位置までsessionのcommittedThroughを進める。最大sampleTimeMsや単なる最大到着sequenceへ飛ばさない。順序外batchは拒否／待機のboundedな扱いを実装し、未説明の穴を越えてcommit位置を進めない。
5. commitVersionを進めてCOMMITする。成功後にcommit応答／通知を出す。通知喪失は未commitを意味しないため、再試行を同IDで照会できるようにする。

transactionの途中で停止したら、値だけ・metadataだけ・watermarkだけが見える状態を作らない。複数tickをまとめる場合もatomic batchの上限を設け、記録停止や検索へ長時間ロックを持ち込まない。batchサイズ／flush間隔／キュー容量はH3の実測後に決め、H1で値を性能保証として固定しない。

初期の配送保証は周期sample-and-holdで、キュー受理後・COMMIT前のcrashによる損失を許す。durable spoolは別工程。再試行の冪等性はexactly-onceなHub全変化記録を意味しない。sequenceは観測recordの識別とcommit位置のためであり、Hubが送らなかった変化を再構成しない。

## 時刻・Quality・coverageの保存

sampleTime、sourceTime、ingestTimeを別々に保存する。source時刻をquery時間軸へ代用せず、時計逆行で過去recordをupsertしない。clockEpoch変更を同transactionのmetadataへ記録し、rawは時刻＋recordIdで安定整列する。clock逆行のため時刻範囲が重なるepochを集約する場合はmixedSegmentとし、連続したGood区間に見せない。

Quality／source／reasonは観測時の事実。過去点のSIMを現在catalogから補完しない。原値を公開しないBad／Stale／SIM／unknownも無値の観測として区別して残す。observationsの存在しない区間がunrecorded／expiredか、保存失敗かを判断するため、計画適用履歴・保持削除記録・coverageを同じ管理domainへ置く。

記録失敗時にその失敗coverageも書けなかった場合は、再起動でsessionsの未完了状態と最後のcommitを見つけ、次に確定できる観測までunknownCoverageを残す。電源断の正確な時刻や失われた件数を推測で確定しない。clockEpochが変わり開始／終了時刻を安全に結べない場合も、sequence上の不連続とunknownCoverageを診断し、壁時計の直線区間だけで完全性を主張しない。

## query snapshotと長期検索

初期queryは読取専用transactionで同じDB snapshotを取得する。catalog／segments／observations／coverage／retentionを同じsnapshotから読み、最大commitVersionをsnapshot IDの内部根拠にする。読取中に後続appendがcommitされても、そのqueryに混ぜない。raw・binの公開はH1の端点・予算・型・状態規則に従う。

query実行枠・deadline・キャンセルを管理し、読取transactionを無期限に保持しない。取消後もDB作業が残る場合は完了まで実行枠と所有資源を保持する。WALを読取がpinし続けるため、snapshotの寿命とWAL容量を監視する。長いqueryを許すためにwriterやretentionを無期限に止めない。

長期検索でページ間にDB transactionを保持しない方式を採る場合、cursorへquery hash、grid原点、系列segment、snapshot commitVersion、retentionRevisionと期限を束縛する。immutable observationsをcommitVersion以下に絞るだけでは、途中のretention削除から保護できないため、読取lease／有限pinまたはsnapshotExpired判定が必要。H6で具体方式を選び、保持できないcursorを別snapshotで継続しない。

日／月単位のminmaxは索引・段階的集約で処理し、全rawをUIへ送って縮める方式にはしない。集約にはmin/maxだけでなく有効・無効件数、source／segment／clockEpoch境界、coverage情報を残す。保存側で1時間を越えるデータを拒否しない。実際の長期予算・事前集約の更新方式・削除との整合はH6の受入で決める。

## 保持と容量

初期の単一DBでは期限対象recordをbounded transactionで削除し、同transactionでexpired区間の根拠とretentionRevisionを更新する。単に値を消してunrecordedに見せない。series／segment／適用／retentionの説明に必要なmetadataは残す。削除した古いrecordの再送で復活させないため、期限判定とcommit_batchesの保持・session終了情報を併用し、既に期限削除したrecordIdの再送は再挿入しない。

保持日数の意味と掃除の起点はdeploymentに固定する。P5の起動時／ローカル日付変更時の掃除規律を維持し、保存先timezoneと日境界からUTC cutoffを計算する。raw検索はUTCのまま。設定読取失敗では削除しない。時計の大きな前進時には、未検証の壁時計だけで大量削除を進めず、時刻異常を診断し掃除を保留できる実装をH2で検証する。適用済み短縮ポリシーと削除プレビューの管理境界はP5のまま。

retention対象判定はsampleTimeと保持ポリシーを基準にするが、active writerの未確定batchを掃除対象にせず、commit済みの確定範囲に限定する。時計逆行で新しく受理したrecordがcutoffより古い場合は、数値を黙って捨てず保存方針の競合として診断し、そのtickをcoverageで説明する。実際の採用動作（保留・短期隔離等）はH2の異常時刻試験で確定し、expiredの偽装や既存過去値の上書きを許さない。

DELETEのcommitとOSファイルの縮小は別である。初期は削除による空きpage再利用を前提にし、VACUUM等の重い物理縮小を記録中に無条件実行しない。容量不足ならdegradedを通知し、保持期限内データを自動で消して収集成功に見せない。checkpoint・空き容量・WAL使用量と縮小／保守の手順はH2の容量試験で決める。

## ownershipと設定変更

単一hostのプロセス排他と、DB上のdeployment／owner情報を照合する。mutexだけで別プロセスのwriterを防いだとしない。複数UIからの適用は期待applied revisionの比較で直列化し、異なるProjectの要求が同じdeploymentの計画を黙って上書きしない。旧writerの停止／flush／joinが終わるまで排他を移譲しない。

初期は複数hostからの同一DB書込み・ネットワーク共有SQLite・active-activeを提供しない。将来lease方式のfailoverを導入する場合は、DBまたは保存APIが旧fencing tokenのappendを拒否することを必須にする。lease期限を過ぎたという制御側の推測だけでは、旧writerが停止した証拠にならない。

新計画適用は、検証した計画と適用境界をtransactionで保存し、そのplan revisionを次tickから使う。切替時刻をUI保存時刻から推測しない。計画の一部適用は行わず、失敗時は旧appliedを維持する。renameの継続確認や同名再作成のincarnation発行も永続管理情報と照合する。

## crash／recoveryマトリクス

| 故障点                          | 回復後に必要な観測結果                                                                      | H2の確認方法                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| メモリ受理後・transaction開始前 | 旧commit位置。未保存分はunknownCoverageであり、存在しないrecordを再生しない                 | 注入した停止後にsessionとcommit位置を照合      |
| metadata追加後・sample追加前    | transaction全体rollback。孤立segment／進んだwatermarkが公開されない                         | 各SQL境界で失敗注入                            |
| sample追加後・watermark更新前   | 同じくrollback。値だけの部分成功を公開しない                                                | transaction中断後の全表整合                    |
| watermark更新後・COMMIT前       | rollbackし旧commitへ戻る                                                                    | COMMIT直前の停止注入                           |
| COMMIT成功後・応答送信前        | 同ID同payloadの再送は同じ結果。record数は増えない                                           | 応答を捨ててretry                              |
| 同ID別payload再送               | conflict。既存record／commit位置を変更しない                                                | timestamp・値・Quality各変更で検査             |
| 同timestamp・別recordId         | 両方残り、rawの安定順とminmaxへ反映                                                         | 同時刻と時計逆行fixture                        |
| retention transaction中         | 削除とexpired根拠が同時rollbackまたは同時commit                                             | 削除中断と再起動                               |
| query中のappend／retention      | snapshot内で一貫した応答、または明示失効。空のreadyへ化けない                               | readerとwriterを制御した競合試験               |
| disk full／I/O失敗              | 正常commitを偽らずdegraded。ライブ・警報の別経路を停止させない                              | fake storeと一時DBの障害注入。製品隔離はH3以降 |
| flush／停止時間切れ             | 未完了taskと排他を保持し、停止完了を返さない                                                | 再度stop／joinして終了を確認                   |
| DB破損／未知format              | 書込み再開を拒否し、安全な診断。既知部分のqueryはpartial規則で扱う                          | 使い捨てfixture DBのみで検査                   |
| OS／電源断                      | 選んだ同期設定の範囲でcommit済み保持を確認。上記のprocess停止試験だけで停電耐性を主張しない | 対象OS・filesystem・DB設定で別受入             |

H2の暫定設定はWALと保守的な同期設定を候補とし、具体的なPRAGMAとdriverの既定値を実装時に明示する。COMMIT成功がどの故障まで耐えるかはOS・filesystem・ストレージに依存する。メモリ受理、DB commit、媒体耐久性を別の状態として扱う。

## 採用継続条件と後続

H2で同時刻非破壊、再送冪等性、値／metadata／coverage／commitの原子性、raw／minmax・半開区間、snapshot一貫性、retentionの説明可能性、異常時刻、破損・容量不足・取消を隔離した一時DBで検証する。計画するタグ数・周期・保持期間でDB増加量とqueryの仕事量を測り、単一DB案が有効か判断する。

H1のpure fixtureはこの検証の入力を揃える。H2は新保存層をSCADA内で先行できるが、上流の共有crate切出し、ChronoGazer移行、実Hub接続、実環境のDB／設定操作は別工程である。SOAK終了後に新契約と回帰fixtureを共有層へ還元し、ChronoGazerの既存SIMポリシーや旧formatを黙って変えない。

H2の最初の実装区切りは[Astra主設計のH2a原子appendコア](historian-atomic-store.md)へ具体化した。固定sessionと1tick保存を隔離一時DBで検証し、検索snapshot・coverage生成・保持・容量・復旧の残りはH2b／H2cへ継続する。H2aをH2全体の完了とは扱わない。

[H2b3の証拠保存](historian-recording-evidence.md)でDB format 2へ進めた。旧format 1を自動migrationせず拒否する。timed sessionと明示gapを原子的に保存するが、公開coverageへの投影と保持・容量・復旧は後続である。
