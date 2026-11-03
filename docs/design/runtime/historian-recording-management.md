# 記録管理状態の表示契約

状態: **H5d3aの共通契約を実装、H5d3bは未実装**。2026-11-03（日本時間）。主設計はユーザー指定のAstra。Context／Request／Responseのschema、Rust／TypeScript validator、owned DTO、比較関数を提供する。service・controller・管理UI・native projectionは後続。

## 1. 対象と工程

[Project連携設計](historian-recording-project.md)のH5d3を次の二つに分ける。

| 工程  | 完了する境界                                                                                                                        | 含めないもの                                    |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| H5d3a | 版付きContext／InspectionRequest／InspectionResponse、TS/Rustの純粋validator、owned DTO、比較関数、共通fixtureとbrowser内module評価 | App表示、nativeサービスadapter、通信            |
| H5d3b | optional service、App常設controller、明示照会による管理状態表示、通常Appへのテスト注入                                              | 自動更新、適用・停止・再開、認証・製品transport |

Project 0.37.0、DB7、H1、SDK固定rev、Bantoと依存版を変更しない。管理DTOはProjectへ保存しない。通常Appのserviceはundefinedであり、架空のdeploymentやapplied状態を作らない。H5d4の操作capabilityは別設計・別入口であり、inspection成功は操作許可・予約・rearmではない。

## 2. 現行根拠とprojection責務

- [native resume view](../../../crates/scada-historian/src/store/recording_plan/resume.rs)は同一SQLite snapshotでplan、最新activation、保持復旧を読む。新複合APIのdecoded row上限は768、従来の個別APIは256のまま。既存VM・入力byte・deadlineの有限予算を引き継ぐ。
- [Host status](../../../crates/scada-runtime/src/recording_host/types.rs)はプロセス内watchであり、DB snapshotとは別時点。RecordingRunは非Serializeのopaque ownerである。Startingは受付後、RunningはRecorderのphaseで、SDK LiveやGoodの証明ではない。
- [supervisor設計](historian-recording-supervisor.md)の診断は異常・初期Idleでも可能だが、plan recovery／retention rearmを解除しない。
- [History controller](../../../apps/banto-scada/src/lib/history/presentation.ts)の物理一枠と論理ownerの分離を管理読取にも採用する。writer操作とinspectionの寿命は独立させる。

新DTOはnative Serializeをそのまま公開する形式ではない。adapterはnativeの整合性検査済みviewから必要情報だけを投影し、整数範囲とDTO意味検査を再確認する。SQL、path、endpoint、資格情報、任意error文字列、完全なSDK generation、raw値は出さない。native u64がMAX_SAFEを超える場合は丸め・文字列化・飽和させず`projectionFailed`とする。以下のJSONにないnative情報は初期d3の表示対象外であり、欠落から正常を推論しない。

## 3. 共通JSON規則

以下の型記法で`Id`はcanonical H1 `$defs/id`、`U0`は0..9,007,199,254,740,991の整数、`U1`は1..同上限、`UtcMs`は負も許す±同上限の整数を表す。`T | null`は必須fieldの明示nullであり、省略とは違う。全objectは未知fieldを拒否する。unionは表示したbranch以外のfieldを許さない。

| 対象                           | compact JSON byte上限 | node上限 | depth上限 |
| ------------------------------ | --------------------- | -------- | --------- |
| Context                        | 128 KiB               | 4096     | 32        |
| Request                        | 128 KiB               | 4096     | 32        |
| Response                       | 1 MiB                 | 16384    | 32        |
| ネストしたDesiredRecordingPlan | 既存64 KiB            | 既存4096 | 既存32    |

