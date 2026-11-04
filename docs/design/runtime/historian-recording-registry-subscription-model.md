# 記録registryモデルのsnapshotと購読

状態: **prep2b3モデル実装済み、複数scope・実接続は後続**。2026-11-05（日本時間）。主設計はユーザー指定のAstra。
[取消モデル](historian-recording-registry-cancel-model.md)はPR #74で統合済み。本書は決定的モデルにsnapshot／attach／controlと仮想配送slotを追加する。
実native、SDK、DB、認証、時計、transport、hostへの接続はない。Project 0.37.0、DB7、H1、wire schema、依存は変更しない。

## 1. 一PRの範囲

既存14 wire rootのうちAttachRequest/Reply、ControlRequest/Reply、StateFrame、ControlFrameをモデルで扱う。
採用するのは単一owner内の原子的snapshot登録、revision、最新一件slot、明示detach／reconnect、元callの不変返信である。
prep2b3ではasync task、実socket、認証失効処理、global32購読allocator、workflow credit解禁、実native dispatchを追加しない。モデルは単調なframeを生成する側であり、受信frameの並べ替え／同revision矛盾を検出する第二のclient modelは作らない。対応付けのfixtureは既存pure helperで検証し、実clientでの受信安全性とは区別する。

構造は `scada_runtime::recording_registry_model` の拡張とし、TS側に第二のregistryを実装しない。
Rust scenarioが遷移を実行し、browserは出力DTOの既存validator検証だけを行う。

## 2. snapshotは独立したheadを持つ

OwnerSnapshotは次の規則で投影する。

| field          | 根拠                                                                           |
| -------------- | ------------------------------------------------------------------------------ |
| scope          | model作成時のimmutable scope                                                   |
| revision       | checked U1。初期値1                                                            |
| closed         | model.close済み                                                                |
| ownerBlocked   | recovery_requiredだけ。ClockFault／Busy／通信unknownを混ぜない                 |
| admission      | 最大admission sequenceの現在knowledge。未確定は元要求付きunknown/workerFailure |
| operation      | 最大sequenceのAccepted operation handleのcompletion。未完了ならnull            |
| reconciliation | 最大sequenceのAccepted read handleのcompletion。未完了ならnull                 |

新しいread admissionを登録しても、operation fieldを消さない。新しいAccepted readが未完了ならreconciliationだけnullとなる。
最新admissionより古いticketへlate proof／completionが届いてもadmission headを巻き戻さない。
operation/read headは各kindの最大Accepted sequenceを権威とし、古いcompletionの到着順をhead選択に使わない。

admissionのunknown表示は現在knowledgeの未確定表現であり、元call terminal replyとは独立する。
finish_admission_callで異なるunknown errorを保存しても、未確定knowledgeのsnapshot表現はworkerFailureで固定する。
同時にCallInspectionはその元replyを正確に返す。この二つを同一の返信と称さない。

結果payloadは不変参照を使う。read receiptFoundで元operationを合成・上書きせず、quiescence／recoveryを別証拠から補完しない。
nullはそのheadのcompletion未提供であり、成功／停止／未実行の省略表現ではない。

## 3. 将来projectionの受付前closure

既存root上限を足すだけではsnapshot 1MiBに収まらない。そのためbegin_admissionの変更前に、固定された元要求から将来payload上界を算出する。
新たなunknown JSON入力を信用するのではなく、全fieldが閉じたschemaと既知requestを使う。

| payload                | 保守上界                                                         |
| ---------------------- | ---------------------------------------------------------------- |
| OperationResult        | 元OperationRequest実測＋固定包絡64KiB/4096nodes                  |
| ReconciliationDelivery | 元ReconciliationRequest実測×2＋同固定包絡                        |
| AdmissionReply         | 元AdmissionRequest実測＋最大AcceptedRefのrequest実測＋同固定包絡 |
| OwnerSnapshot          | scope実測＋各slot上界＋固定包絡64KiB/4096nodes                   |

OperationResultの残fieldはreceipt／error／ID／安全整数／enumだけであり、request以外の任意長本文を持たない。
Deliveryは自身のrequestとnested result.requestの二重echoを数える。AdmissionReplyも元admission内とAcceptedRef内の要求を別々に数える。
preflightで生成予定のOperationRequestは元changeを使い、未知operationIdを最大64 ASCIIとして計数する。pause/apply/reconcileは元要求をそのまま使い、discardはhandle requestを0とする。
包絡64KiB/4096nodesは採用schemaの未知field総量を包含する安全側の定数で、全合法branch／最大ID／receipt/errorを用いた試験で証明する。後からschemaが増えたときは同試験を更新する。

