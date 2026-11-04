# 記録操作wire契約とserver core／host境界

状態: **採用詳細設計・prep1純粋契約とprep2状態モデルを実装**。2026-11-05（日本時間）。主設計はユーザー指定のAstra。
本書は[c4接続境界](historian-recording-bridge-boundary.md)と[c4b非同期monitor設計](historian-recording-async-monitor.md)の後続である。
PR #69はwork `26437260a43c9691e1dc568df7b3e5495c6e4f8e` へマージ済み。c4bコードを実装照合の根拠とした。
設計PR #70はwork `e0ab72b`へ統合済み。prep1は14rootの純粋JSON契約だけを実装し、host・認証・通信待受は後続とする。c4bはtest-only portによる通常App受入までで、native product接続ではない。

## 1. server coreと最初のhost

[統合設計§11](../scada-integrated-design.md)はS9bをSCADA server core＋host 1の基盤とする。
固定参考資料[上流§13.2](../../upstream/industrial/scada-design.md)は、coreを独立library、host 1をアプリ埋込、host 2をheadless console、host 3をWindows serviceと定めている。
Historianの記録・保持・検索と、SCADA serverの警報評価／ACK／常時Actionの責務は分離し、初期同一processへの同梱は許す。
Hubは現在値と書込みを担い、History／警報エンジンを追加しない。

**推薦する次の構造はserver core側にtransport非依存adapterを置くこと**である。
これは「Tauriかserverか」の二者択一ではない。Tauriはアプリshellの候補で、server coreの所有を置き換えない。
製品shellやHTTP framework、IPC方式の選定・公開は今回確定しない。

| 選択肢                      | 責務と利点                                           | 本書の位置付け                                 |
| --------------------------- | ---------------------------------------------------- | ---------------------------------------------- |
| server core library         | 全callerのowner／記録／警報の共通管理、UI viewと独立 | 採用済み責務。wire registryを置く推奨場所      |
| embedded application host 1 | coreをアプリprocessへ同梱し、初期配布を単純化        | 既存v1目標。具体shell／起動実装は保留          |
| Tauri shell                 | desktop bridge／trayなどの実装候補                   | 未選定。同期FFIが存在すると仮定しない          |
| headless／Windows service   | UI process終了後も記録する運用形態                   | 後続host。先に無認証HTTPを公開する理由にしない |

local modeではSCM Runningかつhealthyだけ既存serviceへ接続し、Stopped／NotInstalledが埋込起動候補である。
遷移中／判定不能は埋込起動しない。shared modeはremote接続失敗でも自動local embedを行わない。
この規律を採用目標として維持するが、今回SCM検出や起動を実装しない。
embedded process終了と、画面close／view disposeは別である。host 1のprocess終了時には記録終了があり得ることを案内する。
常時記録の永続性をUI processから分離する製品構成はservice host側の工程である。

## 2. 現行の具体的な不足境界

c2/c3 native ownerはRust opaque handle、Tokio runtime、単一Supervisorと既存reader leaseを所有する。
c4aは非同期admissionの五rootを検証するだけで、lease・観測・cancel・subscriptionのwireがない。
c4b参考コードの[local port](../../../apps/banto-scada/src/lib/recording-async/port.ts)は同realm Promise／cache／listenerを仮定する。
[coordinator](../../../apps/banto-scada/src/lib/recording-async/coordinator.ts)はframe先着だけで元Promise枠を解放しない。

その間に必要なのは、native受理前登録、元callの終端を照会できるregistry、完全snapshot＋subscription、期限leaseと認可境界である。
本書はこれらを設計するが、[P3b](transport-boundary.md)／[アクセス方針](access-policy.md)の保留を解除しない。
HTTP path、TCP port、Tauri command、login API、資格情報保存先は本書に架空の実装名を与えない。

## 3. 論理sessionと認可

