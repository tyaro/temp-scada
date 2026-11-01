# Historian H2c: 保持削除・expired・容量と復旧

2026-11-01。状態: **Astra 主設計。H2c1実装・ローカル検証済み、全体CIはPRで確認**。[保存方式](historian-storage-decision.md)、[原子保存](historian-atomic-store.md)、[時刻付き証拠](historian-recording-evidence.md)、[coverage 投影](historian-coverage-projection.md)を前提とする。

## 段階と今回の境界

H2c 全体を一度に完成させない。最初の H2c1 は、記録 session が active でない保守時点で、明示 UTC cutoff より古い observations を小さな一括 transaction で除去する。その実削除証拠、単調な受入 fence、再送 receipt、query の expired を一貫して検証する。

| 区切り               | 対象                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| H2c1                 | bounded 原子 trim、再送復活防止、実削除 timestamp の expired、query snapshot 競合、process crash 回復                   |
| 後続の時刻・常時運用 | deployment 保持設定、日付・timezone からの cutoff、自動掃除、時計跳躍検知、active recorder との協調、大量削除の進行管理 |
| 後続の容量・物理保守 | receipt payload の保持／GC、metadata・ledger の圧縮、容量監視、WAL／checkpoint／disk-full／VACUUM 運用                  |

通常 App、実 Hub／PLC／DB、上流へ接続しない。isolated temp DB の library と故障注入だけを対象とする。H1 JSON version、SDK、Project、Banto、依存は維持する。保存形式は追加表と受入 fence の意味が変わるため **format 3** とし、format 1／2／未知形式を silent migration しない。旧形式を変更せず拒否する。

重要な限界として、H2c1 では `commits.payload_json` を保存したままにする。これは型付き payload の完全一致による再送判定に必要で、削除対象の値もその本文に残る。したがって今回の trim は **History query 用 observations の期限除去**であり、値の物理消去、秘密情報の消去、ディスク使用量の十分な低減を保証しない。receipt GC と再送認識期限の契約は別工程で決める。

## Rust API と cutoff

概念 API は `trim(&mut self, request: TrimRequest, control: &QueryControl) -> TrimReceipt`。既存 QueryControl の予算・取消機構を共用できる。最終の module・error 名は実装へ合わせる。

- `TrimRequest { request_id, cutoff_ms, expected_cutoff_ms: Option<i64> }`
- `TrimReceipt { request_id, cutoff_ms, commit_version, deleted_ticks, deleted_observations }`
- request_id は既存 ASCII ID、cutoff は H1 safe integer の UTC epoch ms。
- 対象は store 全系列の `sample_time_ms < cutoff_ms`。sourceTime／ingestedAt を代用しない。cutoff 上の record は残す。
- 初回 fence は None。同 ID 再送以外の要求では expected_cutoff が現在値と一致し、新 cutoff は現在値より厳密に大きいことを要求する。CAS 不一致／逆行／同値の新操作は Conflict 等で変更なし。
- 保存済み request_id は canonical payload を先に比較し、同内容なら元 receipt、別内容なら Conflict。現在の fence、active session、残存候補数の検査より再送判定を優先する。
- 新しい trim は active session が一つでもあれば Busy／ActiveSession 等で拒否する。暗黙に close／interrupt しない。既存 reader は許可する。

cutoff は呼出側が明示決定した保持境界である。H2c1 は実時計を読まず、保持日数や「今」から自動計算しない。policyRef／製品の desired-applied 配布も追加しない。入力された未来 cutoff が妥当かを library 単独で判別できるとは主張しない。製品での自動呼出しを開始する前に、信頼できる時刻、設定 revision、短縮の適用、前進量の検査を後続工程で設計する。

## bounded 全件原子削除

1要求の対象は最大 **1024 tick**、固定 member 最大8なので最大8192 observations。同 tick の全 member を同時に除去し、timestamp が同じ別 session／sequence を選別して残すこともしない。

候補 tick を deterministic に列挙し LIMIT 1025 で上限を検出する。上限超過は typed limit で全体無変更。先頭1024件だけ消して cutoff を進める実装にはしない。呼出側はより小さい cutoff を選び直せる。ただし同 timestamp だけで上限を超える場合は今回進行できず、後続の大量削除契約が必要である。

対象 tick ごとに session/spec、commit receipt、member 集合、同一 sampleTime、観測件数と参照の整合を検証する。壊れた一部 member だけを削除して正常な期限処理に見せない。候補の取得を observations の時間索引から始める場合も、その tick の全 member が cutoff 対象であることを確認する。retention 自体が全 DB integrity checker になることは要求しないが、実際に削除する単位の証拠を照合する。

候補検証後、一つの write transaction で次を commit する。

1. global commit counter を一度だけ進め、retention operation と安定 receipt を登録する。
2. 実削除 observations を series／sampleTime ごとに集計し expired ledger を挿入する。
3. 全候補 tick の observations を除去する。期待した削除件数と実件数が違えば rollback。
4. store 全体の cutoff fence と revision commit を更新する。