structured JSONのowned copy前／途中で有限walkし、getter/accessor、prototype付き独自object、関数、undefined、symbol、BigInt、循環、非有限数、unsafe整数、lone surrogateを拒否する。配列のhole／余分なpropertyも拒否する。Proxyの任意コード実行を防ぐsandboxとは称さない。TSはfreeze済みowned結果を返す。Rustはserde_json::Valueを検査してowned wrapperへ格納する。入力値の1.0や指数表記による予算差はH5a同様、safe整数のcompact十進表現として計数する。wire原文長の計測ではない。nodeは値一つにつき1（object/array自身も1）、root depthを0とする。文字列はUnicode scalarで数え、trimや改行変換をしない。

schemaはH1 IDとH5a desired schemaをローカルresourceとして登録する。ネットワーク取得は禁止。desiredには既存H5aのsemantic validatorも実行する。IDはそれぞれの役割のpoolであり、異なる役割間の同じ綴りを同一identityとは扱わない。

## 4. ContextとRequest

```ts
type RecordingManagementContext = {
  version: 1;
  kind: "recordingManagementContext";
  contextId: Id;
  projectId: string;
  projectRevision: U1;
  deploymentId: Id;
  storeId: Id;
  historianNamespace: Id | null;
};
type InspectionRequest = {
  version: 1;
  kind: "recordingInspectionRequest";
  requestId: Id;
  context: RecordingManagementContext;
};
```

projectIdは1..256 Unicode scalar、H5aと同じ明示blank集合（Unicode White_Space＋FEFF）だけの値は拒否する。Project manifestのIDと無変換で完全一致させる。他のIDをprojectIdへ流用しない。projectRevisionもmanifestと一致させる。大きすぎる既存Project ID等はProject自体を壊さず「この管理contextは利用不可」とする。

deployment/store/namespaceはadapterまたはcallerによる接続対象宣言であり、認証済identityではない。namespaceが未提供ならnullとし、storeId・scope・contextIdから生成しない。HistoryContext v2と結び付ける場合も別途完全一致が必要で、管理照会成功によってHistorySourceを設定しない。contextにはseries mappingやdesiredを含めない。desiredは現在Project、appliedはResponseを比較する。

serviceとcontextはimmutable snapshotである。対象や実接続先を変えるときは新contextIdと新service objectへ交換する。同じobject内のcontext/inspectの差替えは契約外とし、controllerは検査済みcontextとinspect関数を捕捉する。既存ID/revisionが同じ別Projectの読込でもProject object/generationは新ownerである。

## 5. Response: DBの同snapshot部分

```ts
type InspectionError =
  | "unavailable"
  | "busy"
  | "cancelled"
  | "deadlineExceeded"
  | "budgetExceeded"
  | "corruptData"
  | "needsReopen"
  | "readerUnusable"
  | "projectionFailed"
  | "internal";

type AppliedPlanView = {
  appliedRevision: U1;
  commitVersion: U1;
  desired: DesiredRecordingPlan;
  mappingRevision: U1 | null;
  retentionAppliedRevision: U1 | null;
};
type ActivationView = {
  activationId: Id;
  appliedRevision: U1;
  commitVersion: U1;
  sessionId: Id;
  state: "active" | "closed" | "interrupted";
  committedThrough: U0;
  endCommitVersion: U1 | null;
};
type DatabaseView =
  | { state: "unavailable"; error: InspectionError }
  | {
      state: "available";
      snapshotCommit: U0;
      currentMappingRevision: U1 | null;
      currentRetentionAppliedRevision: U1 | null;
      applied: AppliedPlanView | null;
      latestActivation: ActivationView | null;
      activeSessionId: Id | null;
      activeRetentionJobId: Id | null;
      retentionFence: { cutoffMs: UtcMs | null; commitVersion: U0 };
    };
```

意味検査は次を要求する。