transportが認証・認可済みのcallerをcoreへ渡す。wireのprincipal名やrole文字列を信用して権限を得る方式は禁止する。
匿名監視と計画変更は別権限であり、開発editorのログイン不要をremote mutationの無認証許可へ転用しない。
local IPCも呼出元／processの認可をhostで確認し、「loopbackだから管理者」と扱わない。

`Scope = { ownerRef: Id, ownerEpoch: Id, context: RecordingOperationsContext }` を新wire rootで使う。
ownerEpochはprocess／registry世代を識別し、再起動で新値にする。contextはimmutableな対象宣言で、auth証明ではない。
native registryはscopeに加え認可済みprincipal bindingを内部保持する。別principalが同文字IDを送っても別の操作を取得できない。
全callerが同native owner gateを共有し、scope・認可の違いでwriterを複製しない。

既存c4a AdmissionRequest等のfieldは増やさない。それらは認可済みlogical sessionに配送し、sessionのscopeとownerRef／contextを照合する。
ownerRefはepochごとに再利用せず、古いsessionへ新epochを黙って割り当てない。
principalの実装方式・権限名・認可失効時に既発行操作をどう監視させるかは製品公開前のgateである。
安全側の基準は新mutation拒否、既発行native操作を認証失効だけでrollback扱いにしないことである。

## 4. 新wire resourceの共通規則

新しい独立schema resourceをversion 1として追加する。既存c4a五root、d4a／H1、Project 0.37.0、DB7、SDK／Banto／依存版は変更しない。
全field必須、nullable省略不可、未知field拒否。IdはH1、U1は1..MAX_SAFE、U0は0..MAX_SAFE。
`WireError`は `unauthorized | forbidden | ownerUnavailable | expired | capacity | protocolViolation | internal` の閉集合とする。
既存OperationErrorは変更せず、native操作拒否と配送／sessionの拒否を区別する。

以下の型は**採用する論理JSON契約**であり、現在のHTTP endpointや実serviceではない。
各rootは共通に `{version:1, kind:以下のliteral, ...}` を持つ。
表と型に現れるrequest／scopeは全文echoし、object key順・整数表記差だけを同値とし、member表示順は保持する。
未知の秘密field、URL、credential、stack、任意error文字列は許可しない。
新wire同士のnested Scopeは全field同値とする。既存c4a rootは存在するownerRef／contextだけ、d4a rootはcontextだけを照合する。旧rootにownerEpochやScopeがあると仮定せず、そのepochは認可済みlogical sessionへのbindingによって実adapterが確認する。

## 5. lease request／reply

```ts
type LeaseRequest = {
  version: 1;
  kind: "recordingWireLeaseRequest";
  scope: Scope;
  leaseRequestId: Id;
  admissionId: Id;
  role: "mutation" | "reconciliation";
  requestedBudgetMs: U1; // 1..10000
};
type LeaseReply = {
  version: 1;
  kind: "recordingWireLeaseReply";
  request: LeaseRequest;
  outcome:
    | { kind: "issued"; deadlineLeaseRef: Id; grantedBudgetMs: U1 }
    | { kind: "rejected"; error: WireError };
};
```

grantedBudgetMsはrequestedBudgetMs以下、1..10000。発行時にnative Instant期限を一度確定する。
leaseRequestId同値再照会は同じlease／同じ元budgetを返し、期限を再開始しない。replyのbudgetは残余時間ではない。
leaseはscope／principal／admissionId／roleへ一回束縛する。mutation leaseをreconcileへ使わない。
未使用→消費済み／失効の一方向で、同admissionに別leaseを付けた再送はWireError.protocolViolationで確定拒否する。同ID別本文もprotocolViolation、role／principal binding違反はforbiddenとし、自由文字列へ変換しない。
現local c4b LocalLeaseRequestにはroleがないため、実adapterへ接続する前にportのlease要求へ明示classを渡す対応変更が必要である。admissionIdのma:/ra:等prefixから認可やroleを推測しない。hostはadmitの実actionと登録済みroleを照合し、role違反をdispatch前に拒否する。このlocal port変更はprep1では実装しない。

