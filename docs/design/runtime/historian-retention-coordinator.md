# Historian H2c7: 明示意図による一回分の保持 coordinator

2026-11-01。状態: **Astra 主設計の採用契約、Rust library実装・ローカル受入済み**。[時計guard](historian-retention-clock-guard.md)、[復旧状態照会](historian-recovery-state.md)、[bounded保持job](historian-retention-jobs.md)を接続する。

## 今回選ぶ工程と価値

H2c6までのlibraryは、復旧状態の取得、時刻安全判定、job開始、step実行を個別に提供する。hostがこれらを毎回組み立てると、時計停止状態の受渡し、stale判定、応答喪失後のstep再送を誤りやすい。H2c7は、**観測と純粋判定に続いて、明示された最大一操作だけを行う同期coordinator**に絞って、この接続契約を実装する。

新job ID、cutoff、policyを生成しない。次stepを自動選択しない。sessionのclose／interrupt、背景loop、自動retry、timezone／保持日数計算、信頼時計の取得も行わない。これらの製品defaultを仮定せず、callerから一回分の明示意図を受け取る。

DB format 4、H1 JSON、固定SDK／Project／Banto／依存を維持する。新永続表・migration・公開transportは追加しない。通常App、上流、実Hub／PLC／DBへ接続しない。

## API

概念 API は `coordinate_retention_once(&mut self, input: &CoordinatorInput, control: &QueryControl) -> CoordinatorReport`。最終の型・名前は実装に従う。

CoordinatorInput は次を持つ。

- policy: RetentionClockPolicy
- guard_state: GuardState
- sample: ClockSample
- candidate_cutoff_ms
- intent: Observe／Begin(JobRequest)／ContinueExisting(JobStepRequest)

CoordinatorReport は次を持つ。

| field             | 意味                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------ |
| next_state        | 今回採用すべきguard状態。評価済みならAssessment.next_stateと同じ                           |
| assessment:Option | 今回の純粋判定。DB観測前の失敗やInvalidInputではNone                                       |
| recovery:Option   | 今回のStoreRecoveryState。取得成功後は後続失敗でも保持                                     |
| rearm_required    | AssessmentがInvalidInputを返した場合だけtrue                                               |
| outcome:Result    | Observed／NoWrite(reason)／Begun(receipt)／Stepped(receipt)、またはStore／Assessment error |

上位のResultだけで返すAPIにしない。clock評価後にDB操作が取消・Busy・Conflict等で失敗しても、評価済みのnext_stateとassessmentを返せることが目的である。StoreErrorを含むReport／Errorは内部Rust型とし、無理にSerializeやH1 DTOへ追加しない。

## 固定した処理順

1. 入力guard_stateをnext_stateへcloneした初期reportを用意する。
2. `recovery_state(control)`を一度呼ぶ。失敗ならStore error、assessment=None、recovery=Noneのまま返す。
3. 取得したrecovery、policy、sample、candidateを使い`assess_retention`を一度実行する。
4. 成功時はassessmentとnext_stateをreportへ必ず保存する。InvalidInputならrearm_required=true、Assessment errorで返し、job APIを呼ばない。
5. intentとactionを照合してNoWriteまたは最大一回のjob API呼出しを選ぶ。
6. job APIの結果をoutcomeに格納する。成功／失敗によらず先に保存したassessment／next_state／recoveryを保持する。

この呼出しはDB transaction一つに観測・判定・変更を包むものではない。recoveryはそのAPI内のsnapshotを閉じて返し、変更は既存begin／step APIの別transactionで実施する。その間の状態変化に対する防御は、既存CAS／active制約／step再送検査が担う。

## intentごとの実行規則

### Observe

recoveryとclock評価だけを行い、outcome=Observedとする。actionがProposeJobでもjobを作成しない。actionがExistingJobでもstepを実行しない。clockのSuspended等はnext_stateへ反映する。

Observeで使ったsampleを次のBeginへそのまま流用すると、H2c6の重複sample規則によりWaitForClockになる。Observeの外部proposalを認可tokenとして入力する経路は追加しない。実行意図のある呼出しではfresh sampleで判定と明示操作を同時に要求する。

### Begin(JobRequest)

新job APIを呼べるのは、今回のactionがProposeJobのときだけである。さらにrequest.cutoff_msがcandidateおよびproposalのcutoffと一致し、request.expected_cutoff_msが今回のfence／proposalの期待値と一致することを要求する。