1. commitVersion、endCommitVersion、fence commitはsnapshotCommit以下。activation endは開始commitより大きい。activeならend=null、closed/interruptedならend非null。
2. applied.desired.enabled=trueなら両参照revision必須、falseなら両方null。現在mapping／保持policyはdisabledでも存在してよい。非null bound revisionは対応current revision以下で、対応currentも非null。currentとboundの差は変更後の再適用が必要な状態であり、不正データではない。
3. latestActivationがあればappliedは非null、activation.appliedRevision<=current appliedRevision。同版ならapplied.desired.enabled=trueかつactivation commit>applied commit。旧版ならstateはclosed/interruptedで、activation commit<endCommitVersion<現applied commitを要求する。旧版terminal activationと現在disabled／別計画の組合せは合法。
4. latestActivationがactiveならcurrent appliedと同じappliedRevision、applied.desired.enabled=trueを必須とし、sessionIdはactiveSessionIdと一致。managed appliedが存在しactiveSessionIdもある場合、そのsessionはactiveなlatestActivationと一致する。applied無し・latestActivation無しのmanual active sessionは合法。
5. activeSessionIdとactiveRetentionJobIdの同時存在は拒否する。fenceはcutoff=nullならcommit=0、cutoff非nullならcommit>=1。snapshotCommit=0ではcurrentMappingRevision、currentRetentionAppliedRevision、applied、latestActivation、activeSessionId、activeRetentionJobIdをすべてnull、retentionFenceを{cutoffMs:null,commitVersion:0}とする。逆は要求せず、過去のmanual session終了等でsnapshotCommit>0でもこれらの公開fieldが初期形となる場合を許す。

古いactivationのdescriptorやreceipt全文はここでは公開しない。`appliedRevision`は記録台帳の版で、desired.revisionや保持policyの版と比較しない。latestActivationの時刻・sessionの状態はnativeで検査済みのものを投影する。DB viewの一部だけ取れなかった場合は全DatabaseViewをunavailableにし、別readの部分を同snapshotへ継ぎ足さない。availableは現在Runningや外部SDK接続を証明しない。

## 6. Response: 別時点のHostとSDK

```ts
type HostPhase =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "finishedUnjoined"
  | "joined"
  | "faulted"
  | "noStore"
  | "retaining"
  | "managingPlan";
type HostIssue =
  | "none"
  | "clock"
  | "source"
  | "store"
  | "invalidObservation"
  | "arithmeticOverflow"
  | "unclassified";
type HostView =
  | { state: "unknown" }
  | {
      state: "observed";
      observedAtMs: UtcMs | null;
      runRef: Id | null;
      sessionId: Id | null;
      phase: HostPhase;
      stopRequested: boolean;
      issue: HostIssue;
      cleanup: "unknown" | "closed" | "interrupted" | "failed";
      sourceShutdown: "unknown" | "succeeded" | "failed";
      planRecoveryRequired: boolean | null;
      retentionRearmRequired: boolean | null;
      retentionJobPending: boolean | null;
    };
type SdkView =
  | { state: "unknown" }
  | {
      state: "observed";
      observedAtMs: UtcMs | null;
      connection: "connecting" | "live" | "backoff" | "stopped" | "failed";
    };
type InspectionResponse = {
  version: 1;
  kind: "recordingInspectionResponse";
  request: InspectionRequest;
  database: DatabaseView;
  host: HostView;
  sdk: SdkView;
};
```

runRefはadapterがopaque RecordingRunに割り当てるcontext内の表示用IDである。同runに同ID、別runに別IDとし、ポインタ・session名からの推測で生成しない。対応表は最新RecordingRunとrunRefの一組だけ保持すればよい。新runへの遷移時に旧組を破棄し、同context内で表示用IDを再利用しない。過去runの全履歴を蓄積せず、採番上限に達したら新contextへ交換する。元runを提供できなければnull。操作tokenやrestart後の再接続資格ではない。phaseとsession/runの組合せをUIが補完しない。observedAtMsはadapterが実際に採った観測時刻、未提供ならnull。DB snapshotの原子的な観測時刻や時計信頼を意味しない。DBとHostのsession不一致も別時点観測として表示でき、cross-field拒否にはしない。