native期限はlease発行後のreply配送、JS待機、admit配送、dispatcher／blocking待機を全て含む。
JS performance.nowとInstantをcastしない。wall clock較正やUI時計を削除操作の権威にしない。
発行前のlease取得通信は別の有限readであり、その時間までnative operation budgetへ含めたとは主張しない。
UI意図が失効／close済みならlate issuedを使わず失効に任せる。既受理admitはUI timeoutで取り消さない。

## 6. operation／readの結果観測

```ts
type ObservationRequest = {
  version: 1;
  kind: "recordingWireObservationRequest";
  scope: Scope;
  observationId: Id;
  target:
    | {
        kind: "operation";
        operationRef: Id;
        request: RecordingOperationRequest;
      }
    | {
        kind: "reconciliation";
        readRef: Id;
        request: RecordingReconciliationRequest;
      };
};
type ObservationReply = {
  version: 1;
  kind: "recordingWireObservationReply";
  request: ObservationRequest;
  outcome:
    | { kind: "pending" }
    | { kind: "operation"; result: RecordingOperationResult }
    | { kind: "reconciliation"; delivery: ReconciliationDelivery }
    | { kind: "unavailable"; error: WireError };
};
```

operation／reconciliation branchはtargetのkindに一致し、元request全文、readRef／ownerRefを照合する。
ObservationRequestは既に受理されたnative handleだけを参照し、存在しないrefを開始要求と扱わない。
pendingはnative completion未確定であり、client側のcompletion Promiseをresolveする値ではない。
同observationId／同本文の明示照会はnative処理を再実行せず、同じ登録handleの最新状態を返す。
terminal結果は一回確定し、以後同じ値を返す。別本文同IDは拒否する。

c3 `OwnerError::Unavailable/Internal` は既存ReconciliationDeliveryのreadUncertainへ投影する。
これはnative reader cleanup確認不能の証拠であり、ネットワーク切断をこのbranchへ変換しない。
operationのfailed/unconfirmedとreadUncertainは別で、read結果のquiescenceは元applyの根拠を維持する。

transport adapterは一個の既受理observation登録に対して一個のローカルcompletion Promiseを保つ。
完全frameに同じ結果が見えても、それだけで元observe callの正常終端を捏造しない。
元callのterminal replyを取得し、元ID／scope／requestを照合した後にだけ正常resolveする。
切断後の同ID照会は同callの回復であり、新native待機taskや無制限Promiseを作らない。
最終的に通信失敗としてPromiseをrejectした場合、c4bのuncertain枠は後から再resolveしない。別回復手順へ停止する。

## 7. cancel request／ack

```ts
type CancelRequest = {
  version: 1;
  kind: "recordingWireCancelRequest";
  scope: Scope;
  cancelId: Id;
  target: { kind: "operation" | "reconciliation"; ref: Id };
};
type CancelReply = {
  version: 1;
  kind: "recordingWireCancelReply";
  request: CancelRequest;
  outcome:
    | {
        kind: "ack";
        disposition: "requested" | "alreadyCompleted" | "notSupported";
      }
    | { kind: "rejected"; error: WireError };
};
```

cancelIdは受理前登録し、同ID同本文は元ackを返す。異なる対象へ付け替えない。
requestedはtoken通知の根拠だけで、未実行／commit取消／物理終了を意味しない。pauseのstopは撤回せずnotSupportedを維持する。
取消要求はscopeに登録された元handleだけに作用し、同時刻の別operationへ移らない。
通信未送信で終わったローカル取消は資格を消費しない。発行後ack喪失は再実行ではなく同cancelId結果照会として扱う。

## 8. snapshotとrace-free subscription