depthは実際のrequest位置のnesting段数を足して最大を取る。root depth=0、既知requestのdepthをdO（operation）、dR（reconciliation）、dA（admission）、dH（Accepted handle request）とすると、OperationResultはmax(dO+1,4)、Deliveryはmax(dR+3,6)、AdmissionReplyはmax(dA+1,dH+3,3)で包含する。discardはdH項を除く。
OwnerSnapshotはmax(scope.depth+1, admission.depth+1, operationResult.depth+2, delivery.depth+1, 3)。operation fieldのwrapperを忘れず2段加算する。null slotの項は0としてよいが将来予約は候補値を使う。
固定包絡の最大合法branchを独立したschema fixtureから計数し、未知field部分が64KiB/4096nodes内であることを試験する。上界helper自身の出力だけをoracleにして証明したと称さない。
既存compact OperationResult予算はそのまま別に検査し、projection上界はwireと同じ保守計数である。

候補admissionの最大knowledgeと、将来operation/read headの候補予約を現在の他slot予約と組み合わせる。
まだAcceptedでない候補でも将来Acceptedになる可能性を含め、slotがnullの時も予約を消費済みと見なす。
同時に複数の未確定候補がある場合、各kindの現headと将来head候補の上界をcomponent-wise最大にする。過去のlate proofが大きいpayloadをheadにし得る間はその予約を忘れない。
単純化のためモデル寿命中のslot別high-water上界を下げない実装を許し、初回実装はこれを推奨する。

bytes1MiB／nodes32768／depth64を超える候補はbegin前Capacityで拒否する。ID／lease／bytes／revisionを消費しない。
既存のcompletion保存予約は別に維持する。projectionの都合でAccepted済みのcompletionを破棄・架空nullへ置換しない。
observe_native／complete_handleは予約内への更新であり、未知future projectionのための追加容量を要求しない。
projection上界に実測が収まることもassertではなく変更前検査で確認し、不整合なら元証拠を変更せずエラーとする。

## 4. revisionの予約

snapshot内容が変わる遷移だけrevisionを増やす。exact replay、同値proof/completion、finish、観測回収、取消、inspection、clock前進／逆行だけでは増やさない。
具体的には新admissionのunknown head公開、headに影響するAccepted/Rejected/Discard proof、公開completion/recovery変化、closeである。
revision以外のsnapshotが同値ならincrementしない。複数fieldを同時に変更する一遷移は一回だけ増やす。

U1上限でwrapしない。begin_admissionは将来最大3回（登録、proof、completion）のrevision creditを確保してから受理する。
各recordの未使用creditは保守的に保持してよく、終端したからといって別recordへ無制限再利用しない。
close用1creditはmodel初期化時に別に確保する。新規受付のcredit不足は変更前Capacity。
これによりAccepted後の証拠やcloseをrevision枯渇だけで公開不能にしない。

試験用に小さいrevision ceilingをModelLimitsで指定できるが、2..MAX_SAFEに制限する。初期revision1とclose用1が必要である。
実時計やsubscription数をrevisionへ流用しない。closeは一度だけ公開し、二重closeは同値no-op。
close()はResult<(),ModelError>へ変更し、projection検証をpanicにしない。既存caller／scenario runnerも結果を扱う。正当入力では予約があるため、受理済み証拠をrevision上限で失う経路や自動resync faultを必要としない。
実装はNewAdmission／Knowledge／Completion／Closeの単一event overlayで候補descriptorとbounded JSONを構築・検査し、その後coreとdescriptorをcommitする方式を推奨する。全model cloneを要求しない。register_handleもpureな登録planとcommitへ分け、projection検査より前にhandle mapを変更しない。失敗時は対象record・会計・pending slot・revisionを全て変更しない。

## 5. immutable descriptorと保持会計

subscriptionごとに1MiBのJSONを永久複製しない。
内部SnapshotDescriptorはrevision／closed／ownerBlockedと、scopeおよびimmutable admission knowledge／operation/read completionの参照を持つ。
参照はArcまたはmodel内の削除されないrecord＋不変variantでよいが、後でknowledgeが変わっても古いdescriptorの値が変わらないことを必須とする。
元unknown descriptorが後からAcceptedを返すようなlive pointerを禁止する。
admission参照はUnknown{admission_id}とDefinitiveProof{admission_id}を区別する。Unknownは常に元request付きworkerFailureを構築し、現在のproof／terminalへ切り替えない。DefinitiveProofだけが保存済み不変proofを参照する。
operation/read refはdescriptor生成時にcompletionがSomeであるものだけを格納する。nullで固定した旧descriptorを後のcompletionで補完しない。