Host issueはtyped原因が取得できる場合だけ分類する。status.start_errorのStringやStoreErrorのDisplayをparseしない。開始errorしか取得できなければunclassified。未観測Hostをidle、未提供guardをfalseへ変換しない。issue=noneは報告された障害なしであり、運転正常保証ではない。複数原因があればtyped recorder cause、開始error、cleanup失敗、shutdown失敗の順で単一issueを選び、cleanup/shutdown自身のfieldも保持する。

現在のSdkRecorderSourceには管理表示用の接続watchがない。したがって既存公開情報だけから作るadapterのsdkはunknownとなる。future adapterが実際の独立観測を持つ場合だけobservedを返す。Host Running、activation commit、最新tick、source_shutdownからliveを導出しない。liveも値品質Goodの保証ではない。

初期DTOはguardの最新成功mapping/apply receiptを含めない。現在appliedと過去成功の取り違えを避け、d4で必要になる操作結果は別契約にする。tick countersやraw valueも初期表示には不要と判断する。

## 7. 希望設定と適用済み設定の比較

共通純粋関数は次の閉集合を返す。比較対象はownedな現在Project desiredとavailable DBのapplied.desiredだけである。

| 結果                 | 判定                                     |
| -------------------- | ---------------------------------------- |
| unavailable          | DB view unavailable                      |
| absent               | Project desiredなし、DB appliedなし      |
| localAbsent          | Project desiredなし、DB appliedあり      |
| notApplied           | Project desiredあり、DB appliedなし      |
| differentPlan        | 両方ありplanId不一致                     |
| sameRevisionConflict | 同planId/revisionでcanonical本文が異なる |
| matches              | 同planId/revisionでcanonical本文が一致   |
| localNewer           | 同planIdでlocal revisionが大きい         |
| localOlder           | 同planIdでlocal revisionが小さい         |

共通比較結果の具体型は次とし、discriminantは`kind`、未知fieldは認めない。

```ts
type DesiredAppliedComparison =
  | {
      kind:
        | "unavailable"
        | "absent"
        | "localAbsent"
        | "notApplied"
        | "differentPlan"
        | "sameRevisionConflict"
        | "matches";
    }
  | { kind: "localNewer" | "localOlder"; sameContent: boolean };
```

localNewer/localOlderには`sameContent:boolean`を別途返す。他の結果へこのfieldを付けない。本文比較はrevisionを除き、version/kind/planId/enabled/groupId/hubRef/periodMsとmember全fieldを含み、memberIdのcode unit順へ並べて比較する。文字列のtrim/Unicode正規化をしない。membersの順だけ違うものはmatchesで、保存された表示順を変更しない。hashを新たに権威化しない。

希望設定の省略は停止命令ではない。disabledでmatchesは「無効設定が適用済み」であって、旧HostのjoinやSDKshutdown完了を証明しない。同ID版本文不一致は競合として表示するだけで、版の自動加算・自動apply・自動再照会はしない。

## 8. in-process serviceとcontroller

```ts
interface InspectionControl {
  readonly signal: AbortSignal;
  readonly deadlineMonotonicMs: number;
}
interface RecordingManagementService {
  readonly context: unknown;
  inspect(
    request: InspectionRequest,
    control: InspectionControl,
  ): Promise<unknown>;
}
```

これは同JS realmの注入境界で、native IPC/HTTPが既に存在するという意味ではない。将来adapterはnative ownerを保持し、そのread-only inspectionを呼び、DTOへprojectionする。deadlineMonotonicMsはperformance.now()と同じ時計領域の有限非負numberで、JSON DTOへは入れない。別processへそのまま転送しない。

