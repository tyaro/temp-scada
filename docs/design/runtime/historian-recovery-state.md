# Historian H2c5: 再起動時の状態照会と保持 job 発見

2026-11-01。状態: **Astra 主設計。実装・ローカル検証済み、全体CIはPRで確認**。[bounded 保持 job](historian-retention-jobs.md)、[書込み失敗からの復旧](historian-write-failure-recovery.md)、[保守 API](historian-maintenance.md)を前提とする。

## この区切りで解消する問題

保持 job は再open後も active のまま残り、新しい記録を拒否する。しかし現行 status／step API は呼出側が job ID を知っている前提である。host が再起動で ID を失うと、Busy の原因になっている job を発見して再開できない。

H2c5 は **同一 snapshot の副作用のない保存復旧状態照会**を追加し、この運用上の穴を閉じる。自動 driver が新 job ID を生成したり、保持 cutoff を推測したり、発見直後に削除を開始したりする機能は追加しない。呼出側は永続状態を確認してから既存 API を明示的に呼ぶ。

[H2c10](historian-retention-policy-application.md)で現行format 5のapplied_retention_policyを同snapshotへ追加した。適用世代・commit・要求ID・policy全文を復元し、current pointer／最新head／definition／receiptを検証する。job statusのpolicy_applied_revisionはcoordinator経由の掃除出典であり、直接保守jobはNone。以下のformat 4という記録はH2c5時点を示す。

DB format 4、H1 JSON、固定 SDK／Project／Banto／依存は維持する。新表や schema変更は不要。通常 App、製品設定、上流、実 Hub／PLC／DBへ接続せず、隔離一時 DB の library だけを対象とする。

## API と結果

概念 API は `recovery_state(&mut self, &QueryControl) -> StoreResult<StoreRecoveryState>`。最終の型・field 名は実装に従う。

| 結果の要素        | 内容                                                                  |
| ----------------- | --------------------------------------------------------------------- |
| snapshot_commit   | 最初の実 read で取得した store_meta.last_commit。今回の観測の内部位置 |
| retention_fence   | cutoff_ms:Option、revision_commit、source                             |
| active_session_id | 現在 active な記録 session ID、または None                            |
| active_job        | ActiveJobRecovery、または None                                        |

fence source は `Initial`、`SingleTrim {request_id}`、`CompletedJob {job_id}` の識別可能な型とする。Initial は cutoff=None／revision=0の場合だけ。保持 job がactiveでも、まだfenceを進めていなければ以前のsourceがそのまま返る。

ActiveJobRecovery は既存 JobStatus と、任意の `last_step {request: JobStepRequest, receipt: JobStepReceipt}` を持つ。初回step前はNone。requestには元のmax_ticksを含める。最大一件の直近stepだけを返し、全step一覧や全削除対象一覧は追加しない。

snapshot_commit は History snapshotId や永続cursorではない。診断結果に現在の書込みを予約する効力はなく、返却後の変更を防ぐleaseでもない。Rust library内のcommit位置であり、H1 DTOの版付き公開境界へ暗黙に追加しない。

`ready=true` のような総合的な許可フラグは返さない。active_job=Noneでもディスク容量、保持設定、権限、source接続、録画再開の安全性が確認されたわけではない。active_session_idも、記録データが流れていることやschedulerの健全性を証明しない。

## 同一 snapshot と検証

既存のrun_maintenanceと有限Budgetを使い、BEGIN DEFERRED後にstore_meta.last_commitを必須scalarとして読み、snapshotを固定する。このtransaction内でfence、最新適用出典、active session、active job、直近stepを取得する。返却前にROLLBACKして読取transactionを閉じる。

- singletonが欠ける、負のcommit、fenceと最新出典のcutoff／commitが異なる場合はCorruptData。INNER JOINで欠落を正常なNoneへ変換しない。
- 最新fence出典は単発retention_operationsとcomplete jobのUNIONから判定する。最大commitの同率出典が複数ならCorruptData。Initialと正常な出典なしを明確に扱う。
- SingleTrimのID、canonical requestと列値、safe cutoff、期待旧cutoffとの前進、削除件数上限、commit範囲を検証する。出典名だけを返す場合も未検証の参照を正常としない。
- CompletedJobは既存の型付きload検査を使い、complete状態、completion_commit、最後stepの存在・状態・件数・commitをfenceと照合する。
- active sessionはLIMIT2で取得し、二件以上をCorruptDataにする。ID、state、begin/end commit、last_sequence等、返す事実の根拠を検証する。既存status／型検証を再利用できるが、本文はparse前byte予算に含める。
- active jobもLIMIT2。型付きloadでcanonical requestと列、開始／最後step／累積値を検証し、expected_cutoff=current fence、begin_commit>fence.revision、latest_step_commit<=snapshotを確認する。
- active sessionとactive jobが同時に存在したらCorruptData。どちらを優先するか選んで隠さない。
- active jobのlast_step=0なら累積値0かつ直近stepはNone。last_step>0なら直近request／receiptを取得し、jobの最後step、commit、completed=false、累積件数との関係を照合する。

正しく開いたstoreでも、この照会は選択した復旧根拠を検証する。過去すべてのreceipt・step・raw・pendingの完全監査や件数SUMは追加しない。結果に不要な表を無制限に列挙して、復旧状態の確認そのものが大容量履歴で進まなくなる設計にはしない。

## 再起動hostが行える判断

状態照会は操作を自動実行しない。呼出側の明示手順は次のようになる。

