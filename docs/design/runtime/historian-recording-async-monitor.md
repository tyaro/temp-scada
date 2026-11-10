# 記録操作の非同期受付coordinatorと通常App表示

状態: **H5d4c4bの採用詳細設計・test-only portでlocal実装済み**。2026-11-04（日本時間）。主設計はユーザー指定のAstra。[c4接続境界](historian-recording-bridge-boundary.md)と実装済みc4aの五rootを使う。設計PR #68はworkへ統合済み（`e23bea9`）。Project 0.37.0、DB7、H1、SDK／Banto／依存と五root schemaを維持する。

## 1. 提供するものと保留

外部rootが所有する共有JS coordinator、同realmの非同期test port契約、通常Appへの任意注入と表示、制御Promiseによる受入を実装した。実lease／host registry／native adapter／Tauri／server／認証／製品transportは提供しない。実Hub／S7／本番DB／上流へ接続しない。

既存[d4b service](../../../apps/banto-scada/src/lib/recording-operations/service.ts)は同期handle受付、[monitor](../../../apps/banto-scada/src/lib/recording-operations/monitor.ts)はApp内の寿命である。新非同期経路は別interfaceとcoordinatorを持ち、同期serviceをPromise wrapperで偽装しない。c4a [validator](../../../apps/banto-scada/src/lib/recording-admission-contract.ts)のshape／nested予算／全文照合／最大reply closureはそのまま使う。

## 2. 所有とApp注入

composition rootが `createAsyncRecordingOperationsCoordinator(port)` を一回呼び、返された非Clone相当の管理rootをAppより長く保持する。全App／全callerはそのrootから得たclientを共有する。同portに複数coordinatorを作って独立gateにすることは禁止し、factoryは同realmのWeakMapでport objectに対する二重管理root作成を同期拒否する。これは別realm／processの上限を保証せず、実hostの共通native gateが最終権威となる。

Appの新propは `recordingAsyncOperations?: AsyncOperationsClient`。App自身はfactoryを呼ばず、unmountで管理rootを閉じない。通常entryは未注入のまま、テストだけ外部rootとportを注入する。

App内の操作modeは、最初の有効な単独注入でsyncまたはasyncへ固定する。現在App寿命中のsync→async／async→syncは、旧prop撤去と新prop追加が同時でもmodeConflictで新送信を拒否する。旧Workspaceを条件付きunmountせず、元ownerの監視を常設保持する。同mode内のservice交換は後述の安全な明示切替を使う。別modeへの移行は本PRの操作対象にせず、composition rootで旧処理の終端／安全な管理移管を確認してからAppを再構成する。Appを再mountしただけで別native ownerまで安全になるとは主張しない。

既存 `recordingOperationsService` と新propが両方非undefinedなら `configurationConflict` とし、どちらの新送信も許さない。既に発行された操作は元ownerが継続保持する。切替えを暗黙優先順位や自動fallbackで解決しない。既存同期経路のみの注入は従来挙動を維持する。

AppのProject object／generation／openOwner／注入client objectを束縛したview tokenを発行し、render前の即時owner guardを維持する。閉じる／Project読込／service交換でtokenを退役させる。監視中の旧clientとrawな選択clientを別に比較し、撤去・不正client・A→B→Aでも旧送信用viewを永久退役させる。旧結果は「以前の対象」の監視として有限に保持できるが、新Projectの送信資格にはしない。

## 3. local portの仮定と型

以下は**同realm test-only injectionの契約**でありwire schemaではない。Promise／subscribe／object identityをIPC仕様と呼ばない。fieldは全て必須、nullableは明示する。metadataはowned化して既存validatorまたは下記有限検査を行い、methodsをcloneしない。