controllerの`load(timeoutMs)`は1..10000のsafe整数を明示的に受け、load時に単調時計で絶対deadlineを一回だけ作る。UI既定は10000ms。pending待機を含み、dispatch時に残時間からnative QueryControl deadlineへ一度だけ変換する。元の期限・tokenをqueue待機後に作り直さない。残余時間のceilや新しいtimeoutの開始で期限を延長せず、native時計への変換誤差は早めの期限側に倒す。VM/rows等native予算の増枠をこのUI引数から許可しない。

物理activeは1、未発行pendingは最新1。loadは新しいopaque論理tokenとrequestIdを作り、古い結果を即時隠してactiveへabort要求し、pendingを置き換える。queueMicrotask等でpumpをまとめ、subscriberの同期再入でもactive2を作らない。期限切れpendingはsourceを呼ばずtimeoutになる。activeのtimeoutは論理timeoutとabort要求だけであり、source Promiseがsettleするまで物理枠を解放しない。timer callbackが遅れても結果採用前に同じ単調deadlineを再確認し、期限後の成功で表示を復活させない。sourceは内部read／cleanupがquiescentになってからresolve/rejectする。Abort無視の処理へ次を重ねない。

同期throwはsourceが処理をdispatchしていない拒否に限定する。dispatch後の処理は取消・失敗でもquiescentまでPromiseを保持する。同期throw/rejectionの任意error本文を表示せずclient側serviceFailureへ分類する。非Promiseを返すserviceも契約違反としてserviceFailureとし、正しいadapterはdispatch後にその状態を作らない。物理処理が残るのにresolve/rejectするadapterをbrowser側だけで検知・制御できるとは保証しない。

返却時はowned JSON境界→schema→semantic→request全文一致を順に検査する。requestIdだけでなく全context/対象宣言が一致しなければinvalidResponse。さらに捕捉したservice identity、Project object/generation、open owner、論理tokenが現ownerと完全一致する場合だけ公開する。無効／旧応答を成功や「未適用」へ落とさない。

controllerの表示状態は`offline / invalidContext / contextMismatch / idle / loading / ready / cancelled / timeout / serviceFailure / invalidResponse`。loadingにはwaiting（まだpending）を持つ。readyは正しいResponseを受領した意味だけで、database unavailableならUIも照会失敗／部分観測と示し、管理正常としない。schema不正と意味不正はともにinvalidResponseで有限理由を表示し、payload/error本文は表示しない。

`cancel()`はloadingだけをretireしてcancelledへ移す。完了後のcancelはno-op。新load、service交換、Project交換、closeでは以前のreadyを隠す。listener解除後にそのlistenerを同一通知ループから呼ばない。stateを通知する前に内部token/active/pendingを確定し、abort listenerやsubscriberの再入で古いtokenを復活させない。

## 9. Appの寿命と表示

管理workspace/controllerはApp常設で、Modal子のmountごとに作らない。openごとに新ownerを作る。service/Project/generation/openが変わったらrender時の即時資格検査で旧表示・送信を遮断し、その後effectでretireする。close/reopen、同ID版のProject置換、同source関数の新serviceでも旧readの物理枠を保持してから新ownerのpendingを発行する。context変更をin-place mutationで伝えない。

初期d3bは「記録管理状態」の明示入口と照会ボタンを提供する。openだけではinspectしない。未接続、希望設定なし、未照会、待機中、期限切れ、不正応答を区別する。DB適用設定、最新activation/session、別観測Host、保持／回復gate、SDK未提供を別の表示群にし、「起動受付」「記録worker稼働」「DB active」「SDK接続」を一つの緑の正常表示へ合成しない。

閉じる・Project交換・service交換はinspectionの論理取消だけで、writerのstop/shutdownやretention停止を呼ばない。App disposeもreaderへのabort要求までである。adapterはquiescentまでread leaseを保持し、Appを離れても記録ownerは外部で存続する。新App/controllerを同じ物理adapterへ接続する場合の全体上限はadapter自身の一枠／Busy gateで守る（controllerの一枠だけで別App間を制限したと主張しない）。