1. FULL／I/O等でpoisonされたstoreなら、原因を解消し、writerとreaderのownershipを終了してから同じidentityでreopenする。recovery_stateでpoisonを解除しない。
2. recovery_stateを呼ぶ。active_jobがあれば、そのjob IDとtarget cutoffを復旧対象として認識する。別jobを作成しない。
3. 直近stepの完了通知が失われた可能性があれば、返されたrequestをそのままstep_retention_jobへ再送し、元receiptを得る。この再送は追加削除にならない。
4. 次stepを明示的に実施する場合はJobStatus.next_stepを使用し、max_ticksを選ぶ。前回のmax_ticksを新stepでも使う義務はない。
5. 最終stepが既に成功してactive_job=Noneなら、fenceのCompletedJob出典が適用済みjob IDを示す。IDを失ったことだけを理由に同じcutoffの新jobを作らない。

active jobのnext_step=Noneは安全なstep番号上限の枯渇を表し得る。activeのまま新記録を拒否する状態を隠さず返し、番号を0や1へ巻き戻したり、jobをcompleteへ変えたりしない。対応する運用変更は別途設計する。

active sessionがないことは通常のreopen直後には期待される。open_existingが以前のactive sessionをinterruptedへ変更するためである。このAPIはその処理を繰返したり、終了時刻を補ったりしない。open済みstoreを継続利用中ならactive session IDを正常に返せる。

直近の保持処理が単発trimならSingleTrimのrequest IDが得られるが、過去の全要求を復元するAPIではない。hostが古い要求のcanonical payloadを持っている場合は、既存APIの同ID再送規律を使用する。

## staleな結果と競合

`&mut self` によりこの呼出しと同じwriterの書込みは直列になる。既存readerや将来の呼出しを跨いで状態を固定するものではない。照会後に別の明示stepが完了していれば、古いnext_stepが既存stepの再送になるか、異なるmax_ticksならConflictになる。新しい番号へ自動補正して削除を続けない。

状態照会の結果だけでCASを代替しない。beginのexpected_cutoff、stepの連番とcanonical再送照合、単一active jobの制約が実際の変更操作を保護する。最新状態を読み直して呼出側が判断できることと、自動driverが必ず完了まで進めることを区別する。

## 予算・副作用・障害

SQLごとの先払い、progress_handler、decoded scalar／row、本文64KiBと累積入力byte、結果byte、deadline／取消は既存規律を使う。active候補はLIMIT2、最新出典は同率検出に必要な小件数、最後stepは最大一件であり、全履歴の復号はしない。

成功・取消・失敗のいずれでもreadtransactionとhandlerを解放する。取消を外してからrollback、cleanup失敗時は直接needs_reopen、SQL FULL等をControlへ隠さない共通分類を維持する。通常の読取成功でcounter、fence、job、step、session、rawを変更しない。

既存のcheck_writableを通すため、poison中のrecovery_stateはNeedsReopenとなる。これはエラー後も常に利用できる独立diagnostic readerではない。読取SQLそのものが失敗した場合も既存保守APIのpoison方針に従う。

## 受入

- 新規store: Initial、fence=None、active session/jobなし、counter不変。
- 通常active session: IDだけを状態として認識でき、新job許可と誤解しない。reopen後はinterruptedに従いactive=None。
- step前のjob: process終了／reopen後にIDなしで発見、last_step=None、next_step=1。照会だけで削除しない。
- 途中job: 同timestampのpendingが残る状態を含み、直近request／receiptとnext_stepを復元。元request再送で件数・counterが増えない。
- 最終step COMMIT後の応答喪失: reopen後active_job=None、fence source=CompletedJob、適用cutoffとrevisionが一致。
- 単発trim後、job完了後、さらに単発trim後の最新出典を正しく区別する。
- active候補複数、session/job同時active、fence出典の欠落／重複、job payload／最新step／件数／commitの不整合はCorruptData。
- 照会前後で全logical状態が不変。既存snapshotとownershipの動作を壊さない。
- 取消・低予算・SQLerror・panic／cleanup拒否の既存保守規律。poison中は明示拒否。
- staleなnext_stepを使った後続呼出しが既存receipt／Conflict／Sequence規律に従い、勝手に次の削除へ進まない。

H2c5の成果は、再起動したhostが永続状態だけから保持の中断・完了を識別し、正しいIDで明示再開できること。自動保持・recorder協調・receipt GCに必要な復旧入口を具体化する工程であり、それらの未実装機能を完成扱いにはしない。

## 実装とローカル受入

`store::recovery`のStoreRecoveryState／RetentionFence／FenceSource／ActiveJobRecovery／StepRecoveryと`SqliteStore::recovery_state`へ実装した。fence sourceはkind付きenumで識別し、既存JobStatusと直近request／receiptをそのまま再送に利用できる。jobs側の型付きloadと実MAX step検査を共用し、既存statusはJob::into_statusへまとめて意味を維持した。

Rust workspace234件（新規15単体、child worker含む）、Clippy `-D warnings`／rustfmt、関連Chromium6件が成功。begin／partial／completeのprocess終了、IDなし発見、pendingと最終出典、元max_ticksの再送、stale結果、external writerの途中commitに対するsnapshot、write拒否下の読取成功、複数active／併存／出典同率／head巻戻し・欠落／receipt不整合、予算・取消・SQL failure・panic cleanupを確認した。Astra最終レビューに必須修正はない。

新しい製品画面やTS DTOは追加していない。DB format 4・H1・依存versionを維持し、全体CIはPRで確認する。snapshot_commitは内部位置であり、返却後の進行を防ぐleaseや自動再開の許可ではない。
