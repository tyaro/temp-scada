# 記録操作のJS／native接続境界

状態: **H5d4c4aのpure契約実装済み・c4b／実接続は後続**。2026-11-04（日本時間）。主設計はユーザー指定のAstra。c3はPR #65で統合済み。c4aの独立JSON契約・共通検証をRust／TSで提供する。実transport、native provider、通常Appの接続は追加しない。

## 1. 現行実装と接続上の差

[service.ts](../../../apps/banto-scada/src/lib/recording-operations/service.ts)のd4b serviceはpreflight／pauseJoin／apply／reconcileが同期handleを返し、discardも同期完了する。RecordingOperationRejectedは当該呼出が何もdispatchしなかった証明である。[native owner](../../../crates/scada-runtime/src/recording_host/supervisor/operations/mod.rs)はRust HandleとTokio runtimeを前提とし、[reconciliation](../../../crates/scada-runtime/src/recording_host/supervisor/operations/reconciliation/mod.rs)はread確認不能をDTOとは別のOwnerErrorで返す。

ViteとRust libraryの間にはTauri host、SCADA server、同期FFI、IPCは存在しない。[P3b保留](transport-boundary.md)を維持する。一般のTauri invoke／HTTP／IPCを同期関数のように呼ぶことはできず、Promiseを同期handleへ包むだけでは「未受付」と「native受理後の応答喪失」を区別できない。

したがって次工程では**別の非同期admission契約**を採用する。既存同期serviceの意味は変更せず、非同期境界を別interfaceとして定義・検証する。host製品の選択は行わない。同期FFI portを暗黙の既存機能とせず、将来それを採用する場合も別途host選定・寿命・安全性のレビューを必要とする。

## 2. 工程分割

| 工程 | 提供内容                                                                                      | 完了と主張しないもの                                    |
| ---- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| c4a  | 非同期受付要求／reply／受付照会とread障害の独立JSON契約、Rust／TS pure validator、共有fixture | 通信、registry実体、deadline lease発行、現serviceの変更 |
| c4b  | 常設monitorの非同期admission一枠、通常Appの受付中／受付不明／明示再照会表示。制御port注入試験 | 実Rust接続、製品host、資格情報                          |
| c4c  | host選定・P3b再開条件を別途満たした後、native owner registry adapterと実配送                  | 認証や実Hub接続の暗黙解除                               |

設計PR #66はworkへ統合済み（`eef9316`）。今回実装した範囲はc4aだけである。H5d4aの操作・結果JSON、Project 0.37.0、DB7、H1、SDK、Banto、依存版は変更しない。追加schemaは別resource／versionとしてローカル登録する。c4b着手前にはc4aに合わせたUI所有・操作復帰の詳細レビューを行う。

## 3. 全callerのownerとopaque参照

将来adapterは一つのnative RecordingOperationsOwnerを保持し、全clientがそのclient cloneへ到達する。ブラウザごとのwriterやSupervisorを作らない。native ownerの物理gateに加え、配送admission registryをその外側に置く。UI／socket／subscriptionの寿命とowner寿命を分離する。

wireでRust Arc／pointer／JoinHandleを表現しない。ownerRef、changeRef、operationRef、readRef、deadlineLeaseRefはhost registryのopaque H1 IDで、表示名やsessionIdから生成・復元しない。これらは認証tokenではない。context一致も認証の代用にしない。公開endpointやアクセス制御はP3b再開条件で別途確定する。

registryはownerRefの世代に属し、元context全文、元request全文、native opaque handleを対応付ける。contextはimmutable。元member配列順を保持し、object key順と整数同値表記だけを同値とするd4a helperを使う。native canonicalだけを根拠に別表示要求へ差し替えない。ownerRefが変わったら古いrefは利用不可で、native restart後の文字列一致を継続証拠にしない。

## 4. 非同期admissionの意味

```ts
interface AsyncRecordingOperationsPort {
  admit(request: AdmissionRequest): Promise<AdmissionReply>;
  inspectAdmission(
    request: AdmissionInspectionRequest,
  ): Promise<AdmissionInspectionReply>;
}
```

これは将来hostが実装するportの形であり、今回提供済みserviceではない。admitにAbortSignalを渡して既発行操作を撤回する意味を付けない。通信の取消・timeoutは呼出側の論理待機終了に過ぎず、元要求を保持したまま受付不明へ進む。

