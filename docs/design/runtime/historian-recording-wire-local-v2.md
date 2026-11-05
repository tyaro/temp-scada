# 記録wireのlocal-v2配送境界

状態: **C4 local-v2／Promise配送の採用詳細設計**。2026-11-06（日本時間）。Historian設計・レビューはユーザー指定のAstra。[元call台帳](historian-recording-wire-delivery-ledger.md)、[Observation台帳](historian-recording-wire-observation-ledger.md)、[receiver表示・元terminal](historian-recording-wire-client-boundary.md)を前提にする。

## 1. この区切り

同realmの別契約`RecordingWireLocalV2`と、保存済みtokenから正常replyを一度だけPromiseへ配送するpure adapterを追加する。受信・送信・timer・再試行・native・認証・通常App注入・既存`recording-async` coordinator変更は含めない。既存`AsyncRecordingOperationsPort`はtest-only v1として維持し、wireの表示を`LocalOwnerFrame`へcastしない。

現在のcoordinatorは`observeOperation(ref).completion`を結果のPromiseとして扱う。wire Observationには`pending`、query終端の`unavailable`、個々の未回収attemptがあるため、このcoordinatorへ透過接続しない。後続のcoordinator-v2で元reply・結果知識・物理call枠を別軸へ対応させる。

## 2. local-v2の型と所有

```ts
type LocalV2Reason =
  | "busy"
  | "foreignToken"
  | "capacity"
  | "invalidSource"
  | "scopeMismatch"
  | "sourceFailure";
type LocalV2Result<T> = Readonly<
  { ok: true; value: T } | { ok: false; reason: LocalV2Reason }
>;
interface LocalV2Handle<Q, R> {
  readonly scope: RecordingWireScope;
  readonly request: Q;
  readonly completion: Promise<R>;
}
interface RecordingWireLocalV2 {
  readonly version: 2;
  readonly mode: "testOnly";
  readonly scope: RecordingWireScope;
  watchOriginal(
    token: OriginalCallToken,
  ): LocalV2Result<LocalV2Handle<OriginalRequest, OriginalReply>>;
  watchInspectionAttempt(
    token: InspectionAttemptToken,
  ): LocalV2Result<
    LocalV2Handle<
      RecordingWireCallInspectionRequest,
      RecordingWireCallInspectionReply
    >
  >;
  watchObservationAttempt(
    token: ObservationAttemptToken,
  ): LocalV2Result<
    LocalV2Handle<
      RecordingWireObservationRequest,
      RecordingWireObservationReply
    >
  >;
  watchObservationQuery(
    token: ObservationQueryToken,
  ): LocalV2Result<
    LocalV2Handle<
      RecordingWireObservationRequest,
      RecordingWireObservationReply
    >
  >;
  watchAttach(
    token: AttachGeneration,
  ): LocalV2Result<
    LocalV2Handle<RecordingWireAttachRequest, RecordingWireAttachReply>
  >;
  watchControl(
    token: ControlCall,
  ): LocalV2Result<
    LocalV2Handle<RecordingWireControlRequest, RecordingWireControlReply>
  >;
  pump(): LocalV2Result<
    Readonly<{ delivered: number; pending: number; sourceFailures: number }>
  >;
  current(): LocalV2State;
}
```

factoryは同一scopeの実receiverと元call台帳を受け取り、両factoryのprivate WeakSetでinstanceを検証してwrapper／Proxy／構造的な偽物を拒否する。`scope`全文（ownerRef・ownerEpoch・context）を不変に固定する。旧c4a Admission本文へepochを追加しない。scope文字列は認証・操作資格の証拠ではない。`mode: "testOnly"`は製品transportが未接続であることを示す。通常Appの第三propを追加しない。

`current()`はcommit済みcacheとして固定scope、receiverの`RecordingWireDisplay`、登録済み／未配送／配送済みhandle数を返す。displayの`ownerClosed`、`authorizationLost`、`receiverStatus`、`nativeRecoveryRequired`は別欄のまま保持する。coordinator自身の`closed`へ合成しない。`pump()`だけがreceiver表示を取り直す。表示やtarget結果からreplyを捏造しない。