```ts
interface AsyncRecordingOperationsPort {
  readonly context: unknown; // d4a OperationsContext
  readonly ownerRef: string; // H1 ID、immutable
  prepareLease(request: LocalLeaseRequest): Promise<unknown>;
  admit(request: RecordingAdmissionRequest): Promise<unknown>;
  inspectAdmission(
    request: RecordingAdmissionInspectionRequest,
  ): Promise<unknown>;
  observeOperation(operationRef: string): LocalOperationObservation;
  observeReconciliation(readRef: string): LocalReconciliationObservation;
  current(): unknown; // LocalOwnerFrameのcache、通信しない
  subscribe(listener: (frame: unknown) => void): () => void;
  requestCancel(request: LocalCancelRequest): Promise<unknown>;
}
type LocalOperationObservation = {
  operationRef: string;
  request: RecordingOperationRequest;
  completion: Promise<unknown>; // d4a OperationResult
};
type LocalReconciliationObservation = {
  readRef: string;
  request: RecordingReconciliationRequest;
  completion: Promise<unknown>; // c4a ReconciliationDelivery
};
type LocalLeaseRequest = {
  ownerRef: string;
  admissionId: string;
  context: RecordingOperationsContext;
  requestedBudgetMs: number; // 明示整数1..10000
};
type LocalLeaseReply = {
  request: LocalLeaseRequest;
  outcome:
    | { kind: "issued"; deadlineLeaseRef: string }
    | { kind: "rejected"; error: OperationError };
};
type LocalCancelRequest = {
  ownerRef: string;
  target:
    | { kind: "operation"; ref: string }
    | { kind: "reconciliation"; ref: string };
};
type LocalCancelReply = {
  request: LocalCancelRequest;
  disposition: "requested" | "alreadyCompleted" | "notSupported";
};
```

leaseはowner/context/admissionに一回束縛しnative側で発行時から期限が進む、admit時に同期限を延長しない、というportの前提である。c4b mockはこの前提を制御して試験し、実native lease発行を実装したと主張しない。JSのperformance.nowとnative Instantを換算しない。

```ts
type LocalOwnerFrame = {
  ownerRef: string;
  context: RecordingOperationsContext;
  revision: number; // 同ownerで単調safe整数1以上
  connected: boolean;
  admission: RecordingAdmissionReply | null;
  operation: { operationRef: string; result: RecordingOperationResult } | null;
  reconciliation: RecordingReconciliationDelivery | null;
  ownerBlocked: boolean; // native sticky recoveryのみ。通信unknown／一時Busyではない
};
```

observeOperation／observeReconciliationは既登録refのcache観測を返すだけで、操作・readを新規dispatchしない。同refでは同じimmutable要求と一回限りのcompletionを返し、追加native待機taskを作らない。未知refや異要求はprotocolViolation。operation completionはc2の確定結果（unknownもあり）、read completionはc3のDTO結果または明示readUncertainの有限投影を返す。通信rejectはそのnative結果ではない。coordinatorはacceptedの元request/refと観測要求を照合してから最大一組だけ待つ。frameとPromiseが同じ結果を運んでも冪等に統合する。

完全cache frameを最大一件保持する。frameは最新admission／operation／read各一件で、全履歴や任意payloadは載せない。現workflowの進行中要求を一件保持するproviderが同realmでsubscribe登録とcurrent取得の隙間を単調revisionで埋めることを前提とする。listenerを登録してからcurrentを読み、同revision同本文は冪等、同revision別本文・下がったrevisionの新情報・違うowner/contextは無効とする。旧revisionの重複は適用しない。

接続再開時も同owner完全frameを再取得し、失った通知を推測で補わない。異ownerRef／contextへの自動rebindはない。実wireでこのhandshakeをどう保証するか、frame revisionの発行／保持／認証はc4c前に別途設計する。connected=falseは通信状態だけでnative停止／不受理の証拠ではない。

local lease／cancel metadataは128KiB・4096nodes・depth32、frameは1MiB・32768nodes・depth64を上限に安全owned化する。nested五root／d4aは各独立validatorにも通す。未知field、getter、非JSON、lone surrogateを拒否する。c4a保守JSON計数をframeにも使い、immutable snapshotとして返す。local frame専用の1MiB／32768nodes／depth64検査profileを追加した。現c4aの512KiB／16384nodes／depth48や既存compact profileの既定を変更せず、そのまま流用して64階層を受理済みとしない。新wire rootをschemaへ追加しない。

## 4. coordinator APIとローカル原子gate