admissionIdはnative operationIdとは別の配送受付IDである。同ownerRef／同admissionId／同本文の再照会は既存受付を返すだけでnativeを再呼出ししない。同ID別本文はConflict。**再送による自動dispatchは採用しない**。admitの再送は登録済みならreply replay、未登録なら元のdispatch要求として処理し得るため、応答不明時のUIはadmitを再送せずinspectAdmissionだけを使う。

hostはnative呼出前に元要求と受付IDを登録する。登録後のnative同期拒否も登録済みreplyとして保持する。native受理前の確定拒否（hostの前検査、またはnative typed OperationRejection）だけrejectedを返す。adapter registry登録済みとnative handle受理済みは別の状態であり、登録後のtyped OperationRejectionも安全なrejectedとして記録できる。native呼出panic／応答喪失で受理有無を確定できなければunknownとする。Promise reject、接続喪失、不正payload、timeoutをRecordingOperationRejectedへ変換しない。

| reply            | 証明する内容                                      | clientの扱い                                            |
| ---------------- | ------------------------------------------------- | ------------------------------------------------------- |
| accepted         | nativeがhandleを返した／readを受理した            | opaque refを保存。commitやRunningとは表示しない         |
| completedDiscard | native同期discardが実際に成功                     | 候補を消せる。投稿成功だけでは返さない                  |
| rejected         | このadmissionでnative操作を受理していない確定拒否 | 元candidate／pausedを維持。errorだけで別ownerへ移らない |
| unknown          | native受理の有無を確定できない                    | 元要求保持、追加mutation／discardをblock                |

accepted前後のstage task終了結果はd4a OperationResultで別に通知する。native owner受付後のfailed/notDispatchedはaccepted operationのcompletionであり、配送rejectedに格下げしない。preflight Replay/errorでpauseを自動実行しない。pause、applyは各明示操作として別admissionを発行する。

## 5. c4a JSON shape

全objectは記載field必須、nullable省略不可、未知field拒否。IDは既存H1定義、U1は1..MAX_SAFE。d4a/d3のexternal resourceは両validatorへローカル登録しnetwork参照を拒否する。

```ts
type AdmissionRequest = {
  version: 1;
  kind: "recordingAdmissionRequest";
  ownerRef: Id;
  admissionId: Id;
  context: RecordingOperationsContext;
  deadlineLeaseRef: Id;
  action:
    | { kind: "preflight"; change: RecordingChangeRequest }
    | {
        kind: "pauseJoin" | "apply";
        changeRef: Id;
        operation: RecordingOperationRequest;
      }
    | {
        kind: "reconcile";
        changeRef: Id;
        operationRef: Id;
        reconciliation: RecordingReconciliationRequest;
      }
    | { kind: "discard"; changeRef: Id; change: RecordingChangeRequest };
};
type AcceptedRef =
  | {
      kind: "operation";
      changeRef: Id;
      operationRef: Id;
      request: RecordingOperationRequest;
    }
  | {
      kind: "reconciliation";
      readRef: Id;
      request: RecordingReconciliationRequest;
    };
type AdmissionReply = {
  version: 1;
  kind: "recordingAdmissionReply";
  request: AdmissionRequest;
  outcome:
    | { kind: "accepted"; handle: AcceptedRef }
    | { kind: "completedDiscard" }
    | { kind: "rejected"; error: OperationError }
    | { kind: "unknown"; error: OperationError };
};
type AdmissionInspectionRequest = {
  version: 1;
  kind: "recordingAdmissionInspectionRequest";
  inspectionId: Id;
  original: AdmissionRequest;
};
type AdmissionInspectionReply = {
  version: 1;
  kind: "recordingAdmissionInspectionReply";
  request: AdmissionInspectionRequest;
  outcome:
    | { kind: "found"; reply: AdmissionReply }
    | { kind: "notFound" }
    | { kind: "unavailable"; error: OperationError };
};
```

preflight acceptedのOperationRequestはstage=preflight、change全文一致。nativeが発行したoperationIdを返し、clientが予測しない。pauseJoin／apply acceptedは元OperationRequest全文一致・stage一致、changeRef一致。reconcile acceptedは元ReconciliationRequest全文一致。discardにaccepted handle、他stageにcompletedDiscardを返すことは禁止する。全actionのcontextはroot contextと同値である。found.reply.requestはinspection.original全文と同値である。