```ts
type OwnerSnapshot = {
  scope: Scope;
  revision: U1;
  closed: boolean;
  ownerBlocked: boolean;
  admission: RecordingAdmissionReply | null;
  operation: { operationRef: Id; result: RecordingOperationResult } | null;
  reconciliation: ReconciliationDelivery | null;
};
type AttachRequest = {
  version: 1;
  kind: "recordingWireAttachRequest";
  scope: Scope;
  attachId: Id;
  afterRevision: U0 | null;
};
type AttachReply = {
  version: 1;
  kind: "recordingWireAttachReply";
  request: AttachRequest;
  outcome:
    | { kind: "attached"; subscriptionRef: Id; snapshot: OwnerSnapshot }
    | { kind: "rejected"; error: WireError };
};
type StateFrame = {
  version: 1;
  kind: "recordingWireStateFrame";
  subscriptionRef: Id;
  snapshot: OwnerSnapshot;
};
type ControlRequest = {
  version: 1;
  kind: "recordingWireControlRequest";
  scope: Scope;
  controlId: Id;
  subscriptionRef: Id;
  action: "detach" | "snapshot";
};
type ControlReply = {
  version: 1;
  kind: "recordingWireControlReply";
  request: ControlRequest;
  outcome:
    | { kind: "detached" }
    | { kind: "snapshot"; snapshot: OwnerSnapshot }
    | { kind: "rejected"; error: WireError };
};
type ControlFrame = {
  version: 1;
  kind: "recordingWireControlFrame";
  scope: Scope;
  subscriptionRef: Id;
  reason: "resyncRequired" | "ownerClosed" | "authorizationLost";
};
```

scopeは全nested文書と同値、snapshot.revisionはafterRevision以上。afterRevisionが現在revisionより大きければprotocolViolation。
ControlReplyのdetachedはdetachだけ、snapshotはsnapshotだけ。StateFrame／ControlFrameは確定済みsubscriptionRefだけに配送する。
ownerBlockedはnative sticky recoveryだけで、通信切断や一時Busyを混ぜない。connectedはwire snapshotに入れずclient adapterの配送状態として作る。

attachのlinearizationは、同owner lock内でsubscriberを登録して完全snapshotのrevision Rを取得する点である。
その後の更新はRより大きいrevisionとして当該subscriberの最新一件slotへ保存する。
AttachReplyが届く前のframeはsubscription確定までclient側一件だけ保留し、reply後にrevisionを照合する。
Rのsnapshotを公開した後に保留frameを適用するため、snapshot取得と購読開始の間で状態を取り落とさない。

frameは完全stateなので中間revisionをcoalesceしてよい。operation結果の履歴配送をframeのlossless性へ依存させず、immutable observation registryで回収する。
同revision同本文は冪等、同revision別本文はprotocolViolation。低いrevisionの既知重複は無視し、別epochや未知subscriptionからのframeは適用しない。
coordinatorへはadapterが単調な完全frameだけを渡す。配送の並べ替わりをnative状態巻戻しと誤認させない。
revisionはchecked U1、枯渇時は新更新を停止しresyncRequiredと管理終了へ進め、wrapや無言epoch変更をしない。

遅いsubscriberの送信slotは一件、control slotも一件。controlが詰まる場合はsubscriptionを閉じ、再attachを要求する。
detachはsubscription資源だけを解放し、owner／recorder／native operationを止めない。
reconnectは同scopeへの明示attachで完全snapshotを取り直す。process再起動でepochが違えば新ownerとして表示し、旧要求を送信し直さない。

## 9. 元callのread-only終端照会

ACK喪失時にLeaseRequest／AdmissionRequest／RecordingAdmissionInspectionRequest／CancelRequest／AttachRequest／ControlRequestを再発行することを回復手順としない。未登録なら初回実行になり得るためである。次の二rootを追加する。