JSONはsnapshot／frame／replyを返す際に生成し、既存validatorと独立上限を通す。
保持descriptor一個は定数上界1KiBとしてread予算へ課金する。これは最大三つのrecord参照と固定scalarの管理payloadで、snapshot本文は既存record予約が所有する。
この表現を使わずJSON本文を保持する実装なら、その実保守bytesを別途課金しなければならない。
一時出力はsnapshot1MiB／reply/frame2MiBを独立に上限化し、retained 8MiB／read2MiBの同じ値だとは主張しない。

current descriptor、各live subscriptionのstate slot、attach/controlの不変返信descriptorに上界を確保する。
current分1KiBはnew時のread予算から、subscription slot分はattach前、元reply分は各request受付前に確保する。
slot更新は既存予約を使い、completion到着時にread容量不足で通知を落とさない。
new()時read予算が1024bytes未満ならCapacity。旧fixtureの利用可能予算を保つ場合はtotal_bytesとread_bytes双方を1024増やし、readBytes期待値へ1024を加算する。partitionの差を黙って変えない。

## 6. API概形

```rust
impl RegistryModel {
    pub fn close(&mut self) -> Result<(), ModelError>;
    pub fn owner_snapshot(&self, session: &ModelSession)
        -> Result<Value, ModelError>; // OwnerSnapshotとして検証
    pub fn attach(&mut self, session: &ModelSession,
        request: RecordingWireAttachRequest)
        -> Result<RecordingWireAttachReply, ModelError>;
    pub fn control(&mut self, session: &ModelSession,
        request: RecordingWireControlRequest)
        -> Result<RecordingWireControlReply, ModelError>;
    pub fn take_state_frame(&mut self, session: &ModelSession, subscription_ref: &str)
        -> Result<Option<RecordingWireStateFrame>, ModelError>;
    pub fn take_control_frame(&mut self, session: &ModelSession, subscription_ref: &str)
        -> Result<Option<RecordingWireControlFrame>, ModelError>;
}
```

session／scopeはID lookupより前に照合する。raw subscription_refはH1の有限IDとして検査してから検索する。
生成subscriptionRefはlease/admission sequenceと別のchecked counterを使い、短いmodel-subscription:n形式とする。attachが既存lease/admission採番を変えない。scope／principal／epochが異なる入力は拒否するが、raw refとvalue-based sessionは全く同一scope/epoch/principalを複製した二modelの出自を区別できない。wire JSONをprivate model-instance ticketと称さず、将来hostがownerEpochの一意性・認可済みlogical session対応を保証する境界として残す。既存operation/cancel ticketのArc instance束縛はそのまま維持する。
未知refはInvalidInput、同attach/control ID別本文はProtocolViolation。pure schemaの既存fieldは増やさない。

## 7. attachとACK前更新

attachはrequest検証、afterRevision<=current、live cap、ID／bytes／sequenceを全て変更前に検査する。
afterRevisionが未来ならProtocolViolation。closed時の新attachはClosed。既存exact replayはclosed後も元replyを返す。
同gateでsubscription登録とその時点のdescriptor Rを取得し、元AttachReplyを固定する。
初期state slotは空。以後の公開更新R+1以降を当該subscriptionの最新一件slotへ入れる。

attachはモデル内で同期完了するが、scenarioは返却replyのclient配送を遅らせられる。
その間に新frameを取り出して先に配送する試験で、ACK前frameを模擬する。実clientやsocketは作らない。
元AttachReplyをCallInspectionで後から取得してもsnapshot Rは不変で、最新snapshotへ差し替えない。

## 8. control・detach・reconnect

control snapshotはその時点のdescriptorを元ControlReplyへ固定する。exact同ID再送は同じ返信で、最新を求めるなら新IDを使う。
control detachはsubscriptionをdetachedへ一度遷移させ、state/control slotを空にしてlive枠を返す。
元attach/control IDと不変replyは保持し、同ID再使用や元callの偽notFoundを許さない。
detachではlive subscription slotの固定1024bytesだけを一度返却する。attach／control requestとimmutable reply descriptorの課金は返さない。control snapshotはrequest実測＋descriptor1024、detachもreply metadata用1024を保守予約する。
新controlの課金とlive slot返却はchecked used−refund＋newcostで原子検査し、先にfreeして別操作を通す状態を作らない。既detached／同ID replayでは再返却しない。
detachの同ID再送は冪等。別controlIdで既detachedへdetachしてもdetachedを返せるが、新ID/bytesを必要とする。
既detachedへsnapshot要求はInvalidInput。取得中native operation／read／cancel／recorderを止めない。