read物理確認不能を表す別rootもc4aへ含める。

```ts
type ReconciliationDelivery = {
  version: 1;
  kind: "recordingReconciliationDelivery";
  ownerRef: Id;
  readRef: Id;
  request: RecordingReconciliationRequest;
  outcome:
    | { kind: "result"; result: RecordingReconciliationResult }
    | { kind: "readUncertain"; error: "internal" | "workerFailure" };
};
```

result.requestは元requestと同値。readUncertainはc3 OwnerError::Internal／Unavailableの有限投影で、元apply quiescenceを変更するDTOを捏造しない。read枠保持・追加read／handoff不可というowner状態を示す。transport切断自体はreadUncertainのnative証拠ではないため、このrootを生成せず配送不明として扱う。

予算は各root **512KiB、depth48、node16384**、内部のd4a／H5a payloadにはそれぞれ既存独立上限も適用する。AdmissionRequestの受理条件には、**最大reply構築helperの成功を必須**とする。要求単体が上限内でも、InspectionReplyによる元要求の反復でnode／byte上限を超えれば受付前に拒否する。実行後のreceipt等を含まない本受付契約の全reply branchについて最悪の骨格を構築し、AdmissionReply、InspectionRequest、InspectionReplyを同じ予算で検査する。helperは内部shape検証とclosure検査を分け、AdmissionRequest公開validatorを再帰呼出ししない。

native生成preflight operationId、changeRef／operationRef／readRef、inspectionIdは全て最大64 ASCII文字の仮置き値を使う。既存enum errorは最長の許容値、各branchはそれぞれ独立に最大形で検査する。元request／contextの重複は省略せず実際の配列・objectとしてnodeも重複計数する。将来未知metadataを追加するときは厳密な上限とこのclosure計算を更新する契約版変更が必要で、無制限な余白fieldは認めない。resultの実値に短いIDが使われても、受理時に確保した最大予算を緩めて追加payloadを入れない。

byte計数はRust／JS共通の**保守的JSON見積**とし、構造記号・comma・colon・quoteを数え、文字列はUnicode scalarのUTF-8 bytesを基準にquote／backslashを2bytes、U+0000〜001Fを全て6bytesとして数える。全JSON numberは値にかかわらず24 ASCII bytesを予約する。したがって1／1.0／指数表記や負のゼロの再serialize差で受理境界が変わらない。boolean／nullはJSON literal長、object key順は計数へ影響しない。checked加算と既存scalar検査を用い、停止上限を超えてwalkしない。これは実compact JSON bytesそのものではない。nested d4a／H5aの既存計数は変更せず、外側の保守予算を追加で満たすものだけ受理する。外部wire受信byte上限は将来transportで別に設け、raw wireの空白や数値表記の長さをこの構造入力予算で制限できるとは主張しない。

## 6. 期限の権威

JS performance.nowとRust Instantは別clockであり、数値castや壁時計offset推定を採用しない。将来hostは明示stageごとにnative deadline leaseを発行する。leaseはownerRef、固定native Instant期限、上限10秒以内のbudget、未消費状態を保持し、要求のdeadlineLeaseRefを参照して一度だけQueryControlへ渡す。dispatch／blocking待機時も同期限を使い、受信時に丸ごとtimeoutを開始し直さない。

lease発行後の応答配送、JS待機、要求配送、host queue遅延は既に進行しているnative期限へ含まれる。期限切れなら同期native呼出前に拒否する。JSの表示用残余時間は目安であり削除操作の権威ではない。較正不能でもlease方式なら異clockの時刻を変換しない。

このlease方式は旧OperationControl.deadlineMonotonicMsの同値実装ではなく、独立versionのasync admission契約である。既存同期serviceへfake synchronous ACKを返すadapterを作らない。

leaseはownerRef／context／owner epochと一回のadmissionIdへ束縛し、他stageや別admissionへ流用しない。発行時にnative期限が固定され、未使用→使用済みまたは失効の一方向とする。発行ackが届いた時点で元UI意図の論理期限／close／Project・service所有資格が失われていればadmitを送らず、未使用leaseの失効を待つ。これは既に受理されたmutationの取消とは別である。JS表示timeoutだけでnative期限到来・物理停止・取消成立を主張しない。

