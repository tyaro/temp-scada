# Historian H2c4: 継続可能な bounded 保持 job

2026-11-01。状態: **Astra 主設計。実装・ローカル検証済み、全体CIはPRで確認**。[単発 trim](historian-retention.md)、[容量診断](historian-maintenance.md)、[容量不足時の復旧](historian-write-failure-recovery.md)を前提とする。

## 今回進める実用性

単発 trim は1024 tickを超えると全体を拒否する。同 timestamp に1025 tickあれば cutoff を小さくしても進行できない。H2c4 では、明示 cutoff に対する保持処理を永続 job と小さい step に分け、この場合にも有限 transaction を繰返して完了できるようにする。

製品の保持日数、timezone、信頼時計、自動 scheduler、常時 recorder は追加しない。呼出側が開始・次 step を明示実行する同期 library とし、背景 thread や自動再試行を追加しない。通常 App／上流／実環境へ接続しない。

DB は **format 4** とする。新規 job／途中削除の証拠と書込み拒否状態を永続化するため、旧 reader／writer が形式を無視して開ける変更にはしない。format 3以下・未知形式を非変更拒否し、自動 migration を導入しない。H1 JSON、既存単発 trim の1024 tick契約、SDK、Project、Banto、依存は維持する。

## 公開操作と冪等性

| 操作                 | 入力／結果の意味                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| begin_retention_job  | `{job_id,cutoff_ms,expected_cutoff_ms}` → `{job_id,cutoff_ms,begin_commit}`                             |
| step_retention_job   | `{job_id,step,max_ticks}` → `{job_id,step,commit_version,deleted_ticks,deleted_observations,completed}` |
| retention_job_status | job_id → optional `{state,next_step,totals,begin_commit,completion_commit,cutoff}`                      |

各操作は既存 QueryControl と Budget の有限検査を使う。最終の型・field 名は実装に従う。job ID は既存 ID、cutoff は safe integer UTC ms、step は1から始まる連番、max_ticks は1〜1024。累積 count／step は safe整数上限で checked 加算する。

begin の canonical payload は ID、cutoff、期待する旧 fence。既存 ID が同内容なら元 begin receipt を返す。status は別の現在値であり、begin の再送結果を現在の完了状態に置き換えない。異内容は Conflict。

step の再送キーは `(job_id,step)`。max_ticks も canonical payload に含める。保存済み同内容は元 step receipt、別内容は Conflict。receipt 判定は現在の job状態や next_step 検査より先に行う。未保存の新 step は現在の next_step と一致することを要求する。完了後の新 step は拒否するが、過去 step の receipt は再取得できる。

max_ticks は実際に今回選ぶ最大件数で、変更件数や処理容量の成功保証ではない。既存 decoded rows／byte／VM予算に先に達した場合は全 rollback。未commit step は同じ番号で小さい max_ticks を指定し直せる。既に保存された step のサイズ変更は認めない。

## quiescent な job の寿命

新 job 開始には active session がなく、active retention job もなく、expected_cutoff が現在 fence と一致し、cutoff が現在値より厳密に前進することを要求する。begin は job 行と begin commit を原子的に記録するが、cutoff fence はまだ進めない。

active job 中は次のように扱う。

- 新 session の begin、新規 tick append、別 job begin、単発 trim を拒否する。job を無視して旧 fence 以後へ書き始める経路を作らない。
- 既存 begin／tick／gap／trim／job step の同内容 receipt 再取得は許す。再送を再開や再削除に変えない。
- History query、diagnostics、PASSIVE checkpoint は許す。reader ownership の規律も維持する。
- close／interrupt の既存 terminal no-op は新記録を作らない。正常な active job と active session の同時存在は許されず、矛盾を見つけた場合は CorruptData とする。

今回 cancel／abort job API は提供しない。すでに削除した record を戻せないため、単に active flag を解除して未適用 fence の領域を再び書けるようにはしない。呼出側が step を実行しなければ job は持続的に待機し、新記録も停止したままである。この制約を保守操作の契約として公開する。

reopen は active job を消去・完了・取消にしない。既存の active session 復旧とは別の lifecycle である。job status を読み、最後に未確定だった step ID を再送して receipt を確認してから継続する。容量不足時は原因解消・再openが必要であり、ループ retry で成功に見せない。

## step の原子単位

1. 同一 write transaction で job／fence／session の前提と step 再送を検査する。
2. `sample_time_ms < job.cutoff` の残存 tick を時刻・session・sequence の決定順で最大 max_ticks 件選ぶ。先頭部分を選ぶことが今回の明示契約であり、単発 trim の意味は変えない。
3. 選んだ各 tick の固定 member 全体、同一 timestamp、receipt／session commit／snapshot の関係を既存 trim 同様に検証する。
4. 削除する observations を series／timestamp ごとに集計して pending count を増やし、全 member を削除する。
5. 今回触れた series／timestamp だけを調べ、同系列・同 timestamp の残存 observations がないキーの pending を公開 expired ledger へ移す。
6. job累積値／last_step、step receipt、global commitを一度更新する。残存対象 tick がなければこの transaction で job complete と fence 更新も行う。

