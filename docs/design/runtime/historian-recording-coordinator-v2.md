# 記録wire coordinator-v2の所有・attempt境界

状態: **C4の採用詳細設計、実装は次の区切り**。2026-11-06（日本時間）。Historianの主設計・レビューはユーザー指定のAstra。[wire host契約](historian-recording-wire-host.md)、[元call・Observation台帳](historian-recording-wire-delivery-ledger.md)、[local-v2配送](historian-recording-wire-local-v2.md)、[実Hub・S7接続計画](../../project/real-hub-connection-plan.md)を前提にする。

## 1. 対象と順序

次の実装は**同realm・test-onlyのcoordinator-v2 root**を新モジュールに追加する。既存`recording-async` v1 coordinator／port／UIを型cast・透過接続せず、通常Appの第三注入propも増やさない。最初の区切りは明示登録、状態照会、元返信回収、個別transport attemptの終了、view退役を扱う。自動lease→admit scheduler、再送、製品権限、実network、Tauri command、実SQLite記録は後続とする。

製品native bridgeを後に置く理由は具体的である。`recording-wire-local-v2.ts`のPromiseは保存済み正常replyの配送を示すだけで、送信やtransport attemptを所有しない。既存`recording-async/coordinator.ts`の`settled`は旧portのcompletion前提であり、Observationの`pending`とquery terminal、元call返信と物理呼出し終了を一軸にできない。`recording_registry_model.rs`は`ModelInstant`／`SimulatedPrincipal`／`SimulatedCompletion`を使う**simulation**で実lease・認可・native completionの権威ではない。Tauriの`main.rs`は読取専用で、`stop_read()`はpumpをabortする。記録ownerを同じ`Active`へ入れると接続・view切替で実行中の記録操作を切断し得る。`scada-host`の保護されたread keyをmutation principalへ昇格させない。

## 2. 四つの独立した事実

| 事実                      | 保持元・完了根拠                                                                                  | 完了しても証明しないこと                         |
| ------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 元dispatcher reply回収    | local-v2の**対応する元call token**に保存されたterminal全文                                        | transport task終了、native worker静止、業務成功  |
| 個別transport attempt終了 | 当該attemptを所有するtest portからの終了通知。実製品ではhostが保持するcall taskの終端             | 元reply到着、dispatcher未実行、native worker静止 |
| operation／read結果の知識 | 対応するObservation **query terminal**のpayloadとAccepted由来target。attemptの`pending`は含めない | 元call・transportの終了、次mutation許可          |
| native静止／回復要求      | native ownerが確定したquiescence／recoveryの証拠。wire表示はその投影                              | 既存principalの認可、全transportの終了           |

元Admissionの`unknown`は元terminalとして不変。後の**AdmissionInspection**の`found.accepted`は別の受付知識として保持し、元replyを書き換えない。**CallInspection**は元dispatcherの不変terminalを回収する経路である。元terminalが既に`unknown`ならCallInspectionから`accepted`へ書き換えない。元terminalを回収しても、元transport attemptやInspection attemptの未終了を消さない。transport Promiseがrejectしても「未送信」「native未実行」「元replyなし」を確定しない。正常replyが届いてもそのattemptがまだ走っていれば枠を保持する。

Observation attemptの正常`pending`は当該attemptのreply配送だけを終える。queryはpending、同attemptを上書きしない。前attemptの返信喪失時に自動repeatや論理timeout解放をしない。queryの`unavailable`はそのID固有のterminalで、operation失敗にもreadUncertainにも置換しない。ReconciliationDeliveryの`readUncertain`、operationの業務失敗、`receiptFound`、元applyのquiescenceは別欄で保持する。frame先着や同target別queryの結果で、当該元call・attempt・queryの正常返信を捏造しない。

## 3. root、入力、有限容量

factoryは同じ固定`RecordingWireScope`の実ledger・receiver・それらに結び付いた実local-v2とtest-only portを受け取る。local-v2 factoryにはprivate WeakMapのsource対brandを追加し、同scopeの別ledger／receiverやwrapper・Proxyを拒否する。test-only portもfactory brandと固定scopeを持ち、別scopeや構造だけ似たportを拒否する。coordinatorはledger・receiver・port**それぞれのidentity**を一回だけclaimし、いずれか既claimなら拒否する。検証が全て通った成功時にのみ三者を原子的にclaimし、失敗したfactory呼出しでsourceを汚染しない。`close()`後もtombstoneを残し、local-v2だけを作り直してunknown・未回収枠や容量を消さない。scope全文のownerRef・ownerEpoch・contextを比較し、同ownerRefの別epochを統合しない。

