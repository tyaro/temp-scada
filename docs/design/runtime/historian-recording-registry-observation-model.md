# 記録registryモデルの結果観測

状態: **prep2b1・2モデル実装済み、実接続は後続**。2026-11-05（日本時間）。主設計はユーザー指定のAstra。
[prep2a](historian-recording-registry-model.md)はPR #72で統合済み。本書はその決定的Rustモデルへ不変completionと結果観測を追加する。
実native owner／DB／SDK／認証／transport／製品hostへ接続しない。Project 0.37.0、DB7、H1、全schema・依存版を維持する。

## 1. 一PRで閉じる範囲

prep2b1は三つの不足を閉じる。

- fake Acceptedをモデル固有のhandle ticketへ束縛する。
- operation結果／reconciliation deliveryを元handleに対応する不変completionとして保存する。
- 既存WireObservationRequest/Replyをread-only状態遷移として扱う。

[prep2b2の取消モデル](historian-recording-registry-cancel-model.md)を追加した。[prep2b3のsnapshot／subscription](historian-recording-registry-subscription-model.md)も追加した。[prep2b4](historian-recording-registry-workflow-model.md)で全workflowのcreditと正常completion後の明示的な次workflow予約も実装した。複数ownerの全量予約は[prep2b5aの純粋domain](historian-recording-registry-global-budget.md)へ実装した。
本結果観測の追加だけでは、Accepted結果が成功／confirmedであってもStandaloneの新mutation保守blockを解除しない。
reconciliation登録はdispatcher slotが空けば独立read枠で可能だが、実nativeのread適格性を保証するものではない。

既存 `scada_runtime::recording_registry_model` だけを拡張する。async task、実時計、callback、generic native backendは追加しない。
TSには第二のregistryを作らず、Rustのscenario出力を既存wire validatorで確認する。

## 2. 変えない三つの軸

| 軸                         | 入力／証拠                                    | 結果観測で変えてはいけないもの                                  |
| -------------------------- | --------------------------------------------- | --------------------------------------------------------------- |
| 元admission call           | finish_admission_callによる不変terminal reply | 後でAccepted／completionが判明しても元unknown返信を上書きしない |
| 受付知識                   | observe_nativeの明示SimulatedDecision         | completion入力だけで未登録要求をAcceptedにしない                |
| operation／read completion | 新しいmodel-bound ticketへの明示入力          | 元call終端・元apply静止・recovery解除を推測しない               |

ここで「trusted」は試験driverが明示したsimulation入力という意味だけである。実nativeのopaque証拠を検証したとは主張しない。
JSONにoperationRefがあるだけでは入力資格にならず、モデルが発行したprivate ticketが必要である。

## 3. API

既存public APIの意味を維持し、次を追加する。

```rust
pub struct SimulatedHandleTicket {
    // private: Arc model identity, admission sequence, handle kind/ref
}
pub enum SimulatedCompletion {
    Operation(RecordingOperationResult),
    Reconciliation(RecordingReconciliationDelivery),
}
impl RegistryModel {
    pub fn accepted_handle(&self, admission: &SimulationTicket)
        -> Result<SimulatedHandleTicket, ModelError>;
    pub fn complete_handle(&mut self, handle: &SimulatedHandleTicket,
        completion: SimulatedCompletion) -> Result<(), ModelError>;
    pub fn observe_result(&mut self, session: &ModelSession,
        request: RecordingWireObservationRequest)
        -> Result<RecordingWireObservationReply, ModelError>;
}
```

SimulatedHandleTicketはClone可能、field非公開、Deserializeなし。任意のref文字列から生成するconstructorを公開しない。
accepted_handleは同じmodelのadmission ticketと確定Acceptedだけを受理する。Registered／unknownのみ／Rejected／CompletedDiscardはInvalidInput。
元callが未終端でもAccepted知識が確定していればhandleを取得できる。これによってnative完了がadmit ACKより先着する順序を模擬できる。

既存observe_nativeはAcceptedを保存する際、同一遷移でhandleの対応表も登録する。
キーは `(kind, ref)`、値は元admission sequenceと受理された元requestである。同kind同refを別admissionへ再使用する入力は、元request全文が同じでもProtocolViolation。これはfake unique-refの初回制限であり、実nativeの冪等再送による同handle共有を実装したとは称さない。
同じadmissionへ同値Acceptedを再投入した場合だけ冪等とし、別refへの差替えを拒否する。
kindが異なるrefの同文字列は別namespaceとして扱い、target.kindを省略して検索しない。
kind／元requestはc4a AcceptedRefから取得する。preflightのoperationIdを推測・再発行しない。
read Acceptedの登録には追加条件を課す。元admission.action.operationRefが同modelの既存operation handleへ解決でき、その元OperationRequestがstage=applyで、reconciliation.request.operationと全文同値でなければProtocolViolation。別owner／未知ref／同名別本文をreadの元applyにしない。この照合とread handle登録を原子化する。
これはprep2aの任意fake reconciliation受理入力を意図的に狭める変更である。fake read登録自体は継続可能だが、Accepted proofには元applyのmodel-bound証拠が必要となる。