```ts
type CallInspectionRequest = {
  version: 1;
  kind: "recordingWireCallInspectionRequest";
  scope: Scope;
  callInspectionId: Id;
  original:
    | LeaseRequest
    | RecordingAdmissionRequest
    | RecordingAdmissionInspectionRequest
    | CancelRequest
    | AttachRequest
    | ControlRequest;
};
type CallInspectionReply = {
  version: 1;
  kind: "recordingWireCallInspectionReply";
  request: CallInspectionRequest;
  outcome:
    | { kind: "pending" }
    | {
        kind: "terminal";
        reply:
          | LeaseReply
          | RecordingAdmissionReply
          | RecordingAdmissionInspectionReply
          | CancelReply
          | AttachReply
          | ControlReply;
      }
    | { kind: "notFound" }
    | { kind: "unavailable"; error: WireError };
};
```

originalのkindとその固有IDで元callを特定する。scopeと元本文を全文照合し、terminal.replyは対応するkindかつ元request全文をechoする。新しいCallInspectionRequest自身をoriginalに入れず再帰構造を作らない。既存c4a RecordingAdmissionInspectionRequestは有限のAdmissionRequestを含むためoriginalへ許可し、対応するRecordingAdmissionInspectionReplyをterminalで返す。これによりc4bの受付照会Promise自身のACK喪失も元call終端と照合できる。
このAPIは検索だけを行い、未登録originalを登録・実行・lease発行・cancel通知・subscribe開始しない。notFoundは後着不能証明ではなく全ての送信gateを維持する。
terminalは**元dispatcherの当該call処理が終了し、元返信が不変値として保存された**ことの証拠である。native operation／readの終了やcommitはその返信だけから別途判断し、dispatcher終了と混同しない。
元admitがunknownを正常返信した場合、その元replyは永久にunknownのまま返す。後のc4a admission inspectionがacceptedを証明しても元terminal replyを書き換えない。clientは元call正常settleと受付の新証拠を別々に統合する。
通信喪失だけならclient adapterは元Promiseをpendingに保持し、このread-only照会のterminal全文を検証して同じPromiseを一度だけresolveできる。frame／c4a foundだけではresolveしない。既にrejectしたPromiseを再resolveしない。
元callがpanic等で正常terminalを保存できない場合はpendingまたはunavailableを維持し、処理未確認をterminalへ偽装しない。retired／processlossもunavailableであり新送信許可ではない。
同callInspectionIdは同originalへ固定し、再照会はpendingからterminalへ進み得るがterminal本文は不変である。既存observationのread-only照会は§6の専用APIを使う。
attach／controlも同ID同本文の元結果を保存する。attachのterminalは最初のsnapshotとsubscriptionRefで、最新snapshotへ差し替えない。最新状態は別の明示control snapshotで得る。

## 10. native dispatchのlinearizationと受付応答喪失

adapterは認可／scope／全文／最大reply／lease／全pool予算を確認し、native呼出前にadmission recordを登録する。
短い共通gate内でrecordをRegisteredへ遷移させ、同ID別本文を遮断する。DBやjoinをlock保持中に待たない。
recordは `Registered → NativeAccepted | Rejected | Uncertain`。NativeAcceptedはc2がhandleを返した点で確定し、結果は別に待つ。
これは初回分類であり、元callのterminal reply保存とは独立した受付知識である。Uncertainを後から更新できるのは、同世代・同元要求に対応するnative opaque handleまたはtyped未受理証拠を元ownerから取得・照合できた場合だけとする。notFound、frameのJSON同値、別processのDB receipt、JS時刻から更新せず、更新後も元callのterminal replyは不変とする。既知acceptedを後のunknown／rejectedで取り消さない。
登録済みとnative受理済みを混同しない。native typed OperationRejectionはRejected、panic／return喪失はUncertainである。
同recordの再照会はnativeを呼ばず、元receipt／replyを返す。c2が受理したoperationのfailed/notDispatchedをwire rejectedに格下げしない。

c4a inspectAdmission notFoundは後着不能を証明しない。このversionではgate解除のためのseal replyを追加しない。
未登録が返っても元admitがtransport内に残る可能性があるため、clientは新admissionや新leaseで自動再送しない。
将来解除を可能にする場合は、同gateでterminal tombstoneを原子登録して後着を拒否するfence、またはhostがlease失効と一回束縛を証明する専用契約が必要である。
JSの経過時間だけでその証明を作らない。