対象が0件でも明示 cutoff の前進を commit してよい。この場合 expired 証拠は増えない。tick sequence、session.last_sequence、元 commit_version、正常終了時刻は変更しない。query watermark は歴史的に commit した位置であり、現存 raw 件数ではない。

## format 3 の最小表

| 表                   | 内容                                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| retention_state      | singleton、nullable cutoff_ms、revision_commit。初期 None／0、以後 operation と一致する単調 fence                          |
| retention_operations | request_id 主キー、canonical payload_json、cutoff_ms、commit_version UNIQUE、deleted_ticks、deleted_observations           |
| expired_samples      | series_id、sample_time_ms、operation_id、deleted_records。主キー `(series_id,sample_time_ms)`、series と operation への FK |

実削除 timestamp の合計件数を残す。同系列・同 timestamp の複数 record は一行へ集約する。全 store cutoff と新規 append fence により、一度 expired になった timestamp に後から別 record を追加して再削除することはない。重複 ledger は上書きで隠さず整合違反として扱う。

commits、source_epochs、series、segments、sessions／members、recording_plans、session_evidence、recording_gaps は残す。これにより metadata、歴史的 watermark、begin／gap／close／tick の再送契約を維持する。保持処理だけで session を unknownSeries にしたり、保存済み descriptor を消したりしない。

## 再送と異常時刻

append は従来どおり既存 `(sessionId,sequence)` receipt の canonical 照合を最初に行う。削除済み tick の同内容再送は元 receipt を返し、observations を復活させない。別内容再送は Conflict。session が終了済み、cutoff が前進済みでもこの順序を保つ。

未保存 tick の `sampleTime < cutoff` は型付きの期限境界違反で拒否する。sequence、frontier、commit counter を進めず、数値を無言で捨てたり、記録していない tick に expired を作ったりしない。clock 逆行後の新 session でも同じ store fence を適用する。cutoff と同時刻は受理可能。begin の時刻根拠が cutoff より古いことだけで過去の観測成功を主張しない。

未来方向に飛んだ record が cutoff 以後なら残す。record の最大 timestamp から cutoff を導出して正常な過去データを大量削除しない。clock が逆行しても cutoff を下げない。future cutoff の誤適用を復元する API は今回提供しないため、H2c1 を自動 scheduler へ接続する段階ではない。

## expired の公開意味

expired は「その UTC 区間に保存されていた observations を保持処理で除去した」という実証拠とする。cutoff より古い全域を expired にはしない。元々未記録だった区間、欠測しかなかった区間、未知期間の意味を保持する。

整数 ms の timestamp t の証拠は `[t,t+1)`。削除条件は `t < cutoff <= MAX_SAFE` なので t+1 は safe integer 内にある。MAX_SAFE の record は有効な cutoff では今回削除できない。隣接した同理由区間は結合するが、離れた timestamp の間を補間しない。

query は従来と同じ snapshot で expired ledger と operation／fence を照合する。receipt の削除 count、正の deleted_records、timestamp と cutoff、operation commit と snapshot 上限、series の参照を検査する。本文を含む入力は既存の parse 前 byte 上限に従う。

expired は全 store の原子削除から生じるため、局所 samplingMissed／storageLoss と異なり、他 session/domain や untimed session で遮蔽しない。公開 coverage への順序は次のとおり。

1. H2b4 の根拠から samplingMissed／storageLoss と unknownCoverage の基底を作る。
2. 実削除 timestamp の expired を query へ clip し、基底区間から差し引いて最優先で overlay する。
3. 同理由の隣接を coalesce し、query 全域の非重複 coverage を作る。
4. 最終256件上限と H1 検査を適用する。

untimed の存在による全域 unknownCoverage は基底であり、expired 読み取り前の即 return にしない。最終 overlay で区間数が減り得るため、基底だけを256件で先に拒否せず、最終数で判定する。入力候補の上限は維持する。expired ledger の query 範囲取得は SQL 側で整列・連続区間化できる。bounded 入力／decoded rows を超えたら EvidenceLimit／WorkLimit、最終超過は CoverageLimit とし、切捨てや silent unknown fallback をしない。

公開 expired 内に同系列 raw が残っていないことを EXISTS で確認し、Good／無値を問わず存在すれば CorruptData。正常な別 domain の同 timestamp も store 全体の trim で削除済みでなければならない。

raw の値・順序、minmax の grid／mixed 判定は維持する。expired が bin の一部なら他部分の有値 record は許す。bin 全体が expired なら validCount=invalidCount=0。complete へ昇格しない。複数 descriptor の空 bin は引き続き MetadataAmbiguous になり得るため、expired の根拠を metadata の有効期間証明へ流用しない。

## snapshot・取消・故障

reader が trim commit 前の snapshot を pin した場合、旧 raw と旧 coverage を最後まで返す。commit 後に開始した snapshot は削除後 raw と expired を返す。値だけ消えて証拠が見えない、または値が残って expired と重なる中間状態を公開しない。