別model ticketはForbidden、model内の不明ticketはInvalidInput、既登録内容との矛盾はProtocolViolation。
全部の検査と生成reply検証を変更前に終え、失敗時にproof／ref表／completion／ID／bytesを部分更新しない。

## 4. completion入力

complete_handleはticketのmodel identity・元sequence・kind/refを照合してから、既存owned validatorの保証を使う。
operation branchは登録されたOperationRequest全文と結果のrequestを照合する。
reconciliation branchは登録されたReconciliationRequest全文、ownerRef、readRefとDeliveryを照合する。
数値整数表記／object key順は同値、members配列順は要求echoとして維持する。

最初の正常入力でcompletionを保存する。同値再通知は成功して何も変更せず、別本文はProtocolViolation。
期限到来、close、ClockFaultの後でも、既登録handleへの終端証拠は保存できる。
lease期限は受付期限であり、期限後の実証されたcompletionを未実行に変換するものではない。

OperationResult.quiescence／recoveryRequiredは元結果をそのまま保つ。applied receiptがあってもunknownをconfirmedへ変更しない。
Delivery.resultのquiescenceは元applyの根拠で、read自身の終了を証明するfieldではない。
confirmedを保存できるのは、対応する元operation completionが既に保存され、そのquiescenceもconfirmedの場合だけである。元completionが未到着またはunknownなら、read resultはunknownかつrecoveryRequired=trueでなければ拒否する。JSON enumにはunconfirmedを追加しない。
元operation completionのrecoveryRequiredがtrueなら、read resultのfalseを拒否する。receiptFound／notFound／failedの別を問わず同じ規則を適用する。
元operationが後でconfirmedになってから、以前に捕捉された保守的unknown／trueのreadが到着することは許す。元completionを巻き戻したり、そのreadをconfirmedへ補正したりしない。
実nativeは元DTOの配送前に静止を知り得るが、この限定モデルでは元operation completionの入力を先に要求する。これを本番adapterの配送順制約と偽称しない。
Delivery.readUncertainは別の終端deliveryとして保持し、receiptNotFound／正常failedへ変換しない。
wire観測のterminal返信は「このsimulation deliveryが確定した」ことだけを表す。native資源の物理終了を追加で主張しない。

prep2b1はimmutable deliveryを保持するだけで、後日のreceiptFoundを既存operation結果へ自動mergeしない。
元apply結果と別reconciliation結果を両方保持できるが、sticky recoveryをclearするAPIを作らない。
新mutationのblockもcompletionによって解除しないため、receiptが見えたことによる迂回は起きない。
ModelStatsにrecovery_requiredを追加する。OperationResult.recoveryRequired、Delivery.result.recoveryRequired、Delivery.readUncertainのいずれかがtrueの根拠ならsticky ORで保持する。readUncertainは常にtrueの根拠とする。後の正常receipt／confirmedでclearしない。一方、元call unknown、未知ref、ClockFault、close、通信を仮定したtimeoutだけからrecovery_requiredを立てない。これはsimulationが明示したnative recovery根拠の投影で、実ownerの状態ではない。

## 5. read-only観測

observe_resultはsession／scope／targetの全文を確認し、登録済み `(kind, ref)` の元requestに照合する。
既存Observation IDがあれば同本文を要求し、別targetへの付替えはProtocolViolation。
未知refも元requestだけのbindingを原子的に登録し、不変のunavailable／ownerUnavailableを返す。pending slotを消費しない。後からそのrefがAcceptedとして登録されても当該Observation IDはunavailableのままで、新しいIDによる明示観測が必要である。存在しないrefを開始要求やfake handle登録に変換しない。

新IDを受け付けると、対応するoperation/read poolへ元requestを保存する。
completionがなければpendingを返す。既にcompletionがあれば対応するoperation／reconciliation replyを返す。
pending状態の同IDを再照会してもnative処理・fake proof・completionを追加しない。
terminalを一度返したIDは後から同じterminalを返す。既存CallInspectionへObservationを追加せず、採用済み専用read-only protocolを維持する。

pending返信は登録された観測の完了を意味しない。モデルは各kindで最大2件の「登録済み、terminal未回収」slotを持つ。
complete_handleでcompletionがreadyになっただけではslotを解放しない。
同IDのobserve_resultがterminalを返した時だけ、そのIDのslotを解放する。これによりcached結果を知っただけで元callが終わったと扱う誤りを避ける。
terminalが最初からreadyな新IDは同一遷移で登録と回収を行い、pending slotを占有しない。
slot解放後もID／元本文／terminalとの対応を保持する。terminalの複製をIDごとに永久保存せず、handleの不変completionを参照して返す。

登録済み観測はclose／ClockFault後も再照会できる。新しいread-only観測IDもread資源余力があれば許す。
UI disposeやlogical timeoutはモデル入力に存在しない。それらでslotを解放するcancel／forget APIは今回追加しない。

## 6. 予約と有限性