初回の公開契約は、各routeのopaque tokenを`track`し、local-v2が返すowned/frozen requestと単一Promiseを保存する。経路は元Lease／Admission／AdmissionInspection／Cancel、CallInspection attempt、Observation attempt、Observation query、Attach、Control。Observation queryには直接transport attemptを付けず、個々のObservation attemptに付ける。同token・同routeの再登録は同じtrackを返し、異route・別root tokenは拒否する。トラッキングは送信権限ではない。

初回実装では**既存台帳が発行済みのtoken**を受ける。公開methodは`track(route, sourceToken)`、`reserveAttempt(track, testPortTicket)`、`markStarted(attempt)`、`bindView(identity)`、`pump()`、`current()`、`close()`とする。`bindView`の返すleaseには`retire()`だけを持たせ、画面の資格や送信許可は作らない。`track`はtoken帰属を確認し、coordinator容量を確認し、local-v2のwatch成功後に外部処理を挟まずtrackをcommitする。台帳の`begin`はこの初回rootの責務外で、台帳登録のrollbackや事前予約APIを仮定しない。Observation queryは`track`だけで、attempt ticketを付けられない。

test-only portは**dispatchより前に**opaque ticketと、そのcall task自身の単一終了Promiseを作る。ticketはfactoryのprivate brandを持ち、coordinatorへはそのportが発行したticketだけを渡す。port自身は`issued|ended`のticket lifecycleを同期的に保持し、port側の終了操作はPromiseをresolve／rejectする**前に同期的に**`ended`へ進める。`reserveAttempt`はticketのscope・route・owned request全文と未使用identityを照合し、trackへ一回束縛してから終了Promiseを監視する。送信routeの**一つのtrackにattemptは最大一つ**とし、同ticket exact再取得は同attempt、別ticketは拒否する。CallInspection／Observationの明示repeatは新source attempt tokenによる別trackで表す。`markStarted`はportの同期的なlifecycleが`issued`であることを確認してからattemptをinFlightへcommitし、外部dispatchを呼ばない。試験hostはそのmethodの**返却直後、同じJS turnでawaitを挟まず**dispatchを行う。初回coordinatorにdispatch callback／任意の`markReturned()`を設けない。ticketの別本文・二度目の開始を拒否する。予約だけでは送信しない。dispatchが同期throwしても、開始後なら未送信を推論せずinFlightとして保つ。後着の当該終了Promiseだけでreturned／rejectedへ進められる。終了通知自体を得られないthrowは無期限inFlightとして再送・枠解放をしない。`returned`／`rejected`はtransport call taskの終端であり、native workerの静止ではない。

coordinator自身は各trackとattemptを最大256件に縮小可能な上限で保持し、使用済み履歴を返却しない。coordinator容量不足ならwatch／attempt予約を実行しない。local-v2容量不足でもcoordinatorのtrackは無作用である。attempt容量不足でも登録済みtrackは保持し、開始しない。既存ledgerのmutation／read／Observation pool、receiverのsnapshot／call容量はそれぞれの既存factory・beginで検査する。coordinatorはその消費を巻き戻さず、元ledgerが元begin時に予約した初回回復read creditを貸し出さない。**製品**で台帳begin前の全pool事前確認と送信前の原子的予約を成立させるにはhost側の追加契約が必要で、このtest-only rootの受入とは分ける。長時間運用の容量更新・GCはC6で別途閉じる。

`current()`は直前にcommitした不変snapshotだけを返す。状態には固定scope、各routeの`reply: pending|delivered`、個別attemptの`reserved|inFlight|returned|rejected`、結果知識、receiver表示、coordinator自身のclosed、view retiredを**別欄**に置く。inFlightは返信の有無やdispatch同期throwに関係なく、当該終了Promiseが未完了という意味である。`ownerClosed`、`authorizationLost`、`resyncRequired`、`nativeRecoveryRequired`をORして単一closedにしない。`canApply`等の製品操作許可やprincipal有効判定はこの表示から公開しない。ユーザー向けエラーに生の例外・秘密値を入れない。

