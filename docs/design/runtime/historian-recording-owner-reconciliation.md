# 記録操作owner内の明示receipt照会

状態: **H5d4c3の採用詳細設計・未実装**。2026-11-04（日本時間）。主設計はユーザー指定のAstra。 [c1 receipt reader](historian-recording-receipt-reader.md)、[c2共有owner](historian-recording-native-owner.md)、[d4操作DTOとservice](historian-recording-operations.md)を接続する次の一実装PRの契約である。c2はPR #63でマージ済み。本書はコード・schema・製品接続を追加しない。

## 1. 範囲と根拠

元applyの結果が不明、またはcommitが確認できても回復要求が残るとき、同ownerが保持する元要求について利用者が一回ずつreceiptを照会する。現在値の取得、apply再実行、元workerの再開、latch解除、pollingを行わない。Project 0.37.0、DB7、H1、固定SDK／Banto／依存を維持し、実Hub／S7／本番DB／認証／製品transportへ接続しない。JS bridgeは後続であり、Rust API追加だけで通常Appがnativeへ接続されたとはしない。

実装根拠は次の既存コードである。

- [receipt.rs](../../../crates/scada-historian/src/store/recording_plan/receipt.rs): 元ApplyRecordingPlanRequest全文に照合するHistoryReaderの同snapshot読取。保存証拠を検証してからcanonical一致を判定する。
- [operations](../../../crates/scada-runtime/src/recording_host/supervisor/operations/mod.rs): c2の共有Core、opaque handle、mutation registry、Supervisor返却とsticky recovery。
- [driver.rs](../../../crates/scada-runtime/src/recording_host/supervisor/operations/driver.rs): native worker正常joinとoutcome Errの区別、Supervisorを失うdispatcher panic、immutable completion。
- [preflight.rs](../../../crates/scada-runtime/src/recording_host/supervisor/preflight.rs): Supervisorの既存read leaseとreaderのunusable／faulted状態。
- [view.ts](../../../apps/banto-scada/src/lib/recording-operations/view.ts): failed/unconfirmedとappliedの単調統合。notDispatched／notCommittedをreceipt発見だけでappliedへ変更しない。

c1はDB上のcommit証拠だけを返す。c2は元applyの物理完了と回復gateを保持する。この二つを合成し、どちらかの証拠で他方を推測しない。

## 2. Rust公開API

既存 `scada_runtime::recording_operations` へ次を追加する。名前は実装時の整合調整を許すが、資格・所有・結果意味は変えない。

```rust
impl RecordingOperationsClient {
    pub fn reconcile(
        &self,
        change: &RecordingChangeHandle,
        original: &RecordingOperationHandle,
        reconciliation_id: &str,
        control: QueryControl,
    ) -> Result<RecordingReconciliationHandle, OperationRejection>;
}

pub type RecordingReconciliationCompletion =
    Result<Arc<RecordingReconciliationResult>, OwnerError>;

#[derive(Clone)]
pub struct RecordingReconciliationHandle; // private Arc identity
impl RecordingReconciliationHandle {
    pub fn request(&self) -> &RecordingReconciliationRequest;
    pub fn watch(&self)
        -> watch::Receiver<Option<RecordingReconciliationCompletion>>;
    pub async fn wait(&self)
        -> Result<Arc<RecordingReconciliationResult>, OwnerError>;
    pub fn request_cancel(&self) -> CancelDisposition;
}

pub enum ReconciliationPhase {
    Idle,
    InFlight,
    Completed,
    Uncertain,
}
```

Request／Resultはd4aの既存検証済みowned wrapperを使う。新JSON rootや任意error文字列を追加しない。非JSON RecordingOperationsStateに `reconciliation_phase`、現在／最後に受理したhandleの `reconciling`、最新有効結果の `last_reconciliation` を追加する。reconcilingは完了後も最新handle一個を保持できるため、非nullだけでBusyと判定しない。物理状態はphaseで判定する。

このreadの物理確認不能（worker／dispatcher喪失、Runtime終了）は `wait()` のOwnerError::Unavailableで通知し、Core poisonはOwnerError::Internalで通知する。内部completion channelは成功DTOまたは有限OwnerErrorの一回限りの結果を保持する。**DTOを返す正常completionはread自身のcleanup／join確認後だけ**とする。Runtime終了によるread確認不能を、通常のfailed DTO完了として物理枠を解放しない。watch／waitは上記専用Rust completion型を共用する。JS bridgeでのこの異常型の扱いは接続前に別途設計する。