```ts
interface AsyncOperationsClient {
  readonly context: RecordingOperationsContext;
  readonly ownerRef: string;
  current(): AsyncOperationsState;
  subscribe(listener: (state: AsyncOperationsState) => void): () => void;
  bindView(identity: object, qualifies?: () => boolean): ViewLease;
}
interface ViewLease {
  preflight(change: RecordingChangeRequest, control: IntentControl): boolean;
  pause(control: IntentControl): boolean;
  apply(control: IntentControl): boolean;
  discard(control: IntentControl): boolean;
  inspectAdmission(control: ReadControl): boolean;
  reconcile(control: IntentControl): boolean;
  cancelOperation(): boolean;
  cancelReconciliation(): boolean;
  retire(): void;
}
type ReadControl = { deadlineMonotonicMs: number }; // 同realmの論理待機期限
type IntentControl = {
  intentDeadlineMonotonicMs: number; // 同realm、未送信意図の期限
  requestedNativeBudgetMs: number; // 1..10000、別の意味
};
```

UI経路は `qualifies` にWorkspaceの現在propsを直接読むcallbackを必ず渡す。captured Project object／generation／openOwner／raw client／blockedと比較し、Svelte effectがselectを更新する前の同一turnでも新送信を拒否する。非UI callerでcallbackを省略した場合は明示retire責務を維持する。coordinatorは新規送信の各直前にstrict trueを要求し、false・非boolean・throwで当該viewを永久退役させる。callback評価中はroot全体で再入したaction／inspection／cancel受付を拒否し、評価後もclose／view.active／immutable owner／connected・sticky gate・物理枠・期限を再検査する。既受理refの観測にはこの送信資格を適用しない。

booleanはcoordinatorがローカル意図を受け付けたかだけを返し、native受理／handle／未dispatch証明ではない。falseはportへ当該意図を発行していないローカル拒否。stateで理由を閉集合表示する。ViewLeaseはProjectそのものをportへ渡さず、Appが正しいcurrent ownerにだけ発行・保持する。

factoryはcontext／ownerRef／全methodを一回捕捉する。同objectのin-place mutationに追随せず、method/contextが変わったサービスは新しいport/rootとして扱う。同期再入に対して、意図token／元change／admissionId／action／controlを先にowned保存してローカル一枠を確保し、その後通知と外部関数を呼ぶ。通知後にはtoken・view資格・期限を再検査する。

全caller共通の意図枠は最大一つ、pending queueはゼロ。prepareLeaseを開始した時点から同じ枠を保持し、issued検証後も解放せずadmitへ一度だけ進む。prepare応答は元LocalLeaseRequest全文／owner/contextに照合する。表示期限到来／view retire／閉じる／Project交換がadmit前なら送信しない。lease Promiseが未settleなら枠は保持し、後着leaseは使わず失効に任せる。非協力Promiseに新leaseを重ねない。

admitの呼出直前をローカル不可逆点として記録し、その後の例外は同期throwを含め受付不明とする。portがdispatch前にthrowしたという口頭仮定ではgateを解除しない。admit後にintent期限が切れても、既発行mutationの取消やrollbackではない。Promiseがsettleするまで同呼出を二重送信しない。

prepareLeaseの失敗はmutation未送信がcoordinator自身で証明できるので、Promiseの正常settleを確認した後にローカル意図を終端にできる。ただし不正lease／provider protocol違反はownerをinvalidにし、新送信を止める。任意throw／thenableを正常lease ackとして扱わない。port Promiseは実処理のquiescence後にsettleする契約で、同期throwはそのport関数が何も開始していない場合に限る。ただしadmitでは保守的にunknown扱いを維持する。

### 送信直前のgate

新規送信を行う外部呼出の前に、immutable owner/context、現在view資格、現workflow token、意図期限、call枠、connectedを再確認する。prepare前とlease正常応答後のadmit直前の両方で行い、通知listenerの同期再入後にも再検査する。間でgateが閉じたらadmitしない。既に送ったadmitはgate変化で撤回しない。 current／subscribeと、既受理refに対するcache／completion観測は新規dispatchではないため、view退役後も元ownerで継続する。新しいlease・admit・inspection・cancelの発行資格とは分ける。