registryはprocess内でありDB7へ永続化しない。DB receiptはapply commitの証拠で、配送callの受付・物理quiescence・principalを復元する証拠ではない。
processlossではownerUnavailableと旧epochの不明状態を残す。新epochで旧operation／cancel／leaseを再実行しない。
再起動回復は既存native明示診断と新しい認可・対象確認を通す別capabilityであり、本工程に自動resumeを含めない。

## 11. 有限資源と保存方針

native c2/c3の上限を増やさず、adapter側でも次の独立上限を採用する。上限はowner scope単位、別principalで迂回しない。

| 資源                 | 上限／規則                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------- |
| mutationAdmission    | ID4096、新workflowでpreflight／pause／apply／discardの4credit                                 |
| readAdmission        | ID4096、mutationと別pool。reconcileに1credit                                                  |
| callerOperation      | ID4096、workflowでpause／applyの2credit。preflight IDはnative生成                             |
| reconciliation       | ID4096、readAdmissionと同時予約                                                               |
| admission inspection | ID4096、mutation枯渇後も別poolで照会可能                                                      |
| lease発行            | mutation/read各request ID4096、未消費lease各4。片方の枯渇で他方を塞がず、同admissionに一lease |
| 元call inspection    | ID4096、mutationとは別pool、同時call1。元callを実行しない                                     |
| cancel               | ID4096、同時call1。未知ackは元record保持                                                      |
| observation          | operation/read各ID4096、同時未確定call各2。handleごとにnative待機は一つを共有                 |
| subscription         | 同owner最大4、host全体32、各最新state1＋control1                                              |
| attach/control       | 各owner ID4096、同時control1。detachでnative操作を破棄しない                                  |
| registry本文         | 全owner合計16MiB、単一scope最大8MiB。nativeの別保管をこの値に含めたと偽らない                 |

native c2の4096はchangeIdとoperationIdの合計であり、adapter／JSのrole別4096とは同じ数え方ではない。frontend予約成功はnative受理保証ではなく、nativeのtyped上限拒否を登録済みadmissionへ返す。

上限到達で新受付を拒否し、現在処理／回復証拠／既存subscriptionを黙って破棄しない。
各scopeの本文8MiBのうち2MiBはread admission／lease／観測／照会専用に先に確保し、mutationから消費できない。host全体16MiBもscope作成時に同予約を含めて確保し、回復readがmutation本文によって全面枯渇しないようにする。read専用予算自身の枯渇は有限停止とする。
workflow予約はIDだけでなく、元要求から計算した最大受付replyと3stage分の結果保管bytesを先に確保する。
正常typed拒否や確実未送信で再試行する場合は追加creditを予約し、後続apply／discard予約を消費しない。
read admissionと照会はmutation枠に依存しないが、それぞれの有限poolが枯渇すれば停止する。

不変ID tombstoneはowner終了まで保持する。全本文はcurrent workflowと最近の終端recordを予算内に保持し、retired結果はunknown／unavailableとして扱いnotDispatchedへ変換しない。
本文をretireする場合も同ID別要求の再dispatchを拒否する。必要な元handleを持つ未完了recordはretireしない。
raw要求hashだけで受理済み全文一致を捏造せず、本文を失ったrecordへのexact replayもunavailableとする。
lease失効後の同ID再発行、poolの自動reset、新owner作成によるsticky recovery解除は禁止する。

## 12. JSON予算と純粋意味検査

新request rootは256KiB／8192nodes／depth48、新reply／frame rootは2MiB／65536nodes／depth80。
OwnerSnapshot単体も1MiB／32768nodes／depth64を上限とする。nested c4a／d4a／H5aには各独立上限とsemanticを適用する。
計数はc4aと同じ保守計数（number24bytes、control scalar6bytes、quote/backslash2bytes、他UTF-8＋構造記号）でRust／TS一致を保つ。
wire受信raw bytesは別途同root上限で打ち切り、圧縮展開も同上限とする。構造入力だけのvalidatorでネットワーク受信量を制限したとは主張しない。