元OperationHandleのcompletion API／値は一切変更しない。

## 3. 同期受理の資格

短い共通Core排他で次を全て満たした後にだけread IDとhandleを登録する。try_lock競合は同期Busy、queueは作らない。

1. ownerがopen、SupervisorがCoreへ返却済みである。mutation stage／readが貸出中ならBusy。既存readがUncertainなら追加読取もhandoffも拒否する。
2. changeは現在workflowのopaque identityと一致する。originalは同workflowのapply handleそのものとArc identityが一致し、stage=apply。別owner、古いworkflow、同じIDを持つ作り直したhandleは拒否する。
3. 元apply completionが確定している。元request/contextはregistryに保持したowned値を使い、呼出側に別のApplyRecordingPlanRequestを渡させない。
4. 元completionがfailed/effect=unconfirmed、または元completionがappliedでquiescence unknown／recoveryRequired=trueである。現在のowner recoveryも資格判定に含める。通常成功applied、preflight Replay、failed/notDispatched、failed/notCommitted、pause失敗は照会対象にしない。
5. Supervisorの既存readerが存在し、unusable／faultedでなく、preflight／resumeの物理loanがない。Hostのplan recoveryやFaultedだけを理由にこのreadを拒否しない。ただしwriterの回復資格は一切変更しない。
6. QueryControl元上限、deadline、取消、H1 ID、d4a Request構造／byte予算、read registry残量を検証する。期限はdispatch直前にも確認する。

資格4は元immutable completionを基準とし、後日latestがappliedへ更新されても元failed/unconfirmedを保持するhandleで再照会できる。新しいID・明示呼出が必要で、自動再試行はしない。元applyのnative同期拒否でnotDispatched/blockedとなったケースは、本APIで正常化せず別の手動回復境界に残す。

Supervisor消失は同期OperationRejectionの既存workerFailure、reader欠落／unusableはreaderUnusable、reader faultedはworkerFailureとして拒否し、receipt不在と表示しない。同期拒否にOwnerError::Unavailableを流用せず、schema／error版を変更しない。既存c2のShared::lockedはrecoveryを拒否するのでそのまま流用しない。read専用gateを新設し、mutation用gateの条件は弱めない。

## 4. 既存readerの貸出と一枠

受理前登録→Supervisor貸出→単一read dispatcher→既存readerをspawn_blockingへ貸出→borrowed join→reader／Supervisor返却→結果公開の順を守る。接続を新設せず、既存二reader lease上限と同storeの構造的帰属を維持する。任意HistoryReaderや別storeからのreceiptを引数で受けない。

Supervisor内にcrate限定のreceipt-read開始／join helperを設ける。既存preflight ownerのreaderをtakeし、元native ApplyRecordingPlanRequestと同じQueryControlをworkerへ渡す。readerは正常join時に返し、ReaderUnusableなら元ownerのunusableを記録する。preflight候補／bound／元turnは消さない。pending candidateやHost recoveryを許すのはこの限定readだけであり、通常start_preflight／resume／executeのgateには反映しない。Supervisor全体を貸出中なので同時に別の &mut Supervisor を作らない。

同ownerの全callerでmutationとreconciliationを合わせて物理loan最大一つ。read中のdiscard、handoff、別read、新mutationはBusy。readが終わっても元apply recovery gateは維持される。read own completionの前にreaderとSupervisorをCoreへ戻し、late subscriberにも結果を保持する。

workerが通常returnしてStoreErrorになった場合はread joinを確認できるためDTO failedを返せる。cleanup失敗でreader connectionが破棄されている場合もjoin済みという事実は保持し、その後のreader再使用は拒否する。blocking worker JoinErrorではreaderを喪失したものとしてfaultedを記録する。read cleanup確認不能はUncertainのままにし、別readや管理handoffを許さない。dispatcher／Runtime終了でSupervisor自体を失った場合も同様で、別接続で穴埋めしない。

## 5. 二つのquiescenceと結果統合

ReconciliationResult.quiescenceは**元applyの物理完了**である。read自身の完了は前節のphase／completion型で別管理する。readが正常joinしただけで元unknownをconfirmedへ変えない。c3は元applyを再joinしないため、元quiescenceはc2で確保した根拠を維持する。