lease取得要求そのものの通信は別の有限readであり、lease発行前の通信時間までoperation budgetへ計上済みとは主張しない。lease発行API／pool／host runtimeはc4cの詳細設計事項で、c4aではopaque refの構造だけを定める。発行・登録は有限capとし、上限時は発行前拒否、失効済みIDを同owner世代で再使用しない。具体capとpool満杯時の回復はhost選定時に確定してから実装する。待機中の再取得で古いadmission期限を延長しない。新しい明示stageだけ新leaseを使える。lease期限切れでも登録済みadmissionの照会は可能である。

## 7. 受付不明とowner再同期

admissionの物理枠は全caller共有で最大一つ、queueなし。native受付応答が失われた場合、native gateが操作を保護する一方、adapter registryも同じadmissionを保持する。別UIから新要求を発行して穴埋めしない。

inspectAdmissionは元要求全文に照合するreadで、結果不明時の唯一の受付確認経路とする。notFoundだけでは元送信が将来到達しないと証明できないため、clientは送信gateを解除しない。再dispatch資格を与えるには配送終了／元受付の終端が必要であり、その証明を持たない一般IPCではunknownのまま止める。owner process喪失ではregistry復元を約束せず、native DB receiptと配送admissionの再構成を同一視しない。

c4aのnotFoundには未来受付不能の証明を含めない。安全に送信gateを解除する将来拡張は、同admissionIdをterminalへsealして後着要求を同native共通gateで原子的に拒否するfence、またはhostがlease失効と一回束縛を検証して未来受付不能を証明する専用replyを必要とする。JS時計の経過だけでこの証明を作らない。本versionにそのreplyは含めず、unknown／retiredもnotDispatchedへ変換しない。有限registryが満杯／証拠retiredとなった場合は操作を停止し、古い全payloadを無限保持して継続する方法を採用しない。

subscribe／reconnectの実protocolはc4cで定めるが、次の要件は固定する。

- ownerRef＋単調frame revisionを持つ完全state snapshotを再取得し、古い通知を現ownerへ適用しない。frame revisionのsafe整数枯渇は新世代へ明示停止し、wrapしない。
- 同ownerのopaque refはremount後もregistryから再提供する。JS wrapperはrefごとに一意化し、単なるJSON文字列一致でnative handleを再構成しない。
- 通知切断／subscribe解除は操作取消ではない。既知receiptと元requestは保持し、最新表示を接続正常と偽称しない。
- snapshot取得とイベント購読の隙間で結果を落とさないhandshakeをhost決定後に実装する。未実装段階でイベントのlossless保証を主張しない。
- c3 readのDTO結果とreadUncertainを別状態で保持する。完了Promiseのrejectを未実行や正常read終了へ変換しない。

## 8. 有限registry、取消、破棄

adapterのmutation admission IDはowner内4096件、既登録IDは再使用不可。新workflowでpreflight／pause／applyの三admission分を予約し、unused creditだけ終端／明示discardで解放する。discardの一枠を別途同workflowに予約し、容量上限で候補を破棄できない状態を避ける。reconcile admissionと受付照会はmutationとは別の有限枠とし、具体pool上限／回復時の枯渇終端はc4c着手前に確定する。native c2/c3の4096枠とは別に上限を持ち、両方を通過できる範囲だけ受理する。

c4aはregistryや予約処理を実装していない。c4b mockは最大一workflow／一admission／一inspectionを保持し、非協力Promiseでも物理完了を偽って次を送らない。close／Project／service交換は送信資格を退役し、旧ownerの進行・receipt監視を保持する。new serviceのcontextを旧operationへ付け替えない。

requestCancelも一般IPCでは同期CancelDispositionを確定できないため、c4b以降は非同期ackを別に設計する。取消要求送信は操作未実行／rollbackの証明ではない。pause stopを撤回しない。discardはcompletedDiscardの実完了ackまで候補を保持する。native read・writerが未joinならUI timeout／dispose／socket closeで枠を解放しない。

## 9. c4aの実装と受入

c4aの実装rootはAdmissionRequest、AdmissionReply、AdmissionInspectionRequest、AdmissionInspectionReply、ReconciliationDeliveryの五つに限定する。lease発行request/ack、state再同期frame、cancel ack、実registryはこのschemaへ憶測で追加しない。