prep2aの単一scope retained 8MiB、mutation6MiB／read2MiB分割を維持する。複数scopeの全体予約は[prep2b5aの純粋domain](historian-recording-registry-global-budget.md)で実装した。実hostへは接続していない。
ModelLimitsへoperation_observations／read_observations（各最大4096）、pending_operation_observations／pending_read_observations（各最大2）を追加する。
縮小した上限による境界試験を許す。元admission/lease/inspectionの上限は変更しない。

prep2b4aで[要求由来のlifetime予約](historian-recording-registry-workflow-model.md#6-tight-lifetime上界)へ両modeを統一した。元requestと二つの独立reply上界、operation／read completion上界を受付前に確保し、discardにはcompletion枠を加算しない。
Acceptedやcompletion到着時に追加の容量不足で証拠を失わず、使用済みrecordの予約はモデル終了まで保持する。reconciliation ID台帳はAdmissionRecordへの不変参照とし、管理用256bytesだけをread枠へ追加する。

958464はOperationResultのlegacy compact上限を保守計数へ変換した `3 × 256KiB + 21 × 8192` の独立検査上界として維持する。要求由来の保持予約はlegacy validatorの予算を変更しない。
complete_handleは両方の上界に収まる既存validated payloadだけを保存し、範囲違反なら変更前に拒否する。
保持payload予約はRust allocator使用量そのものではない。

新Observation IDには元requestの保守bytesだけをread枠から課金する。operation観測もread-onlyなのでmutation枠を使わない。
返却replyの一時構築はprep1の2MiB上限で独立に制限し、retained bytesへterminal全体をIDごとに重複課金しない。
bytes／ID／pending slotの全条件を変更前に確認する。同値再照会・completion二重通知で二重課金／二重解放しない。
read枠自身の不足はCapacityであり、mutationがreadへ借入して救済することはしない。

## 7. 証拠順序の必須シナリオ

1. begin→Accepted→operation completion→元admit unknown終端。元replyはunknown、受付知識はAccepted、観測はterminalを返す。
2. begin→unknown終端→late Accepted→completion。新mutationはblock、fake reconcile登録はdispatcher終了後だけ可能。
3. Accepted→観測pendingを2件。completion前の第三pending要求を拒否する。completion readyだけでは元2件のslot数は減らず、既存IDのterminal回収時にだけ減る。
4. completion ready後の直接観測はpending slotを占有せず、IDと本文の有限保持は行う。
5. applied/unknown/recoveryRequired=trueを観測してもconfirmedやrecovery=falseに変わらない。
6. 元operation結果とreadUncertain、あるいはreceiptFoundを別々に観測し、相互のquiescence／終端を上書きしない。
7. 同ref別request／別admission、別model ticket、kind違い、readRef／ownerRef偽装を全て変更前に拒否する。
8. readの完了後も元apply unknownやheld mutationを自動解除しない。
9. read Acceptedの未知original operationRef／非apply stage／元本文不一致を拒否し、元applyへ正しく結び付けたreadだけ受理する。
10. 元operation未完了／unknown時のread confirmedを拒否し、元confirmed入力後は許す。元recovery=trueに対するread falseを拒否し、confirmed先着後の古いunknown／true readはそのまま保持する。

第3と第4の区別として、readyな同handleへの新観測は即時terminalでありpending slotを要しない。ready後の新しい即時結果を、未回収slotが2件あるという理由だけで拒否しない。
モデルはfake受理されたhandleを有限数保持できるが、業務上の複数operation実行を実証したとは扱わない。

## 8. 実装PRと受入

Rust modelの既存moduleへhandle／observationの小moduleを追加する。既存native ownerやAppへ接続しない。
shared scenarioにはfake decisionとcompletion入力、観測要求、期待reply／statsを追加する。
Rustが状態遷移を実行し、browserは生成・期待wire DTOを既存validatorで照合するだけとする。

| 境界             | 必須受入                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------- |
| opaque ownership | 同文字refの別model、元request違い、同kind ref再利用、exact Accepted再投入                   |
| 完了             | operation／read両kind、正常／failed／unknown静止／readUncertain、同値二重通知と矛盾拒否     |
| 順逆転           | completionがadmit終端より先、late Accepted、元unknown不変、CallInspectionとの異なる証拠     |
| 観測slot         | operation/read各2、ready未回収、exact再照会、terminal回収後解放、直接ready結果              |
| 予算             | admission追加予約のexact/1不足、read独立枠、IDcap、slotcap、課金の原子性／二重解放無し      |
| read元根拠       | 元apply handle／全文の照合、未完了からconfirmed捏造拒否、recovery後退拒否、late unknown許可 |
| 不変block        | 成功receipt後も新mutation拒否、clockFault／close後の既知証拠保持、native適格性非保証        |
| 出力             | 既存wire／d4a／c4a validatorの独立予算、表示順・数値同値、schema／依存変更無し              |

cancelはprep2b2で通知と不変ack、元call照会、late結果、未送信資格を純粋モデルへ実装した。ackを物理終了・回復解除に変換しない。
snapshot／subscriptionは[prep2b3](historian-recording-registry-subscription-model.md)で実装した。workflow解禁は後続であり、今回の成功を実transport／native製品adapterの完了と呼ばない。