| c1の結果                    | 公開read結果                        | owner更新                                                      |
| --------------------------- | ----------------------------------- | -------------------------------------------------------------- |
| Some(receipt)、全文照合成功 | receiptFound                        | 元operationId/requestのlatestをappliedへ合成。元completion不変 |
| None                        | notFound                            | 元latest／既知成功を保持。非commitや再実行許可にしない         |
| Conflict／CorruptData等     | failed＋閉集合error                 | 不在へ変換しない。writer recovery維持                          |
| read取消／期限／予算        | failed＋対応error                   | read正常join後だけ公開。元apply取消ではない                    |
| receiptのsafe投影不能       | failed/projectionFailed             | native証拠をbounded保持。commitなしと主張しない                |
| read自身の物理確認不能      | Rust completion Err、read Uncertain | DTOの元apply quiescenceを書き換えず、新読取・移管をblock       |

c1のsnapshot_commitは同snapshotの内部証拠で、既存ReconciliationResultには公開fieldがない。receipt自身の公開数値はMAX_SAFEへchecked投影するが、現在headの内部snapshot_commitがMAX_SAFE超過という理由だけではsafeな歴史receiptの投影を拒否しない。

receiptFoundはd4aの期待版+1／PlanRef／requestId／desired／bound refs／hashを検証する。native canonicalのmember順と数値表記が同値でも、echoは元owned OperationRequestの表示順・値を保持する。既知の**同じ元apply**のreceiptと違う内容ならprojectionFailedとして保持済み成功を消さない。

lastAppliedはFoundの元apply request付きpairへ更新できる。過去workflowの別requestに対する成功pairとは不一致エラーにしない。過去成功の履歴全件は保持せず最新一件とする。同じ元applyで確認済みreceiptを後続notFound／failedで消さない。Read receiptとc2 native receiptの照合は元requestの一致を前提に行い、別requestの成功を比較対象にしない。

recoveryRequiredは元completion／現在owner／native latchのORで、read成功ではclearしない。unknownならuncertain、confirmedでもrecoveryがあればblocked。c2のapplied→recovery trueの単調性を維持する。readエラーで新たに健全性不明になった場合はowner回復要求を立て、handoff可能な場合も既存native recovery gateへ伝える。reader健康だけの成功を記録開始資格に変えない。

lastReconciliationは最新の有効なread結果一件。元OperationHandle.completionの再resolveや上書きはしない。read結果の通知と元operation最新表示の通知順に依存せず、同一Core更新を確定してからwatchを発行する。

## 6. 有限ID・保持・予算

read ID registryはmutationの4096枠と別に**4096 ID**を持つ。IDはH1最大64 ASCII、同contextで再使用禁止。同じIDを別applyへ付け替えない。native apply.requestIdはこのpoolに入れない。readは一回で完結するためcredit予約は不要で、受付前に一枠を確認し、受理したIDは失敗・取消でも解放しない。未受付拒否は消費しない。

満杯なら同期BudgetExceededとし、既知receipt／gateを保持する。自動pool reset、新context再作成、latch解除をしない。管理handoffは管理readと元operationの物理確認を必要とし、blocked時にはc2の回復evidenceとnative sticky gateを一緒に移管する。新ownerを作って回復要求を迂回できない。Uncertainで移管不可／pool枯渇となっても、それを有限の停止状態として公開する。全ケースで無限照会できるとは約束しない。

ownerは現在workflow、現在／最後read handle一個、有効read結果一個、最新成功pair一個、必要なnative証拠一個のみ保持する。過去handleを外部callerが保持する分はcaller所有。reader workerの結果配列や無制限queueを作らない。

c1の256 decoded rows cap、元QueryControl検証、同一VM／入力8MiB／caller出力上限／deadline／取消をそのまま使う。native request128KiB・node8192とnested desired64KiB、d4a reconciliation request／responseの既存JSON予算は別に検証し、片方を満たすだけで公開可能としない。SQL／DTO投影のsafe整数を丸めない。QueryControlのdeadlineはnative Instantが権威で、dispatcher／blocking待機で延長しない。JS performance.nowとのbridgeは未実装で別設計とする。

## 7. 取消、Drop、Runtimeと移管

取消は当該read tokenだけに作用する。元apply tokenやrecording stopを触らない。request_cancelはrequested／alreadyCompletedを返し、取消要求だけでread枠を解放しない。wait Futureやclient/watchのDrop、UI close／Project交換はunsubscribeだけである。外部ownerが元要求・handleを保持し、cleanup後のlate結果を同ownerへ保存する。