Lease／Observation／Cancel／Attach／Control／CallInspection request受理には最大reply closure成功を必須とする。
未知refは64 ASCII、WireErrorは最長文字列を使い、未知snapshotは全合法snapshotに共通の上界1MiB／32768nodes／depth64を代入する。実registry本文を純粋closureの入力や前提にしない。操作結果は元requestに対応する最大branchを用いる。
元receipt等が確定しない場合は許容field上限から保守的に予約し、適合しない要求をnative dispatch後に初めて発見しない。
prep1の純粋closureは実registryを読まない。元要求の実計数へ、未知snapshotなら上記1MiB／32768nodes／depth64、未知OperationResult／ReconciliationDeliveryなら各nested契約の上限、固定envelope記号と最大IDを加算する上界検査と、既知の有限最大branch構築を併用する。純粋型で表現できない実recordの保存余力は後続registryが別に検査する。schema-validという理由だけで巨大なreplyが収まると仮定しない。raw bytesとowned保守計数は独立に制限し、一方の合格で他方を免除しない。
OperationResultの既存256KiBはcompact計数であり、そのまま保守bytes上界に流用しない。controlのescape拡大は最大3倍、numberはcompact最小1byteから24bytesなので、`3 × 256KiB + 21 × 8192 = 958464bytes`を保守上界とする（node8192／depth32は維持）。ReconciliationDeliveryの512KiB／16384nodes／depth48は既に保守計数である。

閉じたreplyのrequest／payload以外のfieldは、最大ID／errorを含め1KiB／32nodes未満であり、共通の64KiB／4096nodes／depth3を固定envelope上界として予約する。requestの実計数、payloadの独立上界、固定envelopeを加算し、depthはrequest＋1／payload＋2を比較する。未知snapshotを擬似的な有効JSONとして作らず、有限branchを包含する数値上界を使う。

CallInspectionRequestだけは1MiB／32768nodes／depth64、CallInspectionReplyだけは4MiB／196608nodes／depth96の独立profileとする。既存rootの上限は変更しない。originalはその元rootの独立予算も満たす。
CallInspectionReplyの純粋上界は、request全体上限1MiB／32768nodesと、元reply最大2MiB／65536nodesと、最大envelope64KiB／4096nodesを加算して4MiB／196608nodes内で検査する。depthは各nested rootの最大depth＋実際の固定nesting段数を加算し96以下を検査する。originalがAdmissionRequestなら元c4aの512KiB上限も別に適用する。この上界計算は未知の将来snapshotを作る／registryを参照する必要がなく、仮想上界値のexact／1不足試験が可能である。
元request受付時にも対応replyの上界とCallInspection包絡上界を確認し、後から元replyが照会用profileに入らない事態を許さない。実保存bytes予約はこの構造上界とは別のstateful gateである。
closureは公開validatorを再帰呼出しせず、内部shapeと予算walkerで構築する。reply echoの重複nodeも実計数する。

snapshotが更新で上限を超えそうな場合、当該操作の受付前予約とprojectionで拒否する。既存recordの失敗を架空の小さい成功frameへ置換しない。
pure validatorはscope/request/refの既知文書間一致、branch、数値、予算だけを検証する。
実principal、registry一意性、lease期限、native受理、join完了、subscription linearizationはstateful hostの責務であり、JSON受理を実行資格と呼ばない。

## 13. 次の実装順とgate

**c4c-prep1: 新wire純粋契約だけを実装した**。
新resourceのLeaseRequest/Reply、ObservationRequest/Reply、CancelRequest/Reply、AttachRequest/Reply、StateFrame、ControlRequest/Reply、ControlFrame、CallInspectionRequest/Replyの14rootを提供する。
Rust／TS owned validator、既知request/reply／subscription frameの一致helper、最大reply closure、共有fixture、browser module評価を提供する。
既存c4aの五rootを改版せず、local schema resourceとして参照する。App／native owner／listener／認証／transportは変更しない。

