# 記録計画の明示管理操作契約

状態: **H5d4aの純粋JSON契約を実装、d4b/cは未実装**。2026-11-03（日本時間）。主設計はユーザー指定のAstra。操作・結果照会のschema、Rust／TypeScript validatorと全文一致を提供する。操作service・controller・UI・native adapter・製品transportは後続。

## 1. 初回scopeとPR分割

[Project連携H5d4](historian-recording-project.md#h5d4-明示操作と継続するowner)を具体化する。初回は**登録済みmappingに対するdesired apply**だけを提供する。同じ既存RecordingRunを対象に、利用者が検査、pause/join、applyを別々に明示する。enabled=falseも設定のcommitであり、画面を閉じる操作や一時pauseと同一視しない。

| 工程  | 成果物と受入                                                                                                        | 対象外                                          |
| ----- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| H5d4a | 操作用の独立JSON schema、TS/Rust pure validator、全文照合、共通fixtureとbrowser module評価                          | controller、操作UI、native adapter              |
| H5d4b | 外部ownerを前提とするoptional操作capability、有限なApp操作monitor、三段階UI、test-only service注入による通常App受入 | 実native接続、製品transport、結果不明の自動解消 |
| H5d4c | supervisorへのprojection／opaque handle対応、所有・join・receipt再照合のnative adapterを別途実装・隔離環境で受入    | 認証・製品transport・実Hub/S7/本番DB            |

d4aで独立contractを実装し、Project 0.37.0／DB7／H1／SDK／依存版を変えず、同期拒否・受付・commit・不明の意味を共通検証できる。次はd4bの外部owner・注入service・操作表示へ進む。d4bのmock受入をnative mutationの完成と称さない。d4cで必要なread-only reconciliationやowner公開面は実装前レビューし、既存APIに存在するかのように先行記載しない。

新mapping発行・自動登録、Hub identity解決、fresh SDK解決／resume、initialIdle／新規store bootstrap、複数group・自動schedulerは初回capabilityに含めない。初期設定は現nativeのHost構築前手順に留め、browser bootstrapは別capabilityと受入を要する。apply成功後はpause済みのままで、Runningへ自動遷移しない。

## 2. 現行nativeに沿った権威と限界

根拠は[supervisor](../../../crates/scada-runtime/src/recording_host/supervisor.rs)、[plan turn](../../../crates/scada-runtime/src/recording_host/plan_turn.rs)、[native preflight](../../../crates/scada-historian/src/store/recording_plan/preflight.rs)、[採用supervisor設計](historian-recording-supervisor.md)。

- start_preflightはRunningまたは正常Joinedだけを受理し、元RecordingRun・session・owned intentを保持する。initialIdleでは使えない。plan recovery、保持job pending、保持rearm、reader／別操作のBusy gateを迂回しない。
- preflightは同snapshotの参考検査で、予約ではない。Replayは元receipt返却であり現在applied・Runningの証明ではない。Replay/errorではpause/apply候補を作らない。
- Candidate後のrequest_pauseは元runへ停止を要求し、join_pauseは同candidateを照合して正常cleanupとjoinを確認する。自然終了済みや既にJoinedでも明示pause/join段階を通す。
- execute_candidateは保存したintentだけを一回実行する。apply本文の差替え引数はない。同期受理に成功した時点で候補をconsumeし、commit結果は後のjoinで確認する。
- plan turnのjoinがOkでもoutcomeがErrならcommit成功ではない。現nativeはoutcome Errですべてplan recovery-requiredをlatchする。UI検査成功や再読込で解除しない。
- join未完了のworkerとwriter leaseは物理的に残る。外側のtimeoutや取消で所有を明け渡さない。成功commit後のlate cancelは成功receiptを覆さない。

mapping登録とapplyは元々別commitである。初期capabilityではmapping登録を提供せず、d3のcurrentMappingRevisionとapplied bound版の差を隠さない。将来登録機能を追加しても一括rollbackを約束せず、mapping成功とapply失敗を別のreceiptで示す。

## 3. d3と分離したoptional capability

既存RecordingManagementServiceはread-onlyのまま変更しない。Appへ別optional `RecordingOperationsService` を注入する。未提供なら「管理操作は未接続」とし、読取が使えることから操作資格を推論しない。通常Appは両方未接続を維持する。

```ts
type RecordingOperationsContext = {
  version: 1;
  kind: "recordingOperationsContext";
  target: RecordingManagementContext;
  capabilityId: Id;
  recordingRunRef: Id;
  sessionId: Id;
};
type PlanApplyRequest = {
  requestId: Id;
  desired: DesiredRecordingPlan;
  expectedAppliedRevision: U1 | null;
  expectedMappingRevision: U1 | null;
  expectedRetentionAppliedRevision: U1 | null;
};
type RecordingChangeRequest = {
  version: 1;
  kind: "recordingChangeRequest";
  changeId: Id;
  context: RecordingOperationsContext;
  apply: PlanApplyRequest;
};
```

Id/U1/U0は[管理読取契約](historian-recording-management.md)のsafe integer／canonical H1 IDと同じ。targetはd3 Contextをローカルresource参照して検証する。Project id/revisionを完全一致させるほか、AppのProject object/generation・open ownerを別に照合する。deployment/store/namespace宣言は認証ではない。targetが同じ綴りでも別serviceのcapabilityは交換できない。

OperationsContextは一つのnative RecordingRun/sessionへ束縛するimmutable宣言である。adapterは作成時にopaque native runを保持し、文字列からnative tokenを再構成しない。runRefはこのcapability内の表示／照合用IDであり、d3のrunRef文字列だけを操作許可にしない。対象runやProject宣言を更新するには新capabilityIdと新context/service snapshotを発行する。ただし前の実行ownerを破棄しない。

applyはnative ApplyRecordingPlanRequestへ一対一投影する。enabled=trueではmapping／retention期待版を両方必須、falseでは両方null。d3のcurrent mapping／保持版が非nullでもdisabled要求へコピーしない。expectedAppliedRevision=nullは台帳未適用の期待値であり、initialIdleの許可ではない。現在のmanual RecordingRunが正常pauseできる場合はnative gateに従って初回managed applyを行える。desiredの版とapplied／mapping／保持の版は別poolである。

期待版はd3の観測からフォームへ明示的に取り込んでよいが、古いinspectionは予約・操作許可ではない。native preflightとapply transactionがそれぞれ最新headを照合する。snapshotCommitを新しいCAS条件として勝手に追加しない。検査後の版変更はapply Conflictになり得る。desiredや期待版を編集したら旧候補をdiscardし、新changeとして明示検査し直す。requestId／changeIdを自動再発行してConflictを回避しない。

## 4. 外部ownerと操作API

以下は同realmのin-process contractで、HTTP endpointや既存native公開DTOではない。object tokenとPromiseはJSONにしない。

```ts
interface OperationControl {
  readonly deadlineMonotonicMs: number;
}
interface ChangeHandle {
  readonly opaqueChange: object;
}
interface OperationHandle {
  readonly opaqueOperation: object;
  readonly request: RecordingOperationRequest;
  readonly completion: Promise<RecordingOperationResult>;
  requestCancel(): CancelDisposition;
}
type CancelDisposition = "requested" | "alreadyCompleted" | "notSupported";
interface ReconciliationHandle {
  readonly request: RecordingReconciliationRequest;
  readonly completion: Promise<RecordingReconciliationResult>;
  requestCancel(): CancelDisposition;
}
interface RecordingOperationsService {
  readonly context: unknown;
  preflight(
    request: RecordingChangeRequest,
    control: OperationControl,
  ): { change: ChangeHandle; operation: OperationHandle };
  pauseJoin(
    change: ChangeHandle,
    operationId: Id,
    control: OperationControl,
  ): OperationHandle;
  apply(
    change: ChangeHandle,
    operationId: Id,
    control: OperationControl,
  ): OperationHandle;
  discard(change: ChangeHandle): void;
  reconcile(
    change: ChangeHandle,
    operation: OperationHandle,
    reconciliationId: Id,
    control: OperationControl,
  ): ReconciliationHandle;
  current(): RecordingOperationOwnerView;
  subscribe(listener: (state: RecordingOperationOwnerView) => void): () => void;
}
```

`RecordingOperationOwnerView`は非JSONのowned/frozen viewで、`change: ChangeHandle|null`、`request: RecordingChangeRequest|null`、`phase`（次節）、`active: OperationHandle|null`、`latest: RecordingOperationResult|null`、`reconciling: ReconciliationHandle|null`、`lastReconciliation: RecordingReconciliationResult|null`、`lastApplied: {request: RecordingOperationRequest; receipt: AppliedReceipt}|null`を必須とする。各最大1、過去全operation配列を返さない。lastAppliedは元request/context/run宣言とセットで保持し、後のworkflowへ結果を付け替えない。Replayから得たreceiptはlatestのreplayとして表示し、今回のapply成功履歴を作らない。preflightのoperationIdはownerが受理前に新規発行し、返却OperationHandle.requestに固定する。currentは既存owner状態の照会だけでnative mutation／自動再実行を行わない。subscribeは最新owned viewを即時通知し、以降も最新状態だけを通知する（結果履歴queueは作らない）。listener解除は操作取消ではない。通知前に状態を確定し、再入・listener例外・途中unsubscribeを隔離する。これにより元completion後のreconciliationやlate結果によるlatest更新もUIへ届く。新Appは同外部ownerへ再接続してこのviewを表示できる。process restart後にこのobjectが復活するとは約束しない。

serviceは同期受理前に要求をowned検証し、operationId・change全文・元runを保存してからnative dispatchする。operationIdはcontext内で再利用しない。要求不正・Busy・別handle等を同期拒否する場合はdispatch前のみであり、前のworker/設定を変更しない。受付後は必ず同handleへ結果を集約する。Appは受理後のhandleを先に保持してから通知購読し、即時完了でも取り逃がさない。

ChangeHandleはservice内部の一個のBoundRequest/PreflightRunへ対応する。pause/applyはこのhandle以外にdesired／期待版／元runの差替えを受けない。pause/applyでは別serviceのhandle、discard済み、consume済み、元run不一致を同期拒否する。§7のreconcileは、同ownerが保持する元applyのconsume済みhandleを対象としてよい。JS object tokenは権限システムでも署名tokenでもない。将来transportを追加する場合は別途認証・owner registryの設計が必要で、JSON文字列ticketへ置換しただけでは成立しない。

一ownerの受理済み物理operationは最大1、mutation queueは0。preflightも同枠を占有し、d3 inspectionとのnative reader枠競合はBusyで扱う。外部ownerは一つのsupervisorへの全capabilityを直列化し、別App・旧service・新serviceから枠を迂回できないようにする。UI側でも旧owner実行中は新ownerへの送信を止める。唯一の追加read枠として、§7の明示reconcileを最大1許す。元applyのquiescenceがunknownでもそのreadは可能だが、新mutationは引き続き禁止する。reconcileもqueueは0、既存native reader二枠とBusyを迂回しない。

## 5. 状態遷移と三つの明示操作

owner phaseは`idle / preflighting / candidate / pausing / paused / applying / completed / blocked / uncertain`の閉集合とする。phaseだけでcommitを推測せず結果を併記する。

| 呼出／結果          | native対応                                 | 次状態・意味                                                                                                             |
| ------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| preflight受理       | start_preflight→join_preflight             | preflighting。録画は継続                                                                                                 |
| Candidate           | 同run/active session照合済みの候補         | candidate。pauseボタンのみ提供                                                                                           |
| Replay              | 保存receipt                                | completed。旧runを止めず候補なし                                                                                         |
| 検査error           | 有限safe error                             | completedまたはreader異常blocked。候補なし、停止なし                                                                     |
| pauseJoin明示       | request_pause→join_pause                   | pausing。stop要求済み、撤回不可                                                                                          |
| 正常join完了        | cleanup正常・元run一致                     | paused。同候補のapplyだけ可能                                                                                            |
| pause error         | 異常cleanup・join失敗等                    | blocked/uncertain。apply不可                                                                                             |
| apply明示の同期受理 | execute_candidate→join_recording_plan_turn | applying。候補consume、別本文禁止                                                                                        |
| receipt確認         | outcome Applied                            | commit確認。quiescence unknownならuncertain、confirmedでもrecoveryRequiredならblocked、それ以外はcompleted。resumeしない |
| apply error/不明    | native recovery latch維持                  | blocked/uncertain。自動再試行なし                                                                                        |

自然完了した旧runもcandidate→明示pauseJoinを省略しない。pause成功後の自動applyを実装しない。pauseに失敗したとき、nativeが物理的にjoinしたかと正常pause資格があるかは別に扱う。

discardはcandidateまたは正常pausedで、実行がなくnativeが許すときだけ可能。discardは旧runを再開せず、保存済み設定も戻さない。pausing/applying中はBusy、consume後は拒否。旧候補をdiscardした後に新desiredを検査しても録画は自動再開しない。

## 6. 純粋JSON envelopeと安全な結果

```ts
type RecordingOperationRequest = {
  version: 1;
  kind: "recordingOperationRequest";
  operationId: Id;
  stage: "preflight" | "pauseJoin" | "apply";
  change: RecordingChangeRequest;
};
type AppliedReceipt = {
  requestId: Id;
  appliedRevision: U1;
  commitVersion: U1;
  desiredPlanId: Id;
  desiredRevision: U1;
  desiredHash: Hex64;
  resolvedConfigHash: Hex64;
  plan: { planId: Id; revision: U1 };
  mappingRevision: U1 | null;
  retentionAppliedRevision: U1 | null;
  enabled: boolean;
};
type OperationError =
  | "invalidRequest"
  | "busy"
  | "wrongOwner"
  | "staleRun"
  | "conflict"
  | "noCandidate"
  | "pauseRequired"
  | "consumed"
  | "uncleanPause"
  | "retentionBlocked"
  | "planRecoveryRequired"
  | "cancelled"
  | "deadlineExceeded"
  | "budgetExceeded"
  | "corruptData"
  | "needsReopen"
  | "readerUnusable"
  | "sourceFailure"
  | "workerFailure"
  | "projectionFailed"
  | "internal";
type OperationOutcome =
  | { kind: "candidate"; snapshotCommit: U0; activeSessionId: Id | null }
  | { kind: "replay"; snapshotCommit: U0; receipt: AppliedReceipt }
  | { kind: "paused"; sessionId: Id }
  | { kind: "applied"; receipt: AppliedReceipt }
  | {
      kind: "failed";
      error: OperationError;
      effect: "notDispatched" | "notCommitted" | "unconfirmed";
    };
type RecordingOperationResult = {
  version: 1;
  kind: "recordingOperationResult";
  request: RecordingOperationRequest;
  outcome: OperationOutcome;
  quiescence: "confirmed" | "unknown";
  recoveryRequired: boolean;
};
```

Hex64は小文字16進64桁。hashはnative canonical結果を表示するもので、browserが計算して認可を与えない。plan.planIdは台帳のPlanRefでdesiredPlanIdとは別役割、plan.revisionはappliedRevisionに一致する。receipt.requestId/desiredPlanId/desiredRevision/enabled/両bound revisionはchange.applyと一致。appliedRevisionはexpectedAppliedRevision=nullなら1、それ以外は期待版+1（MAX_SAFEなら新apply候補を作れない）。Replayも元requestを検証してこの関係を保ち、現在headとの一致は要求しない。Replayのreceipt.commitVersionはsnapshotCommit以下。

stageと結果を照合し、preflightだけcandidate/replay、pauseJoinだけpaused、applyだけappliedを許す。failedは全stageで許す。candidate.activeSessionId非nullとpaused.sessionIdはcontext.sessionIdと一致する。candidate/replay/pausedはquiescence=confirmed、recoveryRequired=falseを必須とする。appliedはcommit確認だけを表し、quiescence=unknownまたはrecoveryRequired=trueとの併存を許す。appliedかつunknownならrecoveryRequired=trueを必須とし、ownerはuncertainで新mutationを禁止する。applied/confirmedでもrecoveryRequired=trueならblockedを保持する。元の正常apply完了はconfirmed/falseだが、reconciliationで確認したreceiptにこの正常完了条件を押し付けない。これは当該operationの結果であり、後から生じた別障害を否定しない。failedかつquiescence=unknownならeffect=unconfirmed/recoveryRequired=true。applyがdispatch後失敗した結果（notCommitted/unconfirmed）はnativeに合わせrecoveryRequired=true。同期拒否はnotDispatched/confirmedで、既存latchを隠さないためrecoveryRequiredは現ownerの値を保持する。

`notCommitted`はadapterが当該transactionの非commit／rollback完了を証拠で確認できる場合だけ使う。Err文字列やreceipt未発見から推測しない。pauseのfailedでは設定transactionがないためnotCommittedは使わず、stop要求前のnotDispatchedか、要求後のunconfirmedとする。stop要求済みは取り消されず、notCommittedを「録画が止まっていない」と読める表現にしない。

同期拒否のJS例外は閉じたOperationErrorとowner stateだけを持つ専用型とし、未知例外の本文を表示しない。dispatchの有無を証明できない例外はunconfirmedとしてownerをblockする。StoreError/SDKerrorの自由文字列・SQL・path・endpointをJSONへコピーしない。typed分類できない場合はinternalまたはprojectionFailed。

## 7. 期限・取消・結果不明

各stageに独立した明示deadlineを一回作る。UI既定10秒、1..10000msのsafe整数から同realmのperformance.now絶対期限へ変換する。新しい利用者操作で次stageの期限を作ることはよいが、同stageのqueue／native変換／再待機で延長しない。1操作のnative予算は既存のまま、不要な増枠はしない。

preflightとapplyはnativeのcooperative cancellationへ結ぶ。pauseJoinは停止撤回ができず、初回のrequestCancelはnotSupportedを返す。joinを捨てず外部ownerが完了を観測する。pause待機時間はUIの待機通知上限であり、既存nativeにないhard join timeoutを発明しない。

App側deadline超過は「期限超過・結果待ち」というmonitor状態で、completionの失敗確定ではない。close、Project交換、service交換、disposeはOperationHandle.requestCancelを呼ばない。利用者の明示取消だけを同handleへ送る。cancel受付表示は未実行／rollbackの証明ではない。

completionは原則として物理cleanup/joinの確認後にsettleする。接続喪失などでその確認自体ができない場合はunconfirmed/unknownを返せるが、ownerはuncertainに留まり枠を解放しない。UIもPromise settledだけで次操作を許さない。native成功receiptを確認した後のUI timeout/latecancelはapplied成功を維持し、「期限後に結果確認」と表示できる。

現在のsupervisorはplan recovery latch時に新preflightを拒否する。結果不明の解消を同supervisor preflightで必ず行えるとは扱わない。[native receipt読取](../../../crates/scada-historian/src/store/recording_plan/mod.rs)は存在するが、d4cでは外部ownerが保持するrequestと物理quiescenceを使うread-only reconciliation経路を明示実装する必要がある。receipt未発見だけで非commitや再dispatch許可を出さない。異常時のtake_store／再open／receipt確認は独立した手動回復境界で、UIから自動実行しない。

### 明示reconcileの照会と更新

```ts
type RecordingReconciliationRequest = {
  version: 1;
  kind: "recordingReconciliationRequest";
  reconciliationId: Id;
  operation: RecordingOperationRequest;
};
type RecordingReconciliationResult = {
  version: 1;
  kind: "recordingReconciliationResult";
  request: RecordingReconciliationRequest;
  outcome:
    | { kind: "receiptFound"; receipt: AppliedReceipt }
    | { kind: "notFound" }
    | { kind: "failed"; error: OperationError };
  quiescence: "confirmed" | "unknown";
  recoveryRequired: boolean;
};
```

operation.stageはapplyだけを許す。元operation request全体をechoし、receiptFoundは§6の元applyと同じreceipt整合規則を満たす。quiescenceは**元apply**の物理完了根拠であり、この照会read自身の完了とは別である。unknownならrecoveryRequired=true。notFound/failedでもnative latchを解除しない。pure validatorは単一結果のshapeを検査し、既知receiptの不一致・既知quiescenceの巻戻し・既存latch消失は外部ownerの状態付き照合で拒否する。

reconcileは同外部ownerが保持するchangeと元OperationHandleを取り、元applyのcompletionがfailed/unconfirmedにsettleした場合、またはcommit確認済みでもquiescence/recoveryのblockが残る場合に限って受理する。pause/joinの異常をreceipt照会で正常pauseへ変換しない。元completionが未settleでownerが通常監視中ならBusyとして二重監視を開始しない。元applyがunknownへsettleしてもwriter gateは保持されているため、reconcileはそのgate内で許されるread-onlyの例外である。明示の「元要求の結果を照会」buttonからだけ発行し、自動pollしない。

serviceは照会IDを受理前に登録し、同ID再受理・別owner handle・元request不一致をdispatch前に拒否する。照会実行中はreconcilingに一個だけ保持し、追加照会はBusy。元applyの再実行、execute_candidate、別requestIdの生成は行わない。currentはこの照会を自動開始しない。

照会結果の検証後、lastReconciliationへ保存し、receiptFoundならcurrent.latestを**元operationId/requestのまま**appliedへ更新する。元OperationHandle.completionのPromiseは既にsettleした履歴として不変で、再resolveしない。lastAppliedも元request付きで保持する。元receiptが確認できても現在applied／Runningの証明とはしない。recoveryRequiredは元stateとのORで維持し、read結果だけでclearしない。既に確認済みreceiptを後のnotFound/failedで消したり、quiescence confirmedをunknownへ戻したりしない。矛盾した照会はprojectionFailedとしてblockを維持する。

notFoundはlatestの元unconfirmed/failedを保持し、非commit確定・新apply・自動再試行の資格を与えない。元workerのlate receiptとreconcileの結果が競合するときは同requestの同receiptだけを統合し、receipt確認と物理quiescence確認を別々に単調更新する。unknownはuncertain、confirmedでもlatchありはblockedのままである。native latch解除と再開は別回復capabilityへ残す。

照会のdeadlineは新しい利用者の明示readごとに一回作り、取消は当該readへのcooperative requestだけで、元applyの取消にはならない。UI timeout/close/service交換で照会handleを捨てず、read cleanup後のlate結果も元ownerのlastReconciliation/latestへ保存する。新Projectの送信資格には転用しない。照会Promiseはread自身がquiescentとなってからsettleし、read完了を確認できなければreconciling枠も保持する。d4bはこの更新をmockで受け入れ、d4cで実receipt readと物理完了根拠の取得を実装する。

## 8. UIと外部ownerの寿命

Appは送信資格と操作monitorを分ける。送信資格は現在Project object/generation、service identity、操作context、open owner、希望設定全文・順・版へのexact bindingである。preflight受理時のchange全文は以降固定し、Project編集やUndo後に新しいdesiredを古いhandleへ流し込まない。

操作monitorは最後の一workflowとそのactive operation／latest result／last applied receiptを保持し、Modal close後も外部ownerから結果を受ける。旧Project/serviceの結果は旧対象のラベル付きで表示し、新Projectの現在applied比較へ転用しない。Project交換後は旧candidateのpause/applyを新owner画面から送らない。元対象へ明示的に戻り正しいownerを再取得するか、安全なdiscard／回復手順へ進む。

実行中・uncertainの旧ownerを保持したまま新ownerへmutationを発行しない。完了済み旧結果は最大1として表示し、次の明示workflow受理時に置き換えてよい。未消費候補も外部owner側一個であり、closeだけで増やさず、別候補へ移る前に明示discardする。unmount時の外部owner存続はservice実装の責務であり、DOMのPromise保持だけでnative継続を保証しない。

新App／同realm再mountでは同service ownerのcurrentから再表示できる。process終了・再読込で外部owner自体を失った場合の回復はDB requestId/receiptとnative stateに基づく別境界であり、localStorageのJSONからopaque ticketを復活させない。serviceがowner存続を提供できなければmutable capabilityを公開しない。

UIは「検査」「この元runを停止してjoin」「同候補を適用」を独立buttonにする。Replay/errorでは停止buttonを出さない。pausedまで適用buttonを有効にしない。apply成功は「設定commit済み・再開は別操作」、結果不明は「元requestの結果確認が必要」、同期拒否は「未受付」と区別する。inspectのreadyやdisabled一致を操作成功に変換しない。

## 9. 予算・検証・受入

d4aのschemaは`crates/scada-model/schema/recording-operations.schema.json`。Context/Change/OperationRequest/ReconciliationRequestは各128KiB・4096node、OperationResult/ReconciliationResultは各256KiB・8192node、depth32、nested desiredはH5aの64KiB/4096nodeを独立適用する。これは新JS/JSON境界の予算であり、現native ApplyRecordingPlanRequestの128KiB/node8192と同一の制限とは扱わない。adapterは両境界を順に満たす必要がある。d3 ContextとH5a/H1 schemaをローカルresource登録し、network fetchしない。全objectは記載fieldをすべて必須とし、nullable fieldの省略とunionの別branchのfieldを拒否する。scalar／blank／safe整数／非JSON／未知field拒否、owned/frozen、compact integer byte計数はd3aと共通化する。opaque handleやPromiseはこのJSON validatorの対象外である。

d4aにReconciliationRequest/Resultも含め、元apply全文echo、receiptFound＋unknown/true、receiptFound＋confirmed/true、notFoundが再送許可でないこと、異なるrequest/receipt、二重照会ID、late結果統合をfixture／後続state testで分担する。共有fixtureでは全stage/result組合せ、null期待版、disabled、MAX_SAFE増版境界、receipt各field取り違え、台帳PlanRefとdesired版の混同、別run/session/context、Replay旧receipt、quiescence/recovery/effectの不整合、秘密field、Unicode・予算を検証する。JS/nativeのrequest全文比較ではobject key順と1/1.0等の数値表記差を無視するが、member表示順は保持して一致を要求する。serviceは保存した元owned requestをechoし、native canonical出力から表示順を再構築しない。native canonical同値を根拠にUIの固定候補を別本文へ差し替えない。

d4bの通常App受入は制御可能なtest serviceで行う。Candidate後も録画継続を示す独立mock状態、Replay/errorでpause未呼出し、別操作の明示clickが必要なこと、旧handle・別service拒否、no queue、同期待版本文の固定、pause待機timeout、取消後late success、apply結果不明→明示reconcile→receipt確認でもlatch保持、notFound後も新apply拒否、照会timeout後late結果と元completion不変、旧Project/service monitor、close/reopen/unmount中のowner保持、両themeとProject保存不変を確認する。異常Promiseを早期settleする不正adapterを物理安全にできるとは主張しない。

d4cでは隔離SQLite＋mockHubで実supervisorへ接続する。Running中preflight→pause正常join→apply commit、既存receipt Replayで記録継続、検査後CAS競合、source shutdown不良、FULL/rollback/commit後応答喪失、join取消・Dropとwriter lock、異常時recovery latch、旧receiptと現在headの相違を受け入れる。reconciliation専用readのrow/bytes/VM/deadline・reader二枠を測定し、未知にした項目を推測で正常へ変換しない。実環境・SDK更新・認証・transportの保留を維持する。

## 10. H5d4aの実装入口

`recording-operations-contract.ts`がTSの公開入口で、`parseRecordingOperationsDocument`／`validateRecordingOperations`と、Context／ChangeRequest／OperationRequest／OperationResult／ReconciliationRequest／ReconciliationResultの各`parseRecording…`を提供する。unknownから所有・deep freezeし、不正入力は有限の`Recording operations: invalid`へまとめる。種類ごとのroot予算と、nested request／change／context／H5a desiredの独立予算を適用し、targetはd3のContextだけを受け入れる。

`recording-operations/types.ts`がreadonly DTO、`semantic.ts`がschema後の版・receipt・stage・quiescence／recovery／effect整合を所有する。`sameRecordingOperationsContext`／`sameRecordingChangeRequest`／`sameRecordingOperationRequest`／`sameRecordingReconciliationRequest`は両入力を再検証し、object key順と整数表記差だけを無視して、member表示順を含む全文を比較する。H5aの意味比較とは使い分ける。

Rustの公開入口は`scada_model::recording_operations`。`validate_recording_operations(&Value)`と6種類のprivate Value wrapperの`from_value`／`as_value`を提供する。`semantic.rs`で意味検査、`equality.rs`の`same_recording_*`で検証済みwrapper同士の全文一致を行う。targetへ既存d3検証、desiredへH5a検証を再適用し、resourceはローカル登録する。

`examples/recording-operations-cases.json`の受理925件と全文一致102件を共有する。H5a139件を5種類のenvelopeへ包む695件、d3の全447件をtargetへ包むContext以外拒否の検査、byte／node／depthと非JSON・所有権／freezeも両言語／browserで確認する。重複照会ID、既知receipt保持、latchのOR、物理owner gateなどの状態付き規則はd4b/cの責務であり、このpure validatorが実行済みの証拠を与えるとは扱わない。
