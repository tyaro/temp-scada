# Historian H5c2: 記録計画のpreflightと明示的な置換

状態: 採用設計（Astra主設計）。2026-11-03（日本時間）。H5c1 managed Recorder／HostとH5c2a preflightは[PR #47](https://github.com/tyaro/temp-scada/pull/47)／[PR #48](https://github.com/tyaro/temp-scada/pull/48)でworkへ統合済み。H5c2bも[PR #49](https://github.com/tyaro/temp-scada/pull/49)でworkへ統合済み。H5c2c1も[PR #50](https://github.com/tyaro/temp-scada/pull/50)でworkへ統合済み。c2c2で同snapshotの診断とcaller提供SDK解決に束縛した明示resumeを実装した。実取得時刻や永久identityの証明は含めない。

[記録計画](historian-recording-plan.md)、[台帳](historian-recording-plan-ledger.md)、[activation](historian-recording-activation.md)、[所有者](historian-recording-host.md)、[保持協調](historian-recording-retention.md)を継承する。DB7、H1、Project 0.36.0、SDK/Banto/依存を維持する。実Hub/S7/設定/資格情報/本番DBへ接続しない。

## 採用するPR分割

| 工程              | 閉じる境界                                                                                                | 含めないもの                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| H5c2a（統合済み） | 既存HistoryReader leaseで、Running中にも使えるnative read-only mapping/apply preflight。writeと検証を共有 | Host停止、mapping/apply書込、SDK再解決、async supervisor     |
| H5c2b             | Hostの正常pause後、所有を失わず明示mapping登録または計画applyを1回実行。結果receiptと曖昧失敗を保持       | 複数commitを一括原子適用とする保証、自動resume               |
| H5c2c             | 単一supervisorでpreflight worker/stop/join/各管理turn/fresh解決結果/明示managed resumeを調整              | multigroup、永続task queue、自動接続設定、製品transport/auth |

c2aはworkのH5b2だけに依存する独立PRとして受け入れた。c2bはc1/c2a両方の統合後に実装し、c2cで停止前検査から再開までをまとめる。

## H5c2aの公開API

```rust
HistoryReader::preflight_recording_mapping(
    &mut self,
    request: &RegisterMappingRequest,
    control: &QueryControl,
) -> StoreResult<RecordingMappingPreflight>;

HistoryReader::preflight_recording_plan(
    &mut self,
    request: &ApplyRecordingPlanRequest,
    control: &QueryControl,
) -> StoreResult<RecordingPlanPreflight>;

pub struct RecordingMappingPreflight {
    pub snapshot_commit: u64,
    pub outcome: MappingPreflightOutcome,
}
pub enum MappingPreflightOutcome {
    Replay(MappingReceipt),
    Candidate { active_session_id: Option<String> },
}
pub struct RecordingPlanPreflight {
    pub snapshot_commit: u64,
    pub outcome: PlanPreflightOutcome,
}
pub enum PlanPreflightOutcome {
    Replay(RecordingPlanReceipt),
    Candidate { active_session_id: Option<String> },
}
```

報告型はClone/Debug/Serializeを提供できる。requestの期待版をreportに再保存しない。停止の必要性はactive_session_id.is_some()から導出し、重複boolを持たない。IDは同snapshotで検証したsessionのIDであり、現在のRecordingRun tokenやworkerが依然存在する証明ではない。

新APIはHistoryのH1 query/resultを変更しない。管理DTOはnative in-process専用。HTTP/TS transportは追加しない。invalid/Conflict/RecordingPlanCapacity/Busy/CorruptData/Control/SQL failureは既存StoreErrorで全要求errorとして返す。

## 結果の意味と判定順

要求は既存canonical helperで128KiB/depth/node制限と純粋検証を行う。BEGIN DEFERRED後、最初のlast_commit読取でsnapshotをpinする。全参照を同connection/transactionから読む。

1. 既存requestIdを探す。元要求がcanonical等値なら健全性を検証したReplay。別内容ならConflict。最新applied、現在job、現在CAS、容量によって元receiptを新要求へ変換しない。
2. 新規mappingはexpected mapping revision/current head、現在mapping本文、予約/永久metadata衝突、容量を検査する。
3. 新規applyはexpected applied/current head、現在applied本文、desired同ID/revisionのimmutable内容、定義/app容量を検査する。enabledの場合は現在mapping/保持版、固定member解決、永久metadataと予約のfirst-use証拠を検査する。disabledも既存完全形・None参照規則を維持する。
4. 同snapshotのrecovery証拠を読む。active保持jobがあれば新規候補はBusy。active sessionは破損検査を省略せず、正常ならそのID付きCandidateとして許容する。active sessionが無ければCandidateのIDはNone。
5. 出力予算と取消/期限を確認し、snapshotを閉じて返す。検査途中のcountsや片側だけの候補を返さない。

Candidateは「このsnapshotで、active session以外の検査済み事前条件が合う」を意味する。予約、承認token、future commitの保証ではない。UUID採番時のledger ID衝突、実SQL書込、FULL、close中の時計異常、将来のSDK解決成功は保証しない。初回ledger IDはwriteだけで発行し、preflightでは生成しない。

Replayは元操作の結果であり、現在applied/Runningの証明ではない。supervisorはReplayを理由に現workerを停止したり旧計画へ戻したりしない。必要な新設定は新requestIdと現在の期待版で明示する。

## mapping変更とapplyは別操作

c2aのapply preflightは**保存済みmapping**だけを参照する。未登録mappingの架空revisionや、未commitのmappingを注入してapply成功と見なさない。mapping登録のpreflightとapplyのpreflightを別snapshotで呼んでも一つの原子的previewにはならない。

mapping変更を伴う置換では、停止前にdesired純粋検証とmapping preflightを行えるが、登録後の新mappingに対する保存済みapply全検査は登録commit後となる。c2bはこの制限をreportで明示する。停止前の完全な複合previewが製品上必要になった場合は、仮想resolutionを扱う別契約を追加設計し、現Candidateを拡張解釈しない。

新mapping登録後にapplyが失敗しても旧appliedは変わらないがcurrent mappingは進んでいる。旧appliedでのmanaged再開はH5b2のcurrent mapping gateで停止する。自動的にmappingを巻き戻さず、保存receiptと現在状態を示し、再applyなどの明示的な回復を要求する。

## write検証の共有

recording_plan/write.rsからread-onlyのprepare_register/prepare_apply相当を抽出する。入力はconnection、同operation Budget、canonical request。結果はReplayまたは検証済みprepared candidate。preparedには必要なhead/resolution/definition等を保持できるが、public tokenにはしない。

共通helperはSQL書込、BEGIN/COMMIT、commit採番、UUID発行を行わない。writeはBEGIN IMMEDIATE内で同helperを使い、**新規候補のactive session/job拒否を必ず維持**してから保存する。preflightだけがactive sessionを許容する。mode差はprivate helperの引数または結果判定で表現し、publicなidle-check bypassを作らない。

receipt先行、first-use operation-wide cache、JOINによる本文取得、全canonical/hash/参照検査は維持する。preflightのためにreservation/body検査を複製しない。未参照の全過去receiptを再帰検証しない。

## reader所有・snapshot・取消

SqliteStore::reader()で発行済みHistoryReaderを使う。Historyと管理preflightの合計で既存2leaseまで。supervisor用に作るならwriterをRecordingHostへ移す前に1leaseを確保し、その間History用に残るのは1leaseである。既に2枠使用中ならBusy。第三connectionを直接開いて回避しない。

1readerは1操作ずつ実行し、History queryとpreflightを同時実行しない。idle readerもwriter lockのArcを保持する。writer drop後でもreader/実行中workerが残る間は他ownerをBusyにする。preflight完了後はtransactionを閉じるため、idle leaseがWAL snapshotをpinし続けることはない。

HistoryReader内部にprivateなrun_store_snapshot相当を設け、既存Snapshot guardのhandler解除→ROLLBACK→connection破棄を共有する。管理APIのStoreErrorを保持し、SQLite OperationInterruptedだけをtoken/deadline/work由来のControlへ変換する。一般SQL失敗をCancelledへ上書きしない。cleanup失敗はconnectionを破棄し、Control(ReaderUnusable)を返して再利用を拒否する。writerのneeds_reopen状態をreaderの障害から変更しない。

QueryControlのabsolute deadline/tokenはそのまま用いる。c2aは1API=1Budget、rowsは管理上限256、文書128KiB、合計入力8MiB、caller出力/VM予算を維持。SQLは通常課金する。panicでもguardを実行し、snapshotを残さない。実SQLite I/Oのhard停止は保証しない。

c2aに新async hostは必須ではない。統合試験ではowned readerをspawn_blockingへ移して実録画と並行できる。c2cでは専用の1request/1worker、borrowed join、exact process-local request tokenを持つownerを用意する。取消はrequestであって完了ではなく、旧workerがsettle/joinするまで新要求やlease返却を許さない。無制限queueやlatest-only結果配送は使わない。

## H5c2b/cの全体状態遷移

| 状態/明示操作                   | 次の状態と条件                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| Running → preflight             | writerはworkerに残る。候補の成功/失敗だけでは録画を止めない                         |
| preflight Replay                | 元receiptを返す。Running/appliedは変更しない                                        |
| Candidate → 明示replace要求     | 対象RecordingRunを照合しrequest_stop。期限/取消で未joinならStoppingを保持           |
| Stopping → join                 | SDK shutdownとRecorder cleanupを確認。正常Closed/許可terminalのみPausedClean        |
| cleanup/source/start障害        | RecoveryRequired。管理applyや自動resumeへ進まない                                   |
| PausedClean → mapping turn      | 最大1register。成功receiptを保持。次applyは別の明示turn                             |
| PausedClean → apply turn        | fresh preflight/期待版再照合後、最大1apply。保存成功はAppliedPaused                 |
| apply Err/応答喪失              | 自動再試行せずRecoveryRequired。mapping成功receipt等は失わない                      |
| AppliedPaused → 解決提示        | callerが新しいSDK generationから固定planを構築。適用specと全descriptorを照合        |
| 解決提示 → 明示resume           | 保持job/rearm/clean pause gateを満たし、新activation/session/epochでH5c1開始        |
| Starting → activation成功後失敗 | receiptとcleanupを保持。旧appliedへ自動rollbackしない                               |
| restart                         | 台帳/activation/保持復旧状態を照会。保存pinやactive receiptをworker再装着へ使わない |

supervisorはstop前のrun token、候補request、期待applied/mapping/保持版を束縛する。tickでsnapshot_commitが増えること自体をCAS不一致にしない。書込直前には実revision/immutable要求を再検査する。古いpreflight応答を別Project/別run/別候補へ適用しない。

台帳commit、SDK shutdown、source解決、worker稼働を一つのtransactionとは扱わない。mapping/apply/activationのreceiptはそれぞれ別で、途中成功分を消さない。stop/joinの外側timeoutも物理writer枠を解放しない。正常pauseとretention job_pending/rearm latchはH3dを維持し、計画変更で勝手にclearしない。

H5c2bのpaused管理turnはHostがstoreを一時的にblocking workerへ移す専用APIとし、任意callbackやtake_store→新Host再作成によるgate消去を通常経路にしない。結果には成功receipt、失敗分類、元run/要求tokenを保持する。停止前/管理turn中のcancelとcommit後latecancelを区別し、commit成功後のreceiptを取消で覆さない。

## H5c2a受入

- RecordingHost相当のwriterがtickを追加中、別readonly readerからmapping/apply Candidateを取得。snapshotを跨いだ混合結果を返さず、writerのsession/counterを変更しない。
- 全write authorizer拒否で両API成功。BEGIN/ROLLBACK以外の管理変更やcommit採番、予約挿入、UUID永続化がない。
- 既存同ID同内容Replayはhead進行/active job/容量到達後も元receipt。同ID別内容Conflict。Replayを新候補扱いしない。
- active sessionはCandidateにIDを返すが、同条件で既存writeを呼ぶとBusy。active保持jobの新規候補はBusy。idleならID None。
- desired immutable差、期待版差、別Hub/incarnation/series衝突、disabled完全形、未知mapping、破損metadata/first-use/保持receiptで全error。
- 32 origins・別保持revision・8member切替を既定256rowsで評価。予算超過は部分候補なし。
- 最初のsnapshot読取後に別writer commitを進めても旧snapshotで一貫する。次操作は新状態を返す。
- 低VM/bytes/期限切れ/取消、SQL失敗と取消併発、cleanup拒否、panicを検証。正常取消後はreader再利用可、cleanup失敗後はReaderUnusable。
- Historyとpreflightで合計2lease、3個目Busy、writer drop後もreader終了までlock維持。既存raw/minmaxを回帰する。

c2a完了で保証するのは、録画を止めずに保存済みDB条件に基づく候補検査を行えること。停止から適用/再開までの製品操作、fresh接続設定の証明、自動復旧はc2b/c以降であり、今回のAPIだけで実装済みと記録しない。

## H5c2aの実装と受入（2026-11-03）

HistoryReaderの2つのpreflight API、共有prepare、管理snapshot runnerを実装した。writeはBEGIN IMMEDIATE内でactive session/jobを拒否し、preflightは同じ判定からactive sessionだけを許容する。readerのhealthy状態を保持し、panic時のcleanup失敗も次のHistory/管理操作へ引き継ぐ。

新規native14件を含むRust workspace451件、Clippy／rustfmt、既存H1／desired契約のChromium8件と全体Prettier・文書リンクが成功した。記録中の同snapshot、replay／競合／容量、32 origins／別保持版／8memberの256行予算、取消／SQL失敗／panic／cleanup拒否、2leaseとwriter lockを確認し、Astraの最終レビューに必須修正はない。全体CIはwork向けReady for Review PRで確認する。

H5c1とはworkベースの独立差分であり、同PRの実装や検証件数を本工程に混ぜない。c2bのHost管理turnは次節へ実装を記録する。停止／再開supervisorとfresh SDK解決の調整はc2cの後続である。

## H5c2b: 正常pause後の一回の計画管理turn（採用詳細）

2026-11-03、PR #47/#48のwork統合後に採用。以下はc2bの実装契約であり、本節追記だけで実装完了とは扱わない。DB7/H1/Project/SDK/依存を変更しない。

### 範囲と公開入口

正常な録画終了をjoin済みのRecordingHostから、mapping登録またはdesired applyを一回だけ実行する。初期Idle Hostからの初回設定は許さない。初回設定はHost::new前の既存SqliteStore APIで行い、clean pause gateに例外を作らない。preflight/stop/joinを自動連鎖するsupervisorやSDK解決はc2cに残す。

```rust
pub enum RecordingPlanTurnIntent {
    RegisterMapping(RegisterMappingRequest),
    Apply(ApplyRecordingPlanRequest),
}
pub enum RecordingPlanTurnReceipt {
    Mapping(MappingReceipt),
    Applied(RecordingPlanReceipt),
}
pub struct RecordingPlanTurnCompletion {
    pub run: RecordingPlanTurnRun,
    pub recording_run: RecordingRun,
    pub outcome: StoreResult<RecordingPlanTurnReceipt>,
}

RecordingHost::start_recording_plan_turn(
    &mut self,
    recording_run: &RecordingRun,
    intent: RecordingPlanTurnIntent,
    control: QueryControl,
) -> Result<RecordingPlanTurnRun, RecordingHostError>;

RecordingHost::cancel_recording_plan_turn(
    &mut self, run: &RecordingPlanTurnRun,
) -> Result<(), RecordingHostError>;

RecordingHost::join_recording_plan_turn(
    &mut self, run: &RecordingPlanTurnRun,
) -> Result<Arc<RecordingPlanTurnCompletion>, RecordingHostError>; // async
```

RecordingPlanTurnRunはArc pointer identityによるprocess-local token。RecordingRunと別型にし、serializeしない。joinのOkはworker join完了だけを表し、native成功はcompletion.outcomeで判断する。raw StoreErrorはcompletion側だけに置く。

### 元録画のbindingと共通gate

startのrecording_runは最新joined RecordingCompletion.runとpointer等値を要求する。sessionId/ProjectID/PlanRefが同じでも代用しない。他Hostのtoken、過去録画tokenはRecordingRunMismatchで拒否する。

recording/retention/plan turnは一つのwriter枠を共有する。いずれかのworkerが存在すれば完了済み未joinもBusy。Faulted、NoStore、未join、初期Idle、UncleanPauseも拒否する。clean pauseは既存のstart_error無し、SDK shutdown成功、許可terminal、Closed cleanupで判定する。

retentionのjob_pending/rearm_requiredが立っていればplan turnも拒否する。管理操作で保持latchやguard stateを変更しない。新しいplan recovery_requiredが立っている場合は後述の回復に限定する。

受理前にrequestの純粋canonical検証と128KiB/depth/node上限を確認する。必要なら既存canonical helperを呼ぶrequest.validate公開wrapperを追加し、型/予算規則をruntimeへ複製しない。構造不正、元run不一致、NoRuntime等の同期拒否ではstoreを移さず、completion/receipt/latchも変更しない。

### workerと予算

受理したら元recording completionを残し、storeを一つのspawn_blocking workerへ移す。phaseはManagingPlan。workerはintentに対応する既存register_recording_mappingまたはapply_recording_planを**一回だけ**呼ぶ。preflight再実行や次のapply、activation、SDK起動を追加しない。native transaction内の共有prepare/CAS/idle検査が権威である。

QueryControlのdeadline/token/limitsをそのまま渡す。blocking poolでの待ち時間もdeadlineに含め、再発行しない。cancelは同tokenを立てるだけである。API一回分の管理256rows/文書128KiB/合計入力8MiB/output/VM上限を使い、別の無制限queueを作らない。

commit前取消は既存nativeのrollbackへ、成功commit後latecancelは成功receiptへ進む。worker返却後に取消flagだけを見て成功をerrorへ変えない。cancel済みでnativeがErrを返した場合は、未commitだとHostが推測してlatchを省略しない。

### join、Drop、stale token

joinはHost内のJoinHandleをborrowしてawaitする。外側timeout/取消後もstore/task/tokenをHostに保持し、同じtokenでjoinし直せる。異なるtokenで現在workerをjoin/cancelせず、PlanTurnMismatchを返す。最新完了turnに対する再joinは同じArc、latecancelは成功結果を変えないno-op。他のturn受理後は旧tokenを拒否する。

全既存入口（recording start/join、retention start/join/rearm、take_store）へplan workerのBusy gateを追加する。plan joinにもrecording/retention workerのBusy gateを置く。store Optionの有無だけに頼らない。

Dropはplan tokenもcancelし、blocking taskをabortしない。detached workerがstoreを保持してnative cleanupを終えるまで物理writer lockは解放されない。panic/join failureはFaulted。storeはworker unwindでdropされ、reader leaseが残る場合は引き続きlockを保持する。Host内に見せかけのstoreを再生成しない。

### 結果と過去成功receiptの有限保持

workerからstoreとcompletionを回収しphaseをJoinedへ戻す。元RecordingCompletionは書き換えず、新たな録画成功として扱わない。新しいturnを受理すると最新turn completionだけを無効化し、joinの対象を曖昧にしない。新録画startの受理時も旧turn completionを無効化する。

最新completionとは別に、成功mapping receiptと成功apply receiptを各1件だけ保持する。各成功記録は元RecordingRun、turn token、対応receiptを含む。新turnの失敗、取消、最新completion無効化、新録画startで過去成功記録を消さない。次の同種成功でその1件を置換し、全receipt queueを作らない。callerが保持するArcは不変である。

読み取り専用のplan turn state getterでrecovery_requiredとこの最新成功2種を取得できるようにする。これは最後に成功して返った結果であり、最大revisionや現在appliedを示すキャッシュではない。古いrequestIdのReplay成功も元receiptとして保持する。現在appliedを知るにはDB状態照会を使う。既存watchへDB本文やraw errorを追加せず、phaseと有限の安全な診断に限定する。

### 失敗とuncertainty latch

受理後のnative ErrはConflict/Busy/Controlを含めすべてplan recovery_requiredをstickyにする。細かな未commit証明をHostへ複製しないための保守的規則であり、commit済みとの断定ではない。最新completionのerrorと、前段で成功したmapping/apply receiptを両方保持する。

このlatch中は次のplan turn、manual/managed recording start、retention turn（Observeを含む）、retention rearmをPlanRecoveryRequiredで拒否する。過去のclean recording completionや取消解除で消さない。c2bではplan rearm/clear APIを作らず、自動retry/resumeも行わない。

回復経路は、実workerをjoin後にtake_storeし、既存receipt/state照会と必要ならdrop/reopenを明示的に行うこと。requestIdと元要求を保持し、成功の有無と現在headを区別する。新Hostへ移す場合も、保持job/時計rearm/計画状態を確認してから明示再開する責任がcallerにある。通常の成功pathでHostを作り直してgateを消す方法は使わない。c2cでこの回復を所有者の状態遷移として統合する。

### mapping/applyと再開

正常Joinedでmapping turn成功後、同じ元RecordingRunを指定してapply turnを明示実行できる。二つは別commit。mapping成功後apply失敗ならmapping receiptは残り、旧appliedも残るがcurrent mappingは進む。この状態を成功済み全体置換とは表示しない。

両方成功後の明示managed startはH5c1の全gate・全descriptor照合・現在applied/mapping/保持版CASを使う。新activation/session/clockEpochを要求する。disabled applyならmanaged開始は拒否される。古い成功receiptをactivation許可tokenとして使わない。SDK source/pinのfresh解決は本turnで行わない。

### c2b受入

- 初期Idle、Running、finished-unjoined、unclean cleanup/source failure、元run違い、別Host token、保持job/rearmで同期拒否しstore/成功receipt不変。
- 正常join後mapping→applyの2turnが各1commit。成功receipt/元run/turn tokenが一致し、raw/metadataを意図せず記録しない。
- 同request exact replayは元receipt。別内容Conflict時はlatchを立て、前段成功receiptを維持。Replayを現在appliedと誤表示しない。
- 制御blocking gateでjoin取消・再join・全他入口Busy・Drop lock保持。stale turnのcancelが新turnへ届かない。
- 元deadlineがqueue中に切れる、取消、SQL/FULL、panic、cleanup拒否。native Err後は次start/turn/rearmを拒否し、join後take_storeの回復経路は残る。
- commit成功後latecancelで成功receiptを維持。mapping成功後apply失敗でもmapping receiptが取得できる。
- 正常managed録画→join→mapping/apply→新managed録画→raw/minmax。元receipt再装着やdomain間のsamplingMissed捏造がない。
- 既存manual Host/retention turnを回帰し、plan turnとの一枠所有、保持guard/latch非変更を確認する。

## H5c2bの実装と受入（2026-11-03）

`RecordingHost`のplan turnは元録画の正常joinを要求し、mapping／applyのnative書込を各一回実行する。`RecordingPlanTurnSuccess<R>`に元run・turn tokenと対応receiptを保持し、最新completionの無効化や後続失敗でも各種最後の成功を失わない。privateな実行strategyは故障注入試験でも同じ受理／join経路を使い、公開callbackや独自transactionを追加しない。

新規runtime単体12件・mockHub統合3件を含むRust workspace487件、Clippy／rustfmt、既存H1／desired契約のChromium8件、全体Prettier・文書リンクが成功した。native既存試験でactual FULL／rollback拒否を回帰し、Hostでは制御workerによるI/O・応答喪失・panic・latecancelと所有保持を確認した。Astra最終レビューに必須修正はない。全体CIはwork向けReady for Review PRで確認する。

同じHostのmanaged録画からmapping/apply、新activation/session/epochでの再録画、raw/minmaxまでを確認した。mappingだけのcommit成功、旧applied維持、recovery latchでの再開拒否も確認した。通常App・自動supervisor・fresh解決調整・製品transportは本工程に含めない。

## H5c2c1: 単一supervisorの候補検査・明示pause・一回実行

採用詳細、2026-11-03。PR #49統合後の次工程。c2c全体をさらに分け、今回c2c1はpreflightから元候補の一回実行までを実装する。c2c2はfresh解決/resumeと回復snapshotの統合へ残す。既存manual/managed開始の明示委譲は提供するが、SDK解決をsupervisorが新たに行う意味ではない。

### 所有とfactory

RecordingSupervisorはRecordingHostと専用HistoryReaderを所有する。構築時に同じSqliteStoreからreaderを一つ取得してからHost::newへstoreを移し、別storeのHost/readerを組み合わせる入口は作らない。

```rust
RecordingSupervisor::try_new(store: SqliteStore)
    -> Result<RecordingSupervisor, Box<SupervisorInitError>>;

pub struct SupervisorInitError {
    pub error: StoreError,
    pub store: SqliteStore,
}
```

既存2reader枠を共用し、factory時点で枠が埋まっていればBusyと元storeを返す。専用leaseがidleでも1枠を占有する。通常Historyに使える残りは1枠。専用reader/hostの可変参照をpublicにせず、host_mutや任意callbackでticketの検査を迂回させない。

recording workerとpreflight reader workerは並行できる。writer枠は引き続きrecording/retention/plan turnの一つだけ。preflightは一つの物理worker、保留queue無し。結果はrequest/responseでありlatest watchによる配送にしない。

### APIとticket

```rust
start_preflight(intent: RecordingPlanTurnIntent, control: QueryControl)
    -> Result<PreflightRun, SupervisorError>;
cancel_preflight(run: &PreflightRun) -> Result<(), SupervisorError>;
join_preflight(run: &PreflightRun)
    -> Result<Arc<PreflightCompletion>, SupervisorError>; // async

request_pause(run: &PreflightRun) -> Result<(), SupervisorError>;
join_pause(run: &PreflightRun)
    -> Result<Arc<RecordingCompletion>, SupervisorError>; // async
execute_candidate(run: &PreflightRun, control: QueryControl)
    -> Result<RecordingPlanTurnRun, SupervisorError>;
discard_candidate(run: &PreflightRun) -> Result<(), SupervisorError>;
```

PreflightRunはprocess-local exact tokenで、RecordingRunやRecordingPlanTurnRunと別型。PreflightCompletionにはpreflight token、元RecordingRun、mapping/planのどちらかのtyped preflight reportまたはStoreErrorを持つ。要求は外から書き換えられないowned intentとしてsupervisor内部に保存する。結果を改造して戻すAPIや外部生成ticketを受け付けない。

start_preflightはHostがRunningまたはJoinedで、元RecordingRun/sessionIdを取得できる時だけ受理する。初期Idle、Starting、FinishedUnjoinedは拒否する。FinishedUnjoinedでは録画joinを先に行う。plan/retentionの実行中も拒否する。guard/latch、候補要求の純粋検証を共有し、すでに回復が必要なownerを新候補で正常扱いにしない。

物理preflight workerが存在すれば完了未joinもBusy。未消費Candidate ticketが残る場合も新preflightはBusyとし、明示discardが必要。Replay/errorの完了結果は新preflight受理時に置換できる。同期拒否では現ticket/receiptを失わない。

### preflight worker

専用readerをspawn_blockingへ移し、intentに対応するnative preflightを一回だけ呼ぶ。元QueryControlのdeadline/token/limitsをそのまま使用する。CPU待機やpool待ちを含めdeadlineを延長しない。writerにstopを送らず、snapshotのactive session IDをreportへ保存する。

joinはborrowed JoinHandleをawaitし、future取消後もreader/taskを所有し続ける。exact token以外のjoin/cancelは拒否する。成功join後だけreaderを回収し、最新completionのArcを保持する。再joinは同じArc、latecancelは結果を変更しない。cancel→即新queryという物理要求増殖は許さない。

ReaderUnusableはstickyで、そのreaderの新preflightを拒否する。panic/join failureではreaderを偽って復元しない。いずれもrecording workerへ自動stopを送らない。通常のsource/recording障害は引き続きRecordingHost側が判断する。

### Candidateからの明示pause

request_pauseはjoin済みCandidateだけを受け付ける。Replay/errorなら拒否し、旧workerに触れない。元RecordingRunが現在Host runとpointer等値で、reportのactive_session_idがSomeなら開始時に保存したsessionIdと完全一致することを要求する。別sessionを停止対象へ推測しない。

一致した場合にだけHost.request_stopを呼び、ticketへpause要求済みを記録する。preflight後に自然終了した場合も、明示pauseを受理してからjoinする。Candidateのactive_session_id=Noneは現在writer停止の証明ではなく、Hostの実join/cleanupを省略しない。

join_pauseはpause要求済みticketと同じrunを再確認し、Host.joinをborrowed awaitする。外側timeout後も同ticketで再joinでき、未joinのwriter枠を解放しない。結果を返すことと正常pause成立を区別し、cleanup/start/source failureならcandidate実行へ進まない。正常pauseかどうかはc2bのHost gateが最終権威である。

### 同一候補の一回実行

execute_candidateは物理preflightがjoin済み、元run等値、pause要求とjoin完了済み、Candidate未消費を要求する。保存した同一intentをHost.start_recording_plan_turnへ渡す。callerから新requestやrevisionを差し込ませない。

c2bに受理された時点でticketを消費する。外側timeout/取消後にexecuteを再実行して別mutationを作らない。plan turnのexact join/cancelを委譲し、元tokenで結果を回収する。c2bの同期拒否ならcandidateは消費しないが、gateを解除したとは扱わない。native Errなら既存plan recovery latchを維持する。

preflightのsnapshot commit一致をwrite CAS条件には追加しない。recording tickでcommitが増えても正常であり、write transactionが実際のrevision/immutable条件を再検査する。候補照会からstop/joinまでの間にcurrent headが変われば、writeがConflictになる。preflight tokenはDB予約や認可の証明ではない。

mapping turn完了をjoinした後、同じ元RecordingRunに対し次applyのpreflight→明示pause/join（すでにJoinedなら確認）→executeを行える。mapping/applyは別commitで、間の成功receiptはc2bの各1件保存を維持する。disabled applyや古いreceipt Replayを新運転許可へ変換しない。

### 開始委譲・破棄・安全停止

既存manual startとmanaged startを明示委譲する。managedの引数はcaller-confirmed SdkRecorderPlan/options/binding/control/clientであり、H5c1の全descriptor/current版/新activation/session/epoch検証を省略しない。

物理preflightが実行中または完了未joinならstartはBusy。未消費Candidateが残る場合もBusy。discard_candidateは最新exact token、物理worker無し、未実行Candidateを明示破棄する操作であり、recordingを再開/停止したりDBを変更したりしない。worker中の破棄は拒否し、cancel→joinが必要。plan turn実行中にも破棄しない。

新recording startが受理された時点で旧preflight completion/ticketを無効化する。同期start拒否では候補を失わない。古いpreflight結果、元run、pause完了を新runへ流用しない。c2bの成功receipt各1件は引き続き保持する。

利用者の安全停止のため、preflightの有無にかかわらずrequest_stop_recording/join_recording相当の明示委譲も提供する。この操作だけでcandidate実行条件が成立したとはせず、executeにはticket固有のpause/join確認を要求する。preflightのReaderUnusable/panicでもrecording停止・joinを妨げない。

### 回復とc2c2境界

c2c1に新native read APIは不要。既存c2a preflightとc2b transactionの再検証だけで正常pathを閉じる。回復用latest applied/activation/保持状態をreaderから統合照会する機能、SDK解決のfreshness調整はc2c2で設計する。

回復用take_storeはpreflight/taskと全writer workerがjoin済みの場合だけ許す。Host.take_store成功後に専用readerをdropし、supervisorをNoStore相当へ移す。Host側拒否ならreaderを先に失わない。外部のHistory leaseが残るならその解放も必要。reader panicで専用readerが失われても録画join後のstore回収は可能にする。plan recovery latchを消して通常resumeへ戻すAPIは作らない。

Dropはpreflightとrecording/plan workerへ取消要求を送り、blocking taskをabortしない。それぞれのworker/leaseが実処理を終えるまでlockを保持する。外側timeoutをcleanup完了とは表示しない。

### c2c1受入

- factoryが同storeのHost/readerを作る。既存2lease時にはBusyと同storeを返し、所有喪失なし。専用readerを含め合計2枠。
- mockHub録画中にpreflight成功してもtickが続く。Replay/errorではstopされない。Candidate後も明示pause前は録画継続。
- pause/join→同一intent一回実行→receipt、mapping後applyの新preflight。変更した外部requestや古いtokenを使えず、duplicate executeでcommitが増えない。
- 取消非協力的な制御worker、join timeout、完了未join、stale cancel、低予算/期限で物理1枠と元deadlineを維持。
- 自然終了・source障害・別run・不一致session・native Conflictを検査。正常pause以外でexecuteせず、snapshotが古くてもwrite CASが権威。
- Candidate保持中の新start拒否、明示discard、成功start時だけ旧結果無効化。失敗startでは候補不変。
- reader cleanup失敗/panicでも旧録画を自動停止せず、安全停止/join/take_store可能。Dropでreader/writer lockの寿命を守る。
- 正常停止後のcaller-confirmed managed開始委譲は既存H5c1の契約を維持するが、supervisor独自のfresh SDK解決・自動resume実装とは記録しない。

## H5c2c1の実装と受入（2026-11-03）

`RecordingSupervisor`のfactoryが同storeのHost/readerを作り、失敗時はBox付きInitErrorで元storeを返す。公開APIは元run/sessionとowned要求を保存し、検査workerのjoin後にだけ候補を形成する。明示pause/joinの正常確認後、同じintentをc2bへ一度渡し、受付済み候補の再joinで消費状態を復活させない。正常開始時だけ旧結果を無効化し、reader障害でも安全停止とwriter回収の入口を維持する。

新規runtime単体15件・mockHub統合3件を含むRust workspace505件、Clippy／rustfmt、既存H1／desired契約のChromium8件、全体Prettier・文書リンクが成功した。Astraの最終read-onlyレビューに必須修正はない。元control・2lease・取消安全性・reader障害時の停止回収、Replay/errorでの録画継続、自然完了、候補の一回実行、caller-confirmed再録画とraw/minmaxを確認した。全体CIはwork向けReady for Review PRで確認する。

検査readerの障害注入は所有・停止回収の受入で、actual snapshot cleanup拒否は既存native回帰に含める。c2c2のfresh SDK解決・明示resumeと回復snapshotの調整は未実装。既存開始の委譲だけでfreshnessを証明したとは扱わない。

## H5c2c2: 同snapshot診断とcaller解決に束縛した明示resume

採用詳細、2026-11-03。c2c1統合後に実装する契約。DB7/H1/Project/SDK/依存を維持し、今回は管理snapshotと明示resume準備/開始を一工程で閉じる。自動再接続、接続設定配布、時計trustの発行、認証、異常latchの自動解除は含めない。

### native同snapshot view

```rust
HistoryReader::recording_resume_state(&mut self, control: &QueryControl)
    -> StoreResult<RecordingResumeState>;

pub struct RecordingResumeState {
    pub snapshot_commit: u64,
    pub plan: RecordingPlanState,
    pub latest_activation: Option<RecordingActivation>,
    pub recovery: StoreRecoveryState,
}
```

既存readerのstore_snapshot runnerで一度だけBEGINし、最初のlast_commitでpinする。plan stateのcurrent mapping/applied、latest activationと可変session状態、保持fence/job/policy/active sessionを同connection/同Budgetから取得する。内包するsnapshot_commitは外枠と一致する。個別public APIを順に呼んで結果を結合しない。未知をNoneとして正常に返すのは証拠が本当に無い場合だけで、head/参照破損はCorruptData。

read::state_from_headsとactivation::read::load_with_cache相当の内部helperを共有する。operation/snapshot内だけでEvidenceCacheを共有し、full application検証済みcacheとfirst-use用のreceipt本文未検査cacheを分離する。first-use hitをfull receipt検証の代わりにしない。同じcurrent/latest revisionはfull検証を共有できるが、別revisionの予約・恒久metadata・元receipt照合を省かない。cacheの参照snapshot/ledger/commit条件は維持する。

最新appliedとlatest activationが別8member群で、series/segment別32 origins・異保持版を持つ正常例は、cache共有後も256行を越えることを実測した。この複合read専用上限は768 decoded rows（3つの既存管理読取各256行に相当）とする。既存個別APIの256上限は変えず、callerがより小さい限度を指定すればそれを優先する。同fixtureは既定上限で成功し、明示256行ではWorkLimitになることを回帰する。VM、8MiB合計入力bytes、出力、絶対deadline/tokenは一つで、3回分へ延長しない。

### runtime inspection owner

```rust
start_resume_inspection(control: QueryControl)
    -> Result<ResumeInspectionRun, SupervisorError>;
cancel_resume_inspection(run: &ResumeInspectionRun) -> Result<(), SupervisorError>;
join_resume_inspection(run: &ResumeInspectionRun)
    -> Result<Arc<ResumeInspectionCompletion>, SupervisorError>; // async
```

既存専用readerの物理1枠をpreflightと共有する。新connection/leaseを追加しない。exact token、borrowed join、完了未join Busy、元deadline/token、ReaderUnusable/panic、Dropの規則も共有する。preflight型とinspection型は混同できないtokenとする。

inspectionは診断なのでInitialIdle、Running、正常/異常Joined、plan/retention latch中にも読める。管理write中、未消費Candidate、未消費resume ticket、別reader worker中はBusy。進行中recordingを停止しない。新しいinspection受理で古いinspectionを無効化するが、同期拒否では結果を保持する。

completionはrequest token、取得開始時のOption<RecordingRun>、native viewまたはStoreErrorを保持する。初期Idleはrun無しというowner contextを束縛する。Hostのguard snapshotも別のプロセス内診断として示せるが、DB snapshotの一部と偽称しない。inspection成功/errorでplan/retention latch、clock guard、session状態を変更しない。

### SDK coherent解決の意味

固定SDKのGenerationSnapshotはcatalog/resolution/valuesを一つのgenerationとして公開し、既存SdkRecorderSourceは一回のhandle.state()から得たArcを使う。SdkGenerationPinのrun_id/catalog revisionやStableTagIdは、Hub instance/incarnationの永久性・認証・取得時刻の証明ではない。

新入口ではcallerが現在のcoherent GenerationSnapshotを明示的に提供する。DB inspection後にfresh取得したという責任はcallerに残る。API呼出順、generation番号、callerのUTC申告だけでは、渡されたArcが実際にinspection後fetchされたことを証明できない。本実装は「caller提供の一個のsnapshotとの整合」を保証し、ネットワーク鮮度やendpoint同一性を保証しない。saved pinの自動再利用や同名別tagへの自動追随はしない。

```rust
pub struct ResumeResolution {
    pub sdk_snapshot: Arc<GenerationSnapshot>,
    pub session_id: String,
    pub clock_epoch: String,
    pub activation_id: String,
    pub slot_count: Option<u64>,
    pub max_clock_skew_ms: u64,
}

prepare_resume(inspection: &ResumeInspectionRun, resolution: ResumeResolution)
    -> Result<ResumeTicket, SupervisorError>;
resume(ticket: &ResumeTicket, control: QueryControl, client: RestClient)
    -> Result<RecordingRun, SupervisorError>;
discard_resume(ticket: &ResumeTicket) -> Result<(), SupervisorError>;
```

ResumeTicketはprocess-local exact token。prepared plan/options/bindingはsupervisor内部のowned値として保持し、resumeで別plan/期待版を差し込ませない。prepareはSQL/ネットワークを実行せず、snapshot全体をclone/serializeせずArcを借用して最大8pinsを抽出する。

prepare条件は以下のとおり。

- 最新の成功inspection、取得時と現在の同じRecordingRun（または同じ初期Idle context）。reader workerなし、未消費変更候補なし、管理workerなし。
- HostがInitialIdleまたはclean Joined。plan recovery_required、retention job_pending/rearm_requiredはいずれも無し。異常Joinedをinspection成功で初期状態へ戻さない。
- view内active session/job無し、現在appliedがenabled。current mapping/current保持policy版がapplied参照版と一致する。保存済みresolution全descriptorをSessionSpecへ使い、PlanRef/期待版もviewから取得する。
- caller指定の新session/clockEpoch/activationIdと周期/slot/skewを既存純粋規則で検査する。DB内の全過去ID/epochとの衝突判定はH5c1/H5b2が最終権威である。
- 全memberについてSDK bindingがresolvedであること。seriesIdをbinding keyとしてexternalName/tag_key/StableTagId/data_type/unit/enabledとValueEntry.value_sourceを照合し、そのsnapshotからpinsを作る。DBのhub_instance/incarnationをSDK番号から生成しない。
- 既存projectionのgeneration整合・型・source・有限予算規則を再利用する。Bad/Stale品質そのものはidentity不一致ではなく、既存の無値記録規則を維持する。unresolvedやresolved value欠落はこのresume準備では拒否し、旧pinsで補完しない。通常の既存source captureが切断時にnullを返す契約は変更しない。

SDK入力には既存4096 catalog/values・最大8resolutionの上限を適用する。新しい純粋入口で走査/hashする文字列にも合計8MiBの有限budgetを設け、巨大caller構築snapshotを無制限に処理しない。超過時はprepared ticketを作らない。projection検証のために作る一時observationは保存しない。

### resumeと失敗

resumeはticket/context/Host guardを再検査し、保存したplan/options/bindingをH5c1 managed開始へ渡す。受理時だけticket/inspectionを消費・無効化する。同期拒否では保持する。新しいpreflight/inspection/通常startへ切り替えるには未消費resume ticketの明示discardが必要。discardはDBを変更せず、runを停止/開始しない。

start受理、native activation成功、SDK Live、初回tick、Runningを区別する。専用SDK ownerはresume時に新しく作るため、提供snapshotとの間に変化があれば既存run/catalog/source gateが停止する。接続待ちのnull、Bad/Stale、capture異常は既存source契約に従う。prepared snapshotがあることを将来の全sample品質保証とはしない。

H5c1はworker開始時に現在DB版/固定specを再検査し、実clock anchorで専用activationを行う。inspectionのsnapshot_commitそのものをCASにせず、tickや無関係な管理commit増加だけでは拒否しない。applied/mapping/保持版変化は実revision照合で拒否する。ActivationUnconfirmed、成功後latecancel、receipt保持、SDK shutdown、clean pause gateを変更しない。

初期Idleでの明示resumeは既存Hostの初回開始と同じ許可範囲であり、自動復旧ではない。再openが旧activeをinterruptedへ確定した後でも、旧activation/session/clockやpinを再装着しない。異常Joinedまたは既存latchがあるownerからはresume不可のまま。inspectionを表示し、join/take_store/reopen等の明示回復へ戻す。

### c2c2受入

- native: 同snapshotのcurrent applied/mapping、別版latest activation、保持policy/fence/job/active session。途中writer commitでも混合世代を返さず、次inspectionで新状態が見える。
- native: 全write authorizer拒否、32 origins/異保持版の最悪正常構成、corrupt head/旧receipt/metadata、容量/bytes/VM/取消/cleanup/panicを検査。cache hitで本文検証が消えない。
- runtime: preflight/inspectionで物理1枠・合計2lease、取消safe join、stale token、完了未join、ReaderUnusable、Drop/回復store取得。
- runtime: 異常Joined/plan latch/保持jobでも診断は取得できるがprepare/resumeは拒否。inspectionがlatchをclearしない。
- pure SDK: 全resolvedのnumber/bool/Bad/Stale/SIM/UnknownSource、tag/type/unit/source/run/catalog差、重複/未解決/上限、別namespace相当のDB identity差を検査。sourceの正常無値規則を変更しない。
- mockHub: inspection→caller提供のcoherent snapshot→prepare→明示resume→activation receipt/tick/raw/minmax。candidate/inspection/request tokenの差替え、同期拒否後ticket保持、受理後再使用拒否を確認。
- race: inspection後に版が変わる、SDK source世代が変わる、時計が変わる場合に、古い証拠で記録を継続せず既存gateで停止する。旧receiptを新workerへ流用しない。

c2c2完了の表現は「同snapshotの復旧診断と、callerが提供したcoherent SDK解決に束縛した明示resume」。実Hubからのfresh取得証明、永久identity発行、自動リカバリ、製品認証/transportの完成とは記録しない。

受入結果: native7件・SDK解決4件・runtime単体10件・mockHub統合3件を追加し、Rust workspace529件と既存契約のChromium8件が成功した。Astraの最終レビューに必須修正はない。次のH5dはProject desired保存・編集と管理状態表示を設計する。