desired編集・Undo/Redo後はProject/generation境界で古い比較を隠す。inspection結果をProjectへ採用、保存、Undo履歴へ追加しない。診断によってplanRecoveryRequiredやretentionRearmRequiredを解除しない。d4のボタン・操作関数をd3 serviceへ先行追加しない。

## 10. 後続PRの受入

H5d3aはschema、TS owned parser、Rust純粋validatorを同じfixtureで検証する。schemaは`crates/scada-model/schema/recording-management.schema.json`、公開pure moduleは`recording_management`、TSは`recording-management-contract.ts`とする。native runtime/historianへmodelの依存を追加する必要はなく、adapterは後続。Project validatorにこのschemaを組み込まない。

- 全union、必須null、省略／未知field、H1 ID、scalar/blank、safe整数・byte/node/depth境界、getter/非JSON拒否、owned/freezeを検証する。
- full desiredのH5a fixtureをネストして受理一致を確認し、disabled bound=null/current mappingあり、manual active、旧activation/新applied、snapshot境界、active job排他、terminal endcommitを確認する。
- 同ID版本文差、順だけ差、revisionだけ差、CRLF／Unicode差、なし／disabledを比較fixtureにする。
- native範囲外値のprojectionを丸めない契約、DB unavailable＋Host observed、Host unknown＋DB active、SDK unknown、自由error本文禁止を確認する。projection未実装段階では実native接続試験済みと記載しない。

H5d3bは通常Appへtest-only注入したserviceで、両theme、未接続、明示照会、readonly表示、Project保存不変を確認する。sync throw、reject、invalid response、request/context取り違え、subscriber再入、Abort無視、timeout後遅延成功、pending置換、close/reopen、service交換、同ID版Project置換、dispose中cleanupを制御Promiseで検証する。最大active1/pending1と古いownerへの非表示を直接assertする。native read実接続・SDK状態watch・認証・製品transportを完成条件に含めない。

本設計の受入は表示用契約の確定であり、service実装・managed操作の完成ではない。d4のmutable操作結果・receipt・不確定commitの表示は別の厳密契約を経て追加する。

## 11. H5d3aの実装入口

TSの公開入口は`recording-management-contract.ts`。`parseRecordingManagementContext`／`parseRecordingInspectionRequest`／`parseRecordingInspectionResponse`とunion用の`parseRecordingManagementDocument`はunknownからowned／deep frozen snapshotを返し、不正入力は有限の`Recording management: invalid`へまとめる。`validateRecordingManagement`はboolean検証である。初回copyの予算はgetterを実行しないkindのdata descriptorで選び、nested request／contextとH5a desiredにも独立上限を再適用する。Proxyの実行隔離は保証しない。

`sameRecordingInspectionRequest`は両入力を再検証してrequestIdと全contextを比較する。`compareDesiredApplied(local, response)`も再検証し、localのundefinedだけを設定なしとする。nullや不正入力をabsentへ落とさない。結果はfreezeする。本文の固定field比較はpureな`recording-plan-comparison.ts`を希望設定編集と共用し、表示順を変更しない。

Rustの`recording_management`は`validate_recording_management(&Value)`と、private Valueを保持する同名Context／Request／Response wrapperの`from_value`／`as_value`を提供する。比較は検証済みwrapperだけを受け、`compare_desired_applied`のenumは`to_value()`で共有JSON形へ変換できる。全文request比較と本文比較は整数の1／1.0／指数表記を同じ値として扱う。

共有fixtureは`examples/recording-management-cases.json`の受理447件、比較18件、全文request9件。既存H5a139件のネストと、getter・非JSON・所有権／freeze・byte／node／depth端点を別途検証する。`e2e/recording-management-contract.spec.ts`は通常App内のmodule評価とProject書出し不変を確認し、管理画面や実native接続の検証とは扱わない。