reconnectは新attachIdで同scopeへ明示attachするモデル操作である。旧subscriberは自動detachしないため、live capに達していれば新attachを拒否する。
別epochへ元要求を再送したり、unknown操作を新ownerへ移したりしない。
CallInspectionはAttach／Control originalも対応し、未登録notFound／保存済みterminalを返すだけで、attach/controlを実行しない。

## 9. state/control slot

公開snapshot更新時、live subscription各state slotを最新descriptor一件へ置き換える。中間revisionのcoalesceを許す。
control slotも最大一件。prep2b3で生成するControlFrameはownerClosedだけとし、実認証のないauthorizationLostやtransportのないresyncRequiredを捏造しない。
closeはclosed=true snapshotを公開し、ownerClosedを各slotへ置く。これにより更新前stateとcontrolの相対配送順を試験できる。
close後も既存slotの取得、元call照会、明示detachは可能。closeだけでstate/control slotを破棄しない。

slotが既にownerClosedなら同値通知で置換しない。未対応の複数control priorityを今回導入しない。
takeは正しいsession／refを確認してDTOを正常構築後、対象slotだけ空にする。DTO生成失敗で先にslotを失わない。
frame取得は元Attach/Control/admission/observation Promiseの終端根拠ではない。モデルにはPromiseがなく、immutable元call返信を別に保つ。

## 10. capと段階制限

ModelLimitsへlive_subscriptions<=4、attach_requests<=4096、control_requests<=4096、revision_ceiling（2..MAX_SAFE）とprojection_limit:WireBoundを追加する。projection_limitの既定はSnapshot上限1MiB/32768nodes/depth64で、各軸は縮小だけを許す。これはモデル試験用のclosure境界調整でありwire schemaの変更ではない。縮小値で初期snapshotが収まらなければnewを変更前に拒否する。
全owner32制限・global16MiB allocatorは[prep2b5で詳細設計済み](historian-recording-registry-global-budget.md)だが未実装。単一scopeの4をprocess全体の制限と称さない。
ID墓標と元replyはmodel終了まで保持し、live slot解放だけでIDを再使用しない。

新requestには既存保守metricsとdescriptor予約をread枠から原子課金する。
closeや証拠更新には既存予約を使い、現在read枠が満杯という理由で拒否しない。
固定metadataは件数上限で有限化する。保持payload会計と実allocator量を混同しない。

## 11. 受入

| 境界             | 必須受入                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| projection       | 三head独立、元unknown terminalと最新Acceptedの分離、late古いproof／completionでhead巻戻し無し            |
| 容量             | 既知request＋全branch包絡の上界、1MiB exact/1不足、拒否時lease/ID/revision無変更、Accepted後完了保存可能 |
| revision         | 初期1、exact/no-op非増分、複合更新1回、将来3credit＋close予約、縮小ceiling不足原子拒否                   |
| attach           | snapshotRと登録原子、ACK前frame、元reply不変、未来afterRevision拒否                                      |
| slot             | state最新1、take後空、closeのstate/control別一件、二重close no-op                                        |
| detach/reconnect | detach非停止、slot/live枠解放・ID保持、新attachのみ最新snapshot、旧scope拒否                             |
| 復旧             | CallInspection未登録で開始しない、attach/control ACK喪失から元reply取得、frameでcall終端を捏造しない     |
| 会計             | read不足で新attach/control拒否、証拠更新/closeは既存予約、全cap縮小試験                                  |
| 非接続           | native/DB/SDK/auth/network不変、TSは既存wire fixture評価のみ                                             |

設計と実装はこのモデルまでであり、実subscription dispatcher／socket backpressure／host起動の保証へ拡張しない。
prep2b4aのWorkflow modeでは全段階creditと単一候補の進行を実装した。StandaloneはAccepted後の新mutation保守blockを維持する。

workflow credit・単一候補の段階進行は[prep2b4a](historian-recording-registry-workflow-model.md)で実装した。購読やframe配送だけで新mutationを解禁しない。