- actionがWaitForClock、Deferred、NoAdvance、WaitForRecordingStop、ExistingJob等ならNoWrite(NotProposed)。理由はreport.assessment.actionから分かる。
- requestと今回の候補／期待fenceが異なればNoWrite(BeginRequestMismatch)。requestを書き換えたり、新しいcutoffへ補正したりしない。
- 条件が一致したら、callerが指定したjob IDとcanonical requestをそのままbegin_retention_jobへ一回渡す。

job IDの妥当性、同ID異payload、状態競合等は既存APIで検査する。IDを自動採番・再生成してConflictを回避しない。

開始済みjobのBegin再送をcoordinatorが暗黙に行うことはない。既存jobがactiveならaction ExistingJob、既にfenceが進んでいればNoAdvance等でNoWriteになり得る。このreportはbegin receiptではない。応答喪失に対して元canonical requestのreceiptを厳密に再取得したいcallerは、既存begin_retention_jobを明示的に呼ぶ。

### ContinueExisting(JobStepRequest)

callerは正確なjob ID、step番号、max_ticksを渡す。coordinatorはstatus.next_stepから新しい番号を選ばない。

- recovery.active_job=NoneならNoWrite(NoActiveJob)。CompletedJob出典があっても新しい削除を開始しない。
- active jobとrequest.job_idが違えばNoWrite(DifferentActiveJob)。現在の別jobへrequestを差し替えない。
- IDが一致すれば、そのJobStepRequestを既存step_retention_jobへ一回渡す。

現在のactive jobに対する過去stepの正確な再送も、この経路で許可する。保存済み同番号・同max_ticksは元receiptとなり追加削除しない。同番号のmax_ticks変更はConflict、未保存の先の番号はSequence等、既存APIの判定をそのまま返す。coordinatorがエラー時に番号を進めて再試行することはない。

完了済みjobや、現在のactive jobではない古いjobのstep receipt再取得は、既存step APIへ明示的に戻す。最終stepのCOMMIT後に応答を失い、coordinator再呼出しでNoActiveJobになっても、それを「元stepは失敗した」という意味に変換しない。recoveryのfence出典と元JobStepRequestを使って保存済みreceiptを確認する。

## clockと継続の関係

H2c6の評価はaction選択とは独立して必ず行い、ExistingJobを優先する場合でもclock異常をSuspendedへ反映する。ContinueExistingは、すでに始めたjobの固定cutoffに対するcallerの明示継続意図であり、新clockでcutoffを再認可・変更するものではない。

したがって、入力自体は正当でclockがSuspendedとなった呼出しでも、active job IDが一致する明示ContinueExistingは実行できる。next_stateのSuspendedはreportに保持し、後の新job開始を抑止する。新たな時計異常で既存jobを自動cancelしたり、そのcutoffを置換したりしない。

policy、guard、recovery、candidate等がInvalidInputの場合は別であり、Observe／Begin／ContinueExistingのいずれもその先の操作を行わず、rearm_required=trueで返す。

## failureと状態の保持

callerはoutcome=Errなら自動適用経路を停止し、前回proposalを流用しない。rearm_requiredは「全エラーが時計異常」という意味ではなく、H2c6のInvalidInputからの明示再設定要求に限定する。

- recovery取得前のDB失敗ではclockを評価できていない。next_stateは入力cloneで、正常sampleを採用したと扱わない。復旧後に新しいsampleでやり直す。
- clock評価後の取消／Busy／Conflict／SQLエラーでは、取得済みassessmentとnext_stateを保持する。特にSuspendedがDBエラーによって消えないことを保証する。
- InvalidInputでは旧stateを返却情報として保持しても、callerがそれをTrackingとして自動処理へ再投入してよいことにはならない。入力修正・明示rearmが必要である。
- FULL／I/Oは既存のNeedsReopen規律を維持する。coordinatorがpoisonを解除しない。
- COMMIT後の応答喪失に備え、callerはjob IDと正確なrequestを保存する。reportが得られたことだけを唯一の成功記録にしない。

clock stateはcallerがreportから引き継ぐ。coordinatorが内部で隠れたclock状態や未確定job IDを保持することはない。入力GuardStateを破壊的に変更しないため、callerは返却されたnext_stateを採用する責任を持つ。

## 有限予算とownership

同じQueryControlのdeadline／cancellation tokenをrecoveryとjob APIへ渡す。ただし各既存APIのBudget counterは独立である。Observe／NoWriteは最大一回のDB観測、操作実行時は観測と最大一回の変更、合計二回までとする。