| owner状態                                           | 新preflight／pause／apply／discard      | 元admission受付照会                    | 元apply reconciliation／取消                                                                    |
| --------------------------------------------------- | --------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| connected=true、ownerBlocked=false、正常view        | 各stage資格と物理枠を満たす場合だけ     | 元unknownに対し一read枠だけ            | 対象資格／枠を満たす場合だけ                                                                    |
| connected=false                                     | 全て新送信禁止、lease後もadmitしない    | 新送信禁止。既発行の結果は検証して保持 | 新送信禁止。既発行処理を止めたとは扱わない                                                      |
| connected=true、ownerBlocked=true                   | 全て禁止（discardも正常候補扱いしない） | 元unknownのread-only例外として許可     | 元failed/unconfirmed等の資格を満たすreconciliationは例外許可。既存対象へのcooperative取消は許可 |
| local protocolViolation／不正context／readUncertain | 全て禁止                                | 当該ownerの通信健全性不明なら禁止      | readUncertainでは追加reconcile不可。無効refへの取消も不可                                       |

ownerBlockedはstickyとし、後のfalseや古い成功frameだけでは解除しない。read-only例外でも新lease／admissionが必要だが、これはapplyの再発行ではない。別view／新Projectから旧applyへmutation資格を付け替えず、元ownerの監視に結び付いた明示readだけを許す。

## 5. 三つの状態軸

stateを単一のphaseへ潰さない。

- **admission**: idle／preparingLease／awaitingAck／unknown／accepted／rejected／discarded。native handleの資格はaccepted replyの完全検証後だけ生じる。
- **operation**: d4aのcandidate／paused／applied／failedと元quiescence／recovery。未取得はunknownで、admission acceptedからRunningを推論しない。
- **read**: idle／awaitingAdmission／accepted／completed／readUncertain。c3 readUncertainは元apply unknownと別で、追加readもblockする。

preflight acceptedだけではpause不可。元operationRef/requestに一致するcandidate結果を受けて初めて明示pauseを許す。pauseの正常paused結果後に同候補applyを別クリックで発行する。Replay／errorで停止しない。apply結果は「設定commit済み、再開は別操作」と表示する。既存期待版入力、disabled時bound refs=null、元desired全文・表示順保持はd4bに合わせる。

discardもprepare→admitを通し、completedDiscardが確認できるまで候補を消さない。native拒否なら元候補を保持し、unknownなら候補を安全扱いしない。closeで自動discardしない。

accepted replyと同時／先にframeが到着する場合、最大一件の完全frameを保持し、acceptedでref/requestを照合できるまで操作資格へ使わない。native結果の先着をacceptedの証拠に代用しない。 frame／inspectionが受付や結果を先に証明しても、元admit callが未settleなら次のadmitを送らない。受付の既知状態とPromise物理枠を独立に保持する。元Promiseが後でreject／malformedならprotocol失敗を保持し、先着情報だけで枠を正常完了へ変換しない。同じreplyの重複は冪等、同admissionでacceptedとrejected、異なるhandle ref、別本文の二重replyはprotocolViolationとして既知結果を保持したままblockする。awaitingAck後のlate rejectedは当該admission未受理の証拠として保存できるが、Project/view資格を復活させない。

## 6. 受付照会とreconciliation

admissionUnknown時は元AdmissionRequestを保持し、明示inspectAdmissionだけを許す。五root全文照合を使い、found.replyを元replyと同じ単調規則で統合する。notFound／unavailableはgateを解除せず、元admit再送や新ID再発行を許可しない。元admitが未settleのままinspectを行うことはread-only例外として一枠だけ許すが、新mutationは止めたままである。

prepare／admitのcall枠は共有一つ、inspection call枠一つ、cancel call枠一つ、現在operation／readのcompletion観測は各一つを上限とする。各枠はlogical timeoutやframe先着では解放せず、元Promise自身が正しい元要求に対応する正常結果でsettleしたことを確認する。reject／malformedでprovider quiescenceが証明できなければ当該枠をuncertain終端に保持し、新callを重ねない。inspectでacceptedを発見しても非協力admitを放棄して次stageへ進めない。completion観測も同じ規則で、通知だけ正常先着→Promise rejectの順序は送信をblockする。未知のまま永続停止する場合も有限停止として表示する。