tick 上限は変更件数の上限であり、SQL 探索量や I/O 時間の硬上限ではない。trim も既存の SQL ごとの VM 先払い／progress handler、最大5M VM、10秒以内の deadline、取消、decoded row と byte 上限を使用する。候補・検証・ledger の各段階へ予算を課金し、ループで取消を確認する。複数段階で budget をリセットしない。

COMMIT 前の失敗・取消は全 rollback。cleanup は progress handler 解除を先に行い、取消で rollback 自体を中断しない。SQL failure の NeedsReopen と ownership は既存規律を維持する。COMMIT 後の応答喪失は同 request ID の再送で元 receipt を確認する。commit 済みの処理を未実施と断定しない。

| 故障／競合                                              | 必須の結果                                               |
| ------------------------------------------------------- | -------------------------------------------------------- |
| ledger 挿入後、delete 後、fence 更新後、COMMIT 前の停止 | 全体 rollback、旧 raw／旧 fence、operation なし          |
| COMMIT 直後の process 終了                              | 削除・ledger・fence・receipt 全て存在、retry で増加なし  |
| 同 request ID 別内容                                    | Conflict、追加削除なし                                   |
| 旧 tick 同内容再送                                      | 元 receipt、raw 復活なし                                 |
| 新 tick の時刻が fence 未満                             | 拒否、sequence／frontier／counter 変化なし               |
| reader が旧 snapshot を保持                             | query は旧状態の内部整合を維持、writer は通常の WAL 規律 |
| 制約失敗／SQLite failure                                | 原子 rollback、必要な再openを要求                        |

## H2c1 受入

- cutoff 未満／同値／以後、負の時刻、safe integer 両端、未来 timestamp、clock 逆行の新 session。
- Good 0、false、Bad／Stale／SIM 等の無値 record も対象に含め、deleted_observations と ledger count が一致する。
- 同 timestamp の別 sequence／別 session、全 member を一括削除。異なる series に同じ timestamp がなければその系列の expired は作らない。
- 1024 tick 成功、1025 tick は無変更。対象0件の fence 前進、CAS 不一致、cutoff 後退、active session の拒否。
- 同要求／別要求の再送、終了 session の tick receipt 再送、削除後の新 tick が復活経路にならないこと。
- expired と samplingMissed／storageLoss／unknown の overlay、untimed があっても expired が公開されること、最終256区間と257区間。
- raw／minmax の同一 coverage、bin 一部 expired と他部分の値、全域 expired、空 bin の既存 metadata 制限。
- snapshot pin 中に trim を commit する reader／writer 競合。終了後 snapshot の切替。
- COMMIT 前後の child process 終了、SQL failure、取消／低 VM／rows／bytes、cleanup 後の reader／writer 状態。
- format 2／未知形式／版不一致は変更せず拒否。H1 fixture と既存 store/query/coverage の回帰。

## 後続で決める容量運用

DELETE は空き page を再利用可能にする処理で、DB file の縮小ではない。WAL には旧 page が残り、長寿命 reader は checkpoint を妨げる。H2c1 の成功を容量危機の解決と扱わない。

後続では DB/WAL の byte 計測、空き容量、checkpoint の busy／進捗、有限 snapshot pin、記録停止時の物理縮小、disk-full 時の degraded と再開手順を検証する。記録中の無条件 VACUUM や、容量のための保持期限内削除を追加しない。receipt の本文を消すには、再送可能期間、tombstone／digest の扱い、古い ID の再利用禁止、衝突時判定を別契約にする。metadata／expired ledger の増大も残るため、これらを含む容量設計を完了して初めて H2c 全体の完了とする。

## 実装とローカル受入

`store::retention::{TrimRequest,TrimReceipt}`と`SqliteStore::trim(request, &QueryControl)`へ実装した。上限超過はStoreError::RetentionLimit、新tickの期限違反はRetentionCutoff、予算・取消はControl(QueryError)、証拠矛盾はCorruptDataとして返す。schemaはformat 3、旧版は非変更拒否。時刻索引に加えてtick member索引を追加し、最大候補の検証を繰返し全表走査にしない。

Rust workspace174件（writer13単体・expired5単体・新fixture統合1関数）、Clippy `-D warnings`／rustfmt、TS114ファイル・1,401件、型検査0エラー・0警告、build、関連Chromium5件が成功した。6ケースを実SQLite・TS・ブラウザで共有し、COMMIT前後5境界のprocess終了、snapshot競合、safe整数端点、上限、再送、破損と取消・panic後cleanupを確認した。

Astraの実装レビューで、panic中のcleanup失敗でもwriterを直接poisonする規律、各SQLのVM予算課金、必須singletonと最新operationの照合、対象receiptの`begin < receipt < end <= snapshot`検査を修正・確認した。最終レビューに必須修正はない。全体CIはPRで確認する。buildの既知chunkサイズ警告は残る。