登録時は対応する元getterでtoken帰属を検査し、同token・同経路の再登録は同handle／Promiseを返す。異経路・別instance・文字ID・clone tokenは`foreignToken`。各handleの`request`は元getterのowned/frozen本文を参照し、`completion`は一つだけ作る。factory optionsは`maxHandles`既定256を0..256へ縮小できる。登録履歴は返却せず、満杯時は`capacity`で有限停止する。既知exact再取得は無課金。上限はadapter一instanceの値で、同じsourceから複数adapterを作った場合の総量やGCは保証しない。

## 3. 正常配送の規則

| 経路                                            | 唯一の正常配送元                                              | Promiseの値                                                |
| ----------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------- |
| 元Lease／Admission／AdmissionInspection／Cancel | `ledger.original(token).terminal`                             | 保存済み元Reply全文                                        |
| CallInspection attempt                          | `ledger.attempt(token).reply`                                 | 当該attemptのReply全文。`pending`等もそのまま              |
| Observation attempt                             | `ledger.observationAttempt(token).reply`                      | 当該attemptのReply全文。`pending`も正常attempt終端         |
| Observation query                               | `ledger.observation(token).terminal`                          | 当該queryの初回terminal Reply全文。`unavailable`もそのまま |
| Attach／Control                                 | `receiver.attachTerminal`／`controlTerminal`の`kind:terminal` | 保存済み元Reply全文                                        |

登録時に既に正常replyがあれば同じowned/frozen参照で配送する。後着replyはcallerが明示`pump()`を呼んだ時に取得し、一度だけresolveする。`pump()`はraw JSONを入力せず、send／subscribe／retryを呼ばない。settle後の重複pumpは無作用。Promiseをrejectして、配送不明をnative失敗・物理静止に変換しない。保存済み本文以外の第二reply履歴を作らない。

元Admissionの`unknown`はその元Promiseの不変値であり、後のInspectionの`found.accepted`は別handleの値になる。CallInspectionが元terminalを回収した場合は元call Promiseを配送できるが、Inspection attempt自身や実transportの未回収枠を完了させない。frame先着、同target別queryの結果、`terminalStored`flag、pending件数0は配送根拠にしない。

Observation attemptの正常`pending`はattempt Promiseだけをresolveし、query Promiseは残す。明示repeatで新attemptを作り、その正常terminalでqueryが進む。返信喪失したattemptはledgerの未回収枠を保持し、自動repeat・自動timeout解放をしない。`unavailable`は当該queryのterminalで、operation失敗やnative readUncertainへ写さない。`readUncertain`を含むReconciliationDeliveryは正常reply payloadとしてそのまま配送する。

## 4. 寿命、再入、製品接続gate

receiver／ledgerのretire・dispose・sticky停止後も保存済みterminalと後着正常replyは配送できる。切断、view unmount、論理期限はadapterのPromiseを正常完了・rejectさせない。旧epochのadapterは旧scopeだけを保持し、新epochの表示へ混入させない。再接続時に古いtokenから新tokenを復元しない。

全watchと`pump()`は共通busy guardを最初に取り、nested呼出しは`busy`で無作用。`current()`だけは直前のcommit済みcacheを返す。元getterのthrow／異常結果でもguardをfinallyで戻し、Promiseはpendingのままにする。返却metadataとhandleはfreezeする。Promiseのsettle callbackはmicrotaskであり、同一call中に外部callbackを同期実行しない。

このPromiseがresolveするのは**保存済みの正常replyを配送した事実だけ**である。native operation終了、transport送信Promiseの物理終了、認証、次mutation資格を証明しない。製品adapterでは別の物理attempt所有、principal／epoch binding、host側Instantによるlease、認可・切断・容量gateが必要。JSの`performance.now()`値をnative期限へcastしない。実native／UI接続は次工程にする。

## 5. 受入

- 六経路の正常replyだけが一度配送され、元Unknown、Inspection found、Observation pending／unavailable／readUncertainをそれぞれ区別する。
- 同tokenの同identity、foreign／wrong-kind拒否、scope／epoch分離、既知exactの無課金、最大256／1不足容量を検証する。
- frame・別query結果・未回収件数ではresolveしない。返信喪失、retire／dispose後の正常後着、二段階保存の矛盾時にも保存済み本文だけを配送する。
- 再入とthrow後復帰、deep freeze、getter参照共有、重複pumpの一回settle、`current()`旧cacheを確認する。
- NodeとChromiumの実moduleで共通scenarioを実行し、Project保存と既存local-v1経路を変えない。

この区切りの完了はlocal-v2の同realm配送までであり、C4全体、製品host／native接続、実SQLite記録を完了扱いしない。