inspectの物理readは最大一つ、追加queueなし。ReadControlは同realmの論理期限を持つが、timeoutでPromise枠を解放しない。closeやProject交換でも元要求に照合してlate結果を保存する。元admit Promiseが後でaccepted等を返しても同じadmissionとして照合し、二重操作として登録しない。notFound後に安全性を証明できない場合の永久blockは正常な有限停止であり、UIからresetして解除しない。

受付・call枠の確定規則は次のとおりとする。Promiseのsettledとprovider処理の正常終端証拠は同じ意味ではない。

| 観測                                                                              | call枠／追加送信                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| boolean false（ローカル意図拒否）                                                 | 当該port呼出なし。元stateを維持                                                                                                                                                                                            |
| 正常lease rejected、または正常admission rejected                                  | 元要求照合済みPromise自身の正常settle後に当該call枠を解放。元candidate／pausedや現在viewの資格は別途再検査                                                                                                                 |
| 明示inspectでaccepted確認、元admitも正常unknownでsettle済み、native正常completion | 受付情報を矛盾なく統合できればcall枠解放。candidate／paused／completedに応じた明示次操作へ進める。unknownという履歴だけを永久latchにしない                                                                                 |
| 正常unknown→inspect notFound/unavailable                                          | callが正常settleしても受付不明gateは維持。新admit／再送不可                                                                                                                                                                |
| frame／inspectでaccepted確認、元admit Promise pending                             | 受付は既知でも物理call枠保持、次admit不可。Promise正常settle後にだけ再評価                                                                                                                                                 |
| admit Promise reject／malformed、または正常先着情報後のreject／malformed          | Promise自体はsettledでもprovider quiescence／整合性は未確認。この版ではcall枠をuncertain終端として保持し、新送信不可。既発行inspectの有効なlate結果は証拠表示できるが、この障害gateを解除したり新inspectを発行したりしない |
| inspection Promise reject／malformed                                              | inspection枠をuncertain保持。別inspectionを増やさず、新mutation不可。native側結果を捏造しない                                                                                                                              |
| lease／cancel／結果観測のreject・malformed                                        | 既知未送信であるleaseでもprovider健全性不明として新送信停止。cancel／completion観測も当該枠をuncertain保持。通常のtyped拒否やreadUncertainとは区別                                                                         |
| 非協力pending、論理timeout                                                        | pending枠を保持。通知だけで解放しない。正しい元Promiseが後で正常settleすれば他gateと併せ再評価                                                                                                                             |

reject／malformedからのtransport再確立や枠移管での解除は今回実装しない。これらの有限停止をroot再作成で回避しない。正常unknown→照会で受付確認という回復経路と、protocol／物理確認不能という停止経路をUIとテストで分ける。

native apply reconciliationは別のactionであり、元applyがfailed/unconfirmed、またはappliedでもunknown／recoveryありの時だけ許す。preflight／pause失敗やfailed/notDispatched／notCommittedを対象にしない。元operationRef／changeRef／元OperationRequestを保有してprepare→admitを実行し、accepted readRefに一致するReconciliationDeliveryだけを統合する。

resultは既存d4a単調規則を使う。Foundは元completionを上書きせずlatestとlastAppliedを更新し、recoveryはOR、元quiescenceは読取完了から推測しない。同一deliveryの重複は検証後に冪等に扱い、後から届いた元operationのconfirmedを古いreadのunknownで取り消さない。初回でも時間的に古いread結果のunknownは既知confirmedを消さず、元要求・receipt矛盾の検査は維持する。notFoundで既知receiptを消さない。readUncertainは有限errorを保持し、新read／mutation／owner切替を止める。配送Promise reject／subscribe切断はnative readUncertainの証拠ではなくdeliveryUnknownとして区別する。

取消は現在のoperationRefまたはreadRefに対する一回のLocalCancelRequestとする。ackは元要求に照合し、requestedでも未実行／停止完了とは表示しない。取消送信中は二重取消を拒否し、ack喪失で勝手に再送しない。通知・資格検査の間にview退役／切断等で呼出前に中止した取消は未送信であり、対象のcancel送信済み枠を消費しない。正常な再open・再接続後の明示要求は許す。pause stopは撤回しない。lease待ちの未送信意図をretireする処理と、native取消要求を分離する。