## 4. 順序、寿命、再入

`track`は既存tokenからlocal-v2のwatchを取得してからattemptを予約する。`markStarted`はportの**同期的なticket状態**を読み、dispatch前にcommitする。guard解除後の外部dispatchを試験hostが同じJS turnで行う。`pump()`が保存済み正常replyを回収し、Promise callbackはmicrotaskとして後で状態をcommitする。local-v2の`pump()`成功／pending件数0、receiverのframe、台帳の`terminalStored` flagだけでtrackをdeliveredへ進めない。対応handleのcompletion全文を照合してから更新する。別attemptの終了通知を受けても当該attemptだけを更新する。終了Promiseが`markStarted`より先にsettleした場合は、coordinatorのmicrotaskがまだ走っていなくてもportの同期的な`ended`で検出し、**markStartedを拒否してdispatchを許さない**。既に終了したticketを新しい送信の終了証拠に使わない。

初回版の`bindView(identity).retire()`はview寿命を**表示へ記録するだけ**で、track／attemptの登録gateや送信資格に使わない。このrootに意図・dispatch APIはない。coordinatorの`close()`は新track／attempt登録を止めるが、登録済み元call・attempt・Observation queryの監視と正常後着replyは残す。旧epoch rootは旧tokenからの後着を保持し、新epoch rootへ移さない。製品段階ではview unmount／Project切替による新規意図停止を別gateとして設ける。native owner自体のshutdownは別の明示境界で、UI退役をnative cancelやdropにしない。

全mutationは再入guardを取得してから未知入力のgetter／prototype／descriptorを読む。通知中のretire、throw、同token登録、先着Promise、古い`current()`のidentityを試験する。外部callbackを同期mutation中に呼ばず、失敗時はguardをfinallyで戻す。Promise rejectionを正常返信に変換せず、不確定な証拠を保持する。返却metadataはfreezeし、owned本文は元ledger／receiverの参照を共有して第二の全文履歴を作らない。

## 5. 受入と次の製品gate

最初の実装はNodeとChromiumの実moduleで同じscenarioを動かし、通常AppのProject保存bytesとv1 coordinatorの挙動を変えない。受入は次の順序・境界を含む。

1. 元Admission`unknown`と後続AdmissionInspectionの`found.accepted`を別保存し、元attempt未終了も維持する。CallInspectionから元terminalだけ回収した場合も両attemptの状態を独立に保ち、元`unknown`を`accepted`へ変更しない。
2. transport resolve／rejectと元reply到着の全順序、先着frame、別query結果、重複・後着返信で誤配送・誤解放しない。
3. Observation pending→明示repeat→terminal、返信喪失でrepeat拒否、unavailable、readUncertain、operation失敗を区別する。
4. ownerClosed／authorizationLost／resyncRequired／nativeRecoveryRequired、coordinator closed、view retiredを分離し、旧epochのlate replyを新rootへ入れない。
5. coordinator／local-v2容量のexact／1不足、attempt容量不足時の既存track保持、既存ledgerの初回回復read予約の不変、ledger又はreceiverを再利用したroot再作成拒否、失敗factory後の再試行、再入・throw後復帰・commit済みcacheを検証する。
6. dispatch同期throw後のlate終了通知、開始前に終了したticketの送信拒否、同trackへの別ticket・重複開始、foreign ticketを検証する。いずれもcoordinator自身から外部dispatchを呼ばない。

この段階のtest portによるattempt通知は試験入力であり、製品の物理終了保証ではない。次にGUI非依存のnative registry adapterを実`RecordingOperationsOwner`の外部所有rootへ接続し、registry ticketとnative handleを一対一に束縛する。native `Instant`のlease期限、trusted principal、server決定のscope／epoch、role照合、認可失効後の監視、process shutdownとview closeの違いを閉じる。protected **read key**を記録変更のprincipalに流用しない。mock Hub／一時SQLiteで返信喪失、切断、late reply、世代交代、複数caller、容量不足を受け入れた後にTauri transportへ接続する。