c4aはscada-modelの独立schema／owned Rust validator、TS owned parser／意味検査、examples共通fixtureと通常browser module評価を実装する。UI/service/native ownerへの呼出を追加せず、既存同期serviceと既存d4a rootの互換性を維持する。

受入は全action／reply組合せ、context/request全文一致、member順保持と数値整数同値、generated preflight operationId、単一reply内のref／元要求照合と既知二documentの全文相互検証、discard早期accepted禁止、readUncertainと元apply結果の分離、秘密field／未知field／nullable、Unicode scalar、予算境界と最大reply構築可能性、外部schema fetch無しを含む。pure validatorは実際の未dispatch・opaque所有・deadline lease・registryを証明しないと明記する。同refを過去と異なる元要求へ登録するstateful拒否は将来adapter registryの責務であり、単一documentのshape検査や既知二documentの比較だけで全履歴の一意性を保証しない。

c4bは制御Promiseで受付応答喪失、rejectとtyped rejectedの区別、候補停止の三明示段階、discard遅延ack、受付不明→notFoundでもblock、readUncertain、subscribe切断、Project/service交換を受け入れる。c4cはhost選定とP3b再開条件が満たされるまで着手しない。native libraryとローカルmockの成功を、製品接続・認証・実S7での成功と呼ばない。

## 10. c4aの実装入口と検証範囲

`scada-model/schema/recording-admission.schema.json`は独立v1 resourceで、`recording_admission.rs`は五つのowned wrapper／validatorと既知document間の照合を提供する。`semantic.rs`がstage／ref／全文echoと全nested d4aの独立検証、`capacity.rs`が各要求に必須の最大返信九分岐の検査を担当する。preflightで生成するoperation requestも既存d4a予算を満たすことを確認する。公開validatorを再帰呼出ししてclosureを構築しない。

TSの`recording-admission-contract.ts`と`recording-admission/{types,semantic,capacity}.ts`は同じ責務を持つ。`history/owned-json.ts`のadmission opt-inとnative `json_contract.rs`のadmission profileで保守計数を共有し、既存compact profileの上限・意味は維持する。TSの`json-equality.ts`はbounded owned JSONの比較を既存d4aと共有し、key順／整数表記差を無視して配列順を保持する。

`examples/recording-admission-cases.json`の受理924・全文一致15・既知document照合6・会計境界12・返信容量5のvectorをRust／TSとChromiumで共有する。既存H5a139・d3 target447・対象d4a353件を内包して独立検証する。schemaは全てローカル登録し、外部取得を行わない。通常AppのProject保存も不変である。

現行schemaでは8member、文字列scalar長、H1 IDなどの上限により、有効な要求は外側512KiB／16384nodeより十分小さい。外側予算自体の厳密な境界は構造JSONの共有vectorで検証し、最大reply検査は同じwalkerへ試験用の小予算を与え、要求単体と前段replyは通るが最大found InspectionReplyが超過することを確認する。本番上限を変更したり、schema-validな巨大要求を存在するように扱ったりしない。全九分岐の固定byte／node期待値を両言語で一致させる。

pure検証は未dispatch、owner所有、lease失効、registryの一意性や再送資格の証明ではない。c4bの非同期monitor／UIは次の設計・実装境界で、実接続とP3bの保留は維持する。

Rust workspace626件（新規8）、TS全6,737件（新規1,903）、関連Chromium6件（新規3）、型検査0error／0warning・build、Clippy全target `-D warnings`／rustfmtが成功した。Astra最終read-onlyレビューに残る必須指摘はない。

## 11. c4bの詳細設計と次の実装

c4a実装はPR #67でworkへ統合済み（`1370d4c`）。[c4bの非同期monitor／UI設計](historian-recording-async-monitor.md)は、外部root-owned coordinator、同期serviceとの排他的選択、受付状態・native結果・read静止・呼出終了の独立管理と、旧対象の保持／復帰条件を具体化する。

次の実装はtest-onlyの非JSON portを使うlocal client／monitor／UIの受入である。c4aの五rootをlease発行・cancel ack・snapshot frameへ拡張したことや、native adapter／製品hostを接続したことを意味しない。実wireとP3bの再開条件は引き続き別工程で確定する。