管理owner Dropは新受付を閉じ、readへcooperative cancelを要求する。blocking taskをabortして資源解放したとは扱わない。stage guardをspawn前に構築し、未poll Runtime終了にもfinite ErrとUncertain状態を保持できるようにする。正常結果を偽装せず、in-flight native workerが持つreader lease／writer lockは実資源の寿命に従って残る。Runtime shutdown時のcleanup完了は保証しない。

c2のtry_handoffにread InFlight／Uncertain拒否を加える。read Completedで元applyもconfirmed、Supervisor健全に返却済みの場合だけ従来条件で可能。evidenceへ最新reconciliation request/resultまたは有限read failureを各一件追加し、owner-only recoveryをnative gateへ伝える既存規則を維持する。管理権移管は記録の停止・latch解除ではない。

Core Mutex poisonを受付時に検出した場合は、既存OperationRejectionのinternalで同期拒否し、新read IDを登録しない。in-flight readの終了／失敗処理でpoisonを検出した場合はownerをclosedにし、read completionを有限OwnerError::Internal、read phaseをUncertainとする。回復要求と既知receipt／元要求を保持し、mutation／read再受付とhandoffは不可とする。poisoned stateを健全と仮定してregistryのcredit再計算や資格復元を行わない。正常結果が既に確定していれば二重guard通知でそのcompletion／既知成功を上書きせず、owner閉鎖と回復gateを独立に保持する。

Tokio watch::Refはclone後に解放してからowner APIやawaitを呼ぶ。receiver不在でも結果をsend_replace等で保持する。monitor taskとLoan guardの二重失敗は冪等にし、既に確定したread completion／成功receiptを上書きしない。

## 8. 実装順と受入

この設計PRの次に、一つのc3実装PRでprivate Supervisor receipt loan、owner read registry／API／watch、d4a投影と単調統合までを完成させる。JS bridge、認証、製品transport、回復gate解除は含めない。c1とc2の実装済み範囲は維持し、read開始資格を共有mutation gateの緩和で実現しない。

| 境界       | 必須受入                                                                                                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 資格       | 他owner、古いworkflow、同文字IDの別handle、preflight/pause、未完了apply、notDispatched/notCommitted、通常成功は拒否。登録・DB不変                                                       |
| 実receipt  | private lost-response seamでcommit済み元apply→c1 Found→latest applied/confirmed/true、元completion failed不変                                                                           |
| 不在       | 未commit fault→None。latest failed／latch維持、再apply不可                                                                                                                              |
| 複数時点   | 現在headが進んでも元receipt照合。既知同request receipt矛盾は拒否、別過去成功pairとの誤衝突なし                                                                                          |
| 貸出       | 全caller read競合一件、mutation/discard/handoff Busy、二reader lease不変、返却前に結果を公開しない                                                                                      |
| 資源障害   | native apply worker panic後readerが健全なら照会可能。Supervisor消失／reader poisonは不可。read worker panic／Runtime未poll終了はread Uncertain、移管不可                                |
| 期限と取消 | queue待ちで元deadline維持、dispatch直前期限、read取消後正常join、wait timeout非取消、late結果保持、元apply token不変                                                                    |
| owner寿命  | client Dropとowner Dropの区別、外部handle wait、writer Drop後reader lock、受理済み要求の有限保持                                                                                        |
| 投影       | U1の1/1.0同値、元member順echo、MAX_SAFE超過のnative evidence保持、元unknownをread成功でconfirmedへしない                                                                                |
| registry   | mutation pool満杯でもread枠独立、read4096境界、同期拒否非消費、同ID別apply拒否、枯渇時自動resetなし                                                                                     |
| 冪等通知   | subscriber不在・subscribe/completion順逆転・二重guard失敗・Core poisonでも一回completion、poison受付非登録／in-flight閉鎖／Internal保持／handoff拒否、known receipt／recovery巻戻しなし |

実FULLの原子rollbackは既存Historian試験、owner境界のtyped failure／lost responseはprivate seamと区別して記録する。隔離SQLite／mockHubだけを使い、通常Appへ実adapterを接続したとは主張しない。実装後はAstra read-onlyレビュー、workspace／Clippy／既存共通DTOとbrowser回帰を確認してReady PRにする。