## 7. App寿命、復帰、外部root終了

close／unmountはViewLease.retireと購読解除だけ。退役前にadmit済みならcoordinatorは応答・frame・結果を保持し、mutationを自動取消しない。新Appは同clientのcurrentに再attachできる。同Project ID/revisionでもobject／generationの交換は旧viewを退役させ、古いUI callbackで送信しない。

同owner/contextへの再openでは監視を再開できるが、過去viewの送信資格を復活させない。新ViewLeaseからの明示操作はcurrent Project/contextの照合と、coordinatorの現workflow gateを両方通す。旧Projectのcandidate／pausedを新Projectへ転用しない。「以前の候補を破棄」は元要求・元ownerに限定する明示操作として別表示し、正常settled、connected、invalid／unknown／recovery／read障害なしのときだけ許す。discard完了後に新対象へ明示的に戻れる。

別client/serviceへ交換したとき、旧coordinatorの未知／進行中workflowがある間はApp内で新ownerの送信を許さない。旧monitorと新選択を分離し、旧側が正常終端・全Promise確認済みなら「選択した接続へ切替」で明示移行する。選択clientが撤去され（slotがEmpty）、旧coordinatorが閉じて安全に終端しているときは、移行先がないので旧clientを手放して未接続の表示へ戻し、次のclientは未接続からの初回接続として扱う。Appは旧client一個＋選択先一個まで保持し、交換のたびに旧owner配列を増やさない。外部rootが複数ownerを管理する場合の全体停止はそのcomposition責務であり、frontendだけで別processを制御したとはしない。

管理rootのcloseはUI disposeとは別APIとする。新view／意図受付を閉じ、既に発行したPromiseと状態はsettleまでroot内部で保持する。既発行mutationを取消さず、未知なら未知の有限終端を残す。port shutdown／native stopを呼ばない。rootを単にGCして動作保証する設計にせず、compositionが保管責任を負う。再作成による同ownerのunknown解除は不可。

## 8. 有限性と安全な表示

coordinatorは一workflow、最大三operation結果、最後のapply成功一件、最新admission要求／reply一件、最新inspect一件、read結果一件、完全frame一件を保持する。全通知queueは持たない。購読listenerの例外・同期再入・通知中unsubscribeを隔離し、送信資格はnotify前に確定する。

IDは同coordinator世代でchecked単調counter＋有限opaque prefixを使い、H1最大64文字を超えない。ローカルpoolは**mutationAdmission／readAdmission／inspection／callerOperation／reconciliationの五roleそれぞれ4096件**とする。同roleの使用済みIDは再使用せず、counter wrapしない。元apply.requestIdはこのpoolではなく不変なDB要求IDである。preflight operationIdはnativeがaccepted replyで生成するので、callerOperation枠から発行・予測しない。

wire上のadmissionIdは共通namespaceなのでmutationAdmissionとreadAdmissionは固定の異なるprefixを使い、counterが同じでも同文字列にならない。

新workflowを受けるとき、mutationAdmission poolへpreflight／pause／apply／discardの4credit、callerOperation poolへpause／applyの2creditを同一ローカル判定で予約する。どちらか不足ならprepare前に拒否する。各callを発行する際に予約を消費してusedへ移し、正常終端／明示discard時に未使用creditだけを解放する。結果不明のworkflowでは消費済みIDを戻さない。prepareだけで退役した場合も発行済みadmissionIdは再利用しない。別の元workflowへcreditを流用しない。各stageの初回予約はその用途を保持し、lease正常拒否・view退役等から同stageを明示再試行する場合は追加のmutationAdmission1と必要なcallerOperation1を原子的に確保する。使用済みIDは戻さず、retry枠の不足で後続apply／discard用予約を消費しない。

reconcileを受ける際はreadAdmission poolの1枠とreconciliation poolの1枠を同時確認・確保する。inspectionは独立inspection poolだけを使い、mutation pool枯渇でも元受付照会を妨げない。mutationAdmission poolが満杯でもreadAdmission枠があれば元applyのreconcileを受理できる。readAdmission自体が枯渇した場合は明示的に停止し、無限の回復回数を保証しない。cancelは対象refに結び付く一callで新operation IDを発行しない。pool枯渇は有限停止で、自動root再作成／unknown要求再送をしない。これらは実native registryの代用ではない。