[prep2詳細設計](historian-recording-registry-model.md)のprep2aとして、Rustの単一owner状態モデル、仮想lease／時計、受付台帳と元call終端照会を実装した。実native operationはdispatchしない。[prep2b1の結果観測](historian-recording-registry-observation-model.md)も純粋モデルへ実装した。[prep2b2の取消モデル](historian-recording-registry-cancel-model.md)も実装した。[prep2b3のsnapshot・subscription](historian-recording-registry-subscription-model.md)も実装した。[prep2b4のAstra設計](historian-recording-registry-workflow-model.md)に沿い、b4aの単一候補の全段階予約と明示段階進行、独立reconciliation ID台帳を純粋モデルへ実装した。正常終端後の次workflowも[b4b](historian-recording-registry-workflow-renewal.md)として、同run資格・predecessorと累積資源を確認する明示更新を実装した。[prep2b5aの複数scope資源モデル](historian-recording-registry-global-budget.md)も全量予約する純粋Rust domainとして実装した。同domainの管理scope内の保証であり、実hostへの接続や全native資源の排他は後続である。受信側の並べ替え・同revision矛盾検出も別工程である。
実adapter／server core hostへの接続はc4c実装工程であり、prepという名前でP3b gateを迂回しない。
着手前に製品shell／embedded host起動、認証APIとprincipal binding、資格情報と設定配置、実配送とshutdownを別途確定・レビューする。
現在の保留中でもprep1は独立してレビュー可能であり、実環境の許可を推測する必要がない。
実adapter接続前にはwireからlocal portへの投影契約も改訂・レビューする。ownerEpoch／closed／ControlFrame、lease role、元call terminalは現在のlocal portへ透過的には入らない。closedを捨てず、epoch交代・権限失効・配送切断をnative ownerBlockedへ混ぜない。必要なlocal型／gate変更と旧版拒否を明示し、prep1で現portを変更した、またはそのまま実wireへ接続可能と称さない。

## 14. 受入matrix

| 工程／境界     | 必須受入                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| prep1 shape    | 14root、未知field、scalar、安全整数、nested全予算、branch不一致、外部schema取得無し                                 |
| prep1一致      | owner/epoch/context、元operation/read全文、member順、1/1.0、cancel対象、subscriptionとframe scope                   |
| prep1 closure  | 最長ID／error／receipt、exact/1不足byte・node、echo重複、全最大branch、現上限で到達不能なら同walker小予算           |
| 後続lease      | 発行から配送待ちを課金、同ID返信で延長無し、失効後拒否、別principal/admission/role不可                              |
| 後続admission  | 全caller競合1、登録直後panic、native受理後応答喪失、typed拒否とunknown、後着notFound非解除                          |
| 後続元call照会 | 未登録照会で初dispatch無し、元unknown返信不変＋後のaccepted知識、terminal echo、ACK喪失attach/cancel、retired非解除 |
| 後続観測       | frame先着／call pending、切断再照会、terminal immutable、readUncertainと通信障害分離                                |
| 後続購読       | 登録とsnapshot間の更新、ACK前frame、順逆転／同revision矛盾、遅いsubscriber最新1、detach非停止                       |
| 後続寿命       | UI dispose、root終了、SDK runtime保持、embedded process終了、service mode失敗でauto embed無し                       |
| 後続容量       | 全pool予約／枯渇、本文上限、未完了record非retire、retired結果で再dispatch不可、回復枠分離                           |
| 後続認可       | anonymous監視とmutation分離、同ID別principal拒否、権限失効／再接続／別epoch、credential非配送                       |

未決なのは製品shell・実transport・認証連携・host運用のrelease条件であり、prep1のJSONと検証範囲ではない。
試験はlocal純粋fixtureと隔離mockから始め、将来native結合でも実Hub／S7／本番DBの受入を代替したとは主張しない。