1 step の最大変更対象は1024 tick・8192 observations。published判定は今回触れた最大8192キーに限定し、毎回全 pending を走査しない。時刻索引と `(session,sequence,series)` 索引、pending／expired の主キーを使う。小さい max_ticks で変更対象を減らせても、探索 SQL の仕事量は別途 VM／deadline によって制限される。

`DELETE ... WHERE sample_time<cutoff` の全件削除は job step では行わない。選択した tick だけを削除し、期待件数と実件数の一致を確認する。対象0件の最初の step も、削除数0で job を完了してよい。

完了判定は `EXISTS(sample_time_ms<cutoff)` と pending残存有無を同 transaction で確認する。pending があるのに対象 raw がない場合は証拠移動の不整合として扱い、黙って完了しない。完了時のみ現在 fence を target cutoff、revision をその step の commit に更新する。

## 同 timestamp と途中 query

例として同系列の時刻1000に1025 recordがあり、step1で1024 recordを削除する場合を考える。pendingのdeleted_recordsは1024になるが、時刻1000に1 record残るので `[1000,1001)` を expired にしない。query は残った raw を返し、coverage は既存証拠に従う unknownCoverage 等のまま。途中の raw 件数が処理前と同じであるとは保証しない。

step2が最後の1 recordを消したとき、同キーの累積1025件を job expired へ移し、`[1000,1001)` を公開する。deleted_records を今回 step の削除数で検査してはならず、job全体の累積数を上限として検査する。

別系列に当該時刻の残存 raw がなければ、その系列の expired は先に公開できる。全 store の同 timestamp が一斉に消えるまで待つ必要はない。H1 の矛盾条件は同系列に対するものだからである。

途中 expired の復活防止は active job が新記録を拒否することによって成立する。完了後は単調な cutoff fence がその役割を引き継ぐ。fenceを先に進めて途中結果をすべて expired にしたり、残存 raw を query から隠して削除済みに見せたりしない。

## format 4 の追加表

既存 retention_operations／expired_samples は単発 trim の出典として残す。別 source の表を追加し、旧 DTO と件数上限を維持する。

| 表                    | 必須内容                                                                                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| retention_jobs        | job_id主キー、canonical payload、cutoff／expected_cutoff、state(active/complete)、begin_commit、last_step、累積deleted_ticks／observations、nullable completion_commit |
| retention_job_steps   | `(job_id,step)`主キー、canonical payload、commit_version UNIQUE、今回deleted_ticks／observations、completed                                                            |
| retention_job_pending | `(job_id,series_id,sample_time_ms)`主キー、累積deleted_records。job／series参照                                                                                        |
| job_expired_samples   | `(series_id,sample_time_ms)`主キー、job_id、published_step、累積deleted_records。series参照と `(job_id,published_step)` FK                                             |

active jobは部分 UNIQUE index等で最大一件。countsとstepは非負／正のsafe整数、stepの単回件数は1024／8192上限。state／completion_commit の有無を整合させる。global counterやreceiptは原子的に更新し、job累積値の変更を別 transaction にしない。

retention_state の正当な最新出典は、単発 retention_operations と complete job の completion_commit を UNION した中で最大commitのものとする。現在 fence／revision はその cutoff／commit と一致しなければならない。active jobのbegin／stepは fence の出典にならない。active job の expected_cutoff は現在 fence と一致する。

pending は query の expired 出典ではない。job_expired は published_step が保存済みで、step commit<=snapshot、jobのlast_step以上へ先走っておらず、`timestamp<job.cutoff`、正の count<=job累積observations を確認する。active jobなら書込み停止状態と旧fence整合、completeなら completion_commitと現fence以後への単調性を確認する。

異なる source／job間で同(series,time)の公開 expired が重なることは正常な fence 規律では起きない。UNION で重複を消すのではなく、重複をCorruptDataとして検出する。

## query の証拠上限を実用化する

現行の expired pointを最大1024行だけ Rust に復号する方式では、連続1025 msの削除が1区間にまとまる場合も検索できない。H2c4では単発とjobの両 source を SQLで検証・連続区間化してから返す。

概念的には、source別の LEFT JOIN と列検査を持つ CTE → UNION ALL → 同時刻重複の検出 → LAGで隣接ms判定 → 累積groupによるisland化 → MIN(time)／MAX(time)+1 と corrupt_count の集約とする。reference欠落や不正countを INNER JOIN／WHERE で落とさない。正常と判定した行だけを集約して破損を隠さない。