UIは「受付準備中」「native受付待ち」「受付不明」「候補」「停止join中」「設定commit済み」「結果照会中」「読取完了未確認」「接続切断」「別対象の操作」を区別する。未注入は未接続、二service注入は設定競合。lease ID、内部clock数値など接続判断に不要な実装情報を操作画面に出さない。現在値、SDK Live、録画Runningをこの操作UIの受付だけから表示しない。任意provider error文字列、stack、URL、資格情報を表示せず、既存閉集合またはlocal protocolViolationで表現する。

## 9. local実装と受入

実装対象は新async service型／factory／coordinator／App選択と表示component／test-only port fixture。同期monitorの回帰は維持し、内部のpure比較や表示componentは意味を変えず共用できる。Rust／schema／native ownerは変更しない。

| 境界       | 必須受入                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 選択       | 未注入、同期のみ、asyncのみ、同時注入拒否、sync↔async prop交換はmode固定で旧監視維持、既存同期挙動不変                                           |
| 一枠       | 二client同期再入、lease待ち中追加操作拒否、非協力Promiseで次送信なし、元意図への一回admit                                                        |
| 未送信     | lease待ちのclose／期限／Project・client交換／同一turnのprop交換／late leaseでadmit未呼出し、root枠はsettleまで保持                               |
| 受付不明   | admit throw／reject／timeout、不正reply、notFound後着可能で非解除、late accepted／rejectedと矛盾reply                                            |
| 三段階     | candidateまで録画継続するmock、明示pause、正常join後apply、Replay/errorで停止なし、discard ackまで候補保持                                       |
| native結果 | accepted前のframe先着、元request/ref照合、既知receipt／quiescence／recovery単調保持                                                              |
| read       | admission照会とnative reconciliation分離、readUncertain、deliveryUnknown、読取Promise未settleで追加照会なし                                      |
| 寿命       | close/reopen、同IDProject再読込、service交換、App unmount/remountでも同外部rootが結果保持、旧callback無効                                        |
| frame      | 同revision冪等、矛盾拒否、切断／再接続cache、別owner拒否、同期listener再入／unsubscribe                                                          |
| 予算       | mutationAdmission満杯でもreconcile受付可能、五pool枯渇／credit／異prefix、metadata予算／getter／nonJSON、元数値表記・member順、error文字列非公開 |

browserは通常Appへのtest-only注入で両theme、三操作と照会、保存Project不変、同期経路回帰を確認する。実lease発行・wire frame・cancel ackの実transport仕様はc4c前に別詳細レビューを行う。[P3b再開条件](transport-boundary.md)とhost選定を満たさず実adapterへ進まない。

## 10. 実装配置と確認範囲

`recording-async/{coordinator,monitor,port,state,local-validation,ids}.ts`と`AsyncRecordingOperationsWorkspace.svelte`へ責務を分けた。[コード対応表](../../engineering/code-map.md)を入口にする。clientはfactoryが発行した同realmの凍結objectだけをApp選択で受け付け、未知clientのgetterを呼ばない。ViewLease自体のactive tokenと、Project object／generationごとのopaque identityを分け、同対象再openでは新lease、別対象では旧candidate転用を拒否する。App再mountで以前のidentityを失った場合は証拠監視と明示旧候補discardだけを提供する。

正常な元Promiseのsettle、独立したnative quiescence／recovery、受付照会のFoundを別条件として受け入れる。mutation枠満杯でもreadAdmissionを使い、未送信pause試行で将来のapply／discard予約を消さない。ID上限は試験用に縮小せず実4096で確認する。leaseの期限挙動はmock providerの仮定であり、実native leaseを提供したとの主張ではない。

実wireのlease／frame／cancel ack、認証・製品host・native adapterの接続はc4c前の設計・再開条件へ残す。

PR #69の自動レビューで、監視中clientを保つためraw選択clientの交換を見落とすview退役漏れを修正した。さらにlease resolve→prop交換を同じturnで行うブラウザ再現でeffect前送信を確認し、live qualificationを追加した。送信資格だけを閉じ、元ownerの観測と証拠を保つ。