したがって最悪の累積VM／decoded rows／byte上限は各API上限の二回分になり得る。例えばVMは最大二回分5M、decoded rowsは最大二回分9000。deadlineは共通なので各APIのために新しい10秒枠を作らない。SQLite／OS I/Oの硬い経過時間上限ではないという既存制約も維持する。

guard評価は固定サイズのDTOを用いる純粋処理。時計・policyを外部取得するネットワーク待ちや、jobが終わるまでのloopを追加しない。max_ticks、query evidence等の既存上限を緩めない。

writerは`&mut self`で同期使用し、既存readerのsnapshot／ownershipを保つ。recoverytransactionを閉じてから変更APIへ進み、二重transactionを作らない。coordinator自身に追加のhandlerを設置せず、各APIのOperation guard／rollback／直接poisonを再利用する。

## stale判定とrecorder協調

条件が合わない場合は理由付きNoWriteを返す。NoWriteは新規の書込みを試みていない結果であり、古い要求が未commitだったことや、今後の実行が許可されたことを表さない。

snapshot取得後にfenceが変わればbegin_jobのCAS、sessionが始まればactive制約、別jobが始まれば単一active制約で実行を拒否する。同じownerのRust呼出しは直列だが、契約と試験ではこの観測／適用境界を明示的に確認する。

WaitForRecordingStopからcoordinatorがsessionをcloseすることはない。hostはrecorderの停止・flush・正常終了時刻の取得を別に行い、fresh sampleと新しいrecoveryに基づいて再呼出しする。現在の実装にまだ存在しないrecorderや製品認証へ接続したとはしない。

## 受入

- ObserveでProposeJobが得られてもDBが変わらない。Observeの同sampleをBeginへ再投入しても重複sample規則を回避しない。
- freshな安定sampleと明示Beginでjobが一度だけ成立。cutoff／expected fence不一致はNoWrite、IDを勝手に変更しない。
- active sessionではNoWriteと停止待ち。sessionを暗黙close／interruptしない。
- ContinueExistingが指定した一stepだけを実行。正確な再送は元receipt、同step異max_ticksはConflict、先のstepはSequence。番号を自動選択しない。
- 別job ID、activeなし、完了済みjobはNoWrite。最終応答喪失は元requestによる直接receipt照会で確認できる。
- clock異常でSuspendedになった明示ContinueExistingの成功／取消／Busy等でも、next_stateに停止を保持。新Beginは止める。
- InvalidInputではrearm_requiredとAssessment error、DB変更なし。評価前Store errorではassessmentなしであることを区別する。
- 判定後の取消・fence競合・active session競合・SQLfailureをprivate試験境界で注入し、recovery／assessmentがreportから失われないことを確認する。
- 同じcontrolのdeadline／tokenを再利用し、操作数がObserve最大0変更、その他最大1変更であること。低予算でも無制限retryしない。
- 入力guardやpolicyを変更せず、結果next_stateを明示継承して次の呼出しを判断する。既存job／recovery／clock／FULL／ownershipの回帰を維持する。

H2c7は、個別に完成していた復旧・時計判断・保持操作を、誤再送や停止状態の消失を避けるhost入口へ接続する工程である。実行scheduler、policy配布、信頼時計adapter、timezone、recorder停止・再開、receipt GCはこのAPIが勝手に補うものではない。

## 実装と検証結果

`store::retention::coordinator`へCoordinatorInput／CoordinatorIntent／CoordinatorReport／CoordinatorOutcome／CoordinatorErrorと`coordinate_retention_once`を実装した。NoWriteReasonはNotProposed／BeginRequestMismatch／NoActiveJob／DifferentActiveJob。Report／ErrorはDebugのみで、製品transportやH1 JSONへ追加していない。

Rust workspace272件（新規16単体）・Clippy `-D warnings`／rustfmt・関連Chromium6件が成功。write拒否下のObserve、warmup／duplicateとBegin、cutoff／fence不一致、session停止待ち、異jobとactiveなし、最大一step、reopen後の正確な部分再送／異max_ticks Conflict／先番号Sequence、完了発見と直接receipt再取得を確認した。

取消・予算／期限・InvalidInput、判定後の取消／fence・session・job競合、SQL failure、実SQLite FULLでもreportと原子性を維持する。FULLではSuspendedとNeedsReopenを保持し、再open後に同じ明示stepを再試行できた。Astra実装レビューに必須修正はない。全体CIはPRで確認する。

DB format 4・H1・依存・SDK・Project・Bantoは維持する。TS／画面は変更せず、ブラウザでは既存H1／SQLite投影契約を回帰した。通常App・上流・S7・実環境には接続していない。