最大256 expired islandと1件の超過検出を取り出し、SQL走査は既存 VM／deadline、decodeとbyteは共有Budgetで制限する。257 islandなら CoverageLimit、既存基底へのoverlay後も最終256件上限を維持する。密な連続点は少数 islandとして読める一方、疎な履歴や複雑な基底が上限で失敗することは明示した契約である。全rawをRustへ展開しない。

safe時刻のt+1規則は単発 trimと同じで、削除timestampはcutoff未満のためMAX_SAFEそのものにはならない。SQLのsource検証と加算を順序付け、破損値のoverflowを正しいintervalとして公開しない。

公開 expired は残存 raw と重ならないことを同snapshotのEXISTSで確認する。samplingMissed／storageLoss／unknownに対するexpired優先、minmax部分binの値の許可、全bin expiredのvalidCount=0、空binMetadataAmbiguousは維持する。未完了jobをpendingFlushとして公開しない。

## 予算・取消・復旧

各APIは既存のSQL先払い、progress handler、最大5M VM／9000 decoded rows／入力・出力byte／10秒以内の協調deadlineを継承する。上限は操作ごとであり、job全体を一度のbudgetで完了させる要求ではない。各stepで同じ予算を適用する。

step中の取消／FULL／SQL障害は pending、raw、published、step receipt、累積値、fenceをまとめてrollback。handler解除→rollback、直接needs_reopen、FULLをControlへ隠さない分類を維持する。COMMIT後の応答喪失は同(job,step,payload)再送で元receiptを確認する。

query はstep前か後の一つのsnapshotを読む。古いsnapshotが消去前rawを見ることは正常で、新しいsnapshotと混ぜない。readerが生存中のowner lock、WAL pin、診断とPASSIVEの制限は従来どおり。

jobが完了しても commits.payload_json、session／plan／receipt、expired証拠は残る。これは大量のquery対象を段階的に除去できる機能であり、物理消去や完全な容量回収、receipt GCの完成を意味しない。

## 受入

- 同timestamp1025 tickを1024＋1で完了。最初のstepではraw残存かつexpiredなし、最後のstep後のみ累積1025のexpired。
- 別session/domain・Good／null・複数seriesを含む同timestamp。全member tickの原子削除と系列ごとの公開判定。
- 連続1025以上のtimestampがSQL集約で少数expired islandとして検索可能。257疎区間はCoverageLimit、source重複と破損参照はCorruptData。
- active sessionのbegin_job拒否、active job中の新begin／append／単発trim拒否。既存receipt再送とquery／diagnosticsは許可。
- step連番、同ID異payload／max_ticks、順序違い、完了後の新step、未commitstepの小さいmax_ticksによる再実行。
- pending更新後・raw削除後・published移動後・fence完了前の障害／process終了は全rollback。step COMMIT後応答喪失は安定receipt。
- reopen後もactivejobが残り、新記録を拒否したまま同stepを照会・続行できる。FULL後は原因解消とreopenを必要とする。
- 旧snapshotと新snapshotの整合、cutoff上のrecord残存、safe整数端点、対象0件の完了、完了後の新sessionと新fence適用。
- 既存単発trim、H1、raw/minmax、coverage、ownership、checkpoint、SQL FULLを回帰する。format3は非変更拒否。

H2c4の完了は、同timestamp集中を含む大きな保持対象をbounded stepで安全に進行できること。自動保持・信頼時計・recorder協調・receipt GC・物理容量運用は今回の実装に紛れ込ませず、別の契約として扱う。

## 実装とローカル受入

`store::retention::jobs`のJobRequest／JobStepRequestとSqliteStoreのbegin_retention_job／step_retention_job／retention_job_statusへ実装した。JobStatus.next_stepはOptionで、完了またはsafe連番上限ではNone。format 4、旧format 1／2／3は非変更拒否。H1・依存・SDK・Project・Bantoは変更していない。

Rust workspace218件（新規job17単体・query snapshot1単体・fixture統合1関数）、Clippy `-D warnings`／rustfmt、TS114ファイル・1,407件、型検査0エラー・0警告、build、関連Chromium6件が成功。6共有fixture、1025同timestampと連続timestamp、部分expired、FULL／取消・panicとprocess5境界、再openとreceipt、cutoff・safe端点、残存rawと旧snapshotを確認した。SQL集約は1024入力点上限を置換するが、VM／deadline／row／byteと256 island／最終coverageの有限上限は維持する。

Astraの複数回レビューで、最新stepの欠落・commit／件数・完了状態、過去stepの再送上限、scalar予算課金を補強した。検索範囲外の最新step欠落や不正件数を見逃す経路は回帰でreadyを再現して修正した。最終レビューに必須修正はない。job途中のmax_ticksが大きすぎて予算を超える場合は、未commit stepを小さく指定し直せる。全体CIはPRで確認する。
