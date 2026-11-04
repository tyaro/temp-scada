# 記録操作registryの決定的状態モデル

状態: **prep2a／prep2b1〜4aモデル実装済み、次workflow・実adapterは後続**。2026-11-04（日本時間）。主設計はユーザー指定のAstra。
[wire／host設計](historian-recording-wire-host.md)のprep1はPR #71で統合済み。本書はそのJSONを使うprep2を具体化する。
実registry adapter、native dispatch、lease実発行、時計・認証・通信待受・製品hostを追加する許可ではない。
Project 0.37.0／DB7／H1／SDK／Banto／依存とP3b保留を維持する。

## 1. 今回閉じる境界

**prep2aはRustの単一owner状態モデル**として、仮想lease、admission受理前登録、受付知識と元call終端の分離、read-only照会を実装する。
`scada_runtime::recording_registry_model` を新しい独立moduleとし、既存Supervisor／RecordingOperationsOwnerへの参照を持たない。
Tokio、Instant、SystemTime、DB、ファイル、network、SDK、callbackの呼出しをmoduleに入れない。
全操作は `&mut self` の決定的遷移である。Rustの逐次呼出しで全caller gateを模擬し、実process間排他や認可の実装とは称さない。

[prep2b1](historian-recording-registry-observation-model.md)でmodel-bound handleと不変completion／結果観測を追加した。[prep2b2の取消モデル](historian-recording-registry-cancel-model.md)も追加した。[prep2b3のsnapshot・subscription](historian-recording-registry-subscription-model.md)も追加した。[prep2b4a](historian-recording-registry-workflow-model.md)で単一候補の全段階予約と元run／候補の明示pause／apply適格性を実装した。正常終端後の次workflowは[b4bの詳細設計](historian-recording-registry-workflow-renewal.md)を採用し、実装は後続とする。
prep2aは既存c4a全actionの受付台帳を扱えるが、nativeがそのactionを許可すべきかは実装しない。fake決定を明示入力する。
この限定によって、単一callの曖昧さを検証するためにrecording／retention／native ownerを二重実装しない。

## 2. 入力と信頼境界

JSON入力はprep1とc4aのowned wrapperを使い、同じvalidator／全文一致helperを再利用する。
`Scope` はwireのownerRef／ownerEpoch／context全体。モデル起動時に一度固定し再bindしない。
`SimulatedPrincipal` は試験が明示する不透明IDであり、ユーザー名・token・権限roleではない。
`ModelSession::new(scope: Value, principal: SimulatedPrincipal)` はboundedなvalidation-only LeaseRequest envelopeを組み立て、既存wire validatorでScopeを検査する。これはlease発行やID予約を行わない。ModelSessionは検証済みscopeとprincipalを持つローカルRust値。各外部入力で固定bindingへ完全一致を要求する。
既存AdmissionRequestにepochやprincipal fieldを追加しない。logical sessionでepochを照合し、JSONには存在するownerRef／contextだけを照合する。

別principal／scopeは `Forbidden`、同じ役割の同ID別本文は `ProtocolViolation` とする。
JSONのobject key順と整数表記差は同値、members配列順は要求echoの一部である。
ID prefixからrole・認可を推測しない。mutation／reconciliationの分類はLeaseRequest.roleとadmission.actionの比較で決める。
lease、admission、照会IDは互いに別roleであり、各role内で再使用を禁止する。
ただしmutationAdmissionとreadAdmissionはwire上同じadmissionId namespaceなので、両poolを横断して衝突を検査する。

## 3. 公開APIの採用形

以下はRust概形であり、既存の製品host APIではない。名前をfake／modelと明示し、実handleへ転用できるgeneric backendを作らない。

```rust
pub struct RegistryModel { /* private bounded maps and counters */ }
pub struct ModelInstant(pub u64); // 仮想単調ms、UTCではない
pub struct SimulatedPrincipal { /* validated opaque ID */ }
pub struct ModelSession { /* Scope + principal; no credentials */ }
pub struct ModelLimits { /* checked limits, maximums in §8 */ }
pub struct SimulationTicket { /* private Arc identity + checked local sequence */ }

pub enum AdmissionStart {
    Registered { ticket: SimulationTicket },
    Pending { ticket: SimulationTicket },
    Replay { reply: RecordingAdmissionReply },
}
pub enum ModelError {
    InvalidInput, Forbidden, ProtocolViolation, Capacity,
    Busy, Expired, ClockFault, Closed,
}

impl RegistryModel {
    pub fn new(session: ModelSession, limits: ModelLimits)
        -> Result<Self, ModelError>;
    pub fn advance_to(&mut self, now: ModelInstant) -> Result<(), ModelError>;
    pub fn issue_lease(&mut self, session: &ModelSession,
        request: RecordingWireLeaseRequest) -> Result<RecordingWireLeaseReply, ModelError>;
    pub fn begin_admission(&mut self, session: &ModelSession,
        request: RecordingAdmissionRequest) -> Result<AdmissionStart, ModelError>;
    pub fn observe_native(&mut self, ticket: &SimulationTicket,
        decision: SimulatedDecision) -> Result<(), ModelError>;
    pub fn finish_admission_call(&mut self, ticket: &SimulationTicket,
        reply: RecordingAdmissionReply) -> Result<(), ModelError>;
    pub fn inspect_admission(&mut self, session: &ModelSession,
        request: RecordingAdmissionInspectionRequest)
        -> Result<RecordingAdmissionInspectionReply, ModelError>;
    pub fn inspect_call(&mut self, session: &ModelSession,
        request: RecordingWireCallInspectionRequest)
        -> Result<RecordingWireCallInspectionReply, ModelError>;
    pub fn close(&mut self);
}
```

`SimulatedDecision` は `Accepted(reply)`／`Rejected(reply)`／`CompletedDiscard(reply)` の閉集合とする。
replyは対応するc4a outcomeだけを受理し、元要求全文・fake refを検証する。wireからこのenumへ変換する入口を提供しない。
SimulationTicketはClone可能でもfield非公開、Deserializeなし。別RegistryModelのticket、未知ticket、wrapしたsequenceを拒否する。
新規Registeredだけが試験へ「一回のfake決定を投入する箇所」を示す。Pending／Replayは新しい決定・効果を起こす指示ではない。
モデルの返すJSONは既存validatorで検証する。生成ミスは試験失敗とし、無効な成功DTOを公開しない。

## 4. 仮想時計とlease

初期時刻は0。advance_toは同値を許し、前進だけを受理する。逆行はClockFaultをstickyにし、時刻自体を巻き戻さない。
ClockFault後は新lease／新admissionを拒否する。既知元返信の読取・fake処理の終端記録は引き続き可能で、履歴を消さない。
期限は初回issue時の `now + requestedBudgetMs` をchecked加算する。overflowは受付前InvalidInputでありID・bytesを消費しない。
期限と同値のnowで未使用leaseは失効する。実sleepやwall clock補正を入れない。

issue_leaseは、binding→既登録ID全文照合→新規予算／role／一admission一lease→期限確定→元reply保存の順で処理する。
同ID同本文は失効後も元issued replyを返す。budgetもrefも変えず、使用資格が復活したとは解釈しない。
同admissionへ異なるleaseRequestIdを与えて期限延長する要求はProtocolViolation。
新leaseのrefはモデル専用checked counterからH1 IDに収まる短い文字列を生成する。暗黙UUIDやnative IDを生成しない。
未消費lease枠の計数は現在時刻でexpiredを除くが、失効したID・元返信・期限は残す。GCを理由に同IDを再発行しない。

## 5. 受理前登録と元call

begin_admissionの順序は次で固定する。

1. owned構造／context／sessionを確認し、admissionIdを両role poolから検索する。
2. 既登録なら全文同値を確認し、終端済みはReplay、未終端はPendingを返す。lease失効・新clock faultより先に既知証拠を返す。
3. 新規だけclock／closed／lease一致・期限・role・未使用を確認する。
4. 一つのdispatcher slot、ID、元本文と最大返信のbytesを全て予約する。
5. record登録・lease消費・slot取得を一つの遷移で行いRegisteredを返す。

受付前ModelErrorはrecord／lease／予約を変更しない（時計逆行のsticky状態だけは例外）。
ModelErrorをwireの「登録済みimmutable rejected reply」へ自動変換しない。この区別によりpool満杯等で保存していない返信を恒久再送保証と誤称しない。
一つのモデルに同時Registered未終端callは最大1。別admissionはBusy。既存call照会はこのslotを消費しない。

内部recordは少なくとも `request, role, lease_ref, ticket, knowledge, terminal_reply` を持つ。
`knowledge = Registered | Accepted | Rejected | CompletedDiscard | Uncertain`、terminal_replyは独立したOptionである。
finish_admission_callのunknown返信はknowledgeが未確定ならUncertainとし、元callを終端する。native処理停止／rollbackとはしない。
Accepted／Rejected／CompletedDiscard返信を終端するには、それと同値のSimulatedDecisionが既に記録されていなければならない。Rejectedはerrorを含む元reply全文が一致し、CompletedDiscardも専用outcomeのproofを必要とする。unknown終端は既知Accepted／Rejected／CompletedDiscardとも両立し、その知識を消さない。finishだけから肯定・否定のnative知識を確定しない。
unknown元返信後でもobserve_nativeで同ticketの受付知識を確定できるが、元unknown返信は不変である。
確定知識の同値再投入は冪等、異なるref／本文／肯否への変更はProtocolViolation。元replyも同値二重通知だけを許す。

callが終端してもunknown知識は新mutationをblockする。accepted操作の業務完了もprep2aは証明しないため、新workflow進行を許す根拠にはしない。mutation／readのどちらであっても未確定またはAcceptedな過去recordがあれば新mutationを保守的に拒否する。
prep2aのmodel lifecycleは最大一つの未解放workflowを保守保持する。Rejected／CompletedDiscardだけ新workflowへ進める。
dispatcher slotが空けば、held mutationがあってもreconciliationの新規fake台帳登録は独立read poolで許す。これは実nativeのread適格性を証明せず、SimulatedDecisionは拒否を返し得る。Accepted後のpause／apply実進行・正常operation completion・実native reconcile例外gateはprep2b以降で閉じる。任意のreset／force-clear APIは置かない。
この制限はproduction adapterとして不足であることを明示し、モデルに受理させるためnative gateを弱めない。

## 6. 読取照会と返却の意味

inspect_admissionは現在のknowledgeを既存c4a found replyへ投影する。Registeredはfound unknown、未知admissionはnotFound。
Registeredのunknownには既存閉じたOperationErrorのworkerFailure等、未確定を表す採用codeを使い、raw error文を入れない。
既知Acceptedを過去のunknown元返信へ格下げしない。foundは元dispatcher終端の証明ではない。

inspect_callは元callの保存terminalだけを返す。recordあり未終端ならpending、未登録ならnotFound。
prep2aで扱うoriginalはLeaseRequest／AdmissionRequest／AdmissionInspectionRequestで、prep2b2にCancel、prep2b3にAttach／Controlを追加した。未登録Attach／ControlはnotFound、既知要求は保存した不変snapshot返信を返し、照会から購読を開始しない。
inspect_admission自身は同期readとしてその時点のreplyを元call終端台帳へ保存する。同ID再照会は同じ元replyを返し、最新knowledgeが必要なら新inspectionIdを使う。
CallInspection自体のIDは同originalへ束縛するが、そのread-only照会はpending→terminalを返せる。自己をoriginalにしない。

これらreadはmodel内の有限map参照であり、新しいlease／fake decisionを作らない。
元call不明／notFoundで新admissionを許すsealは実装しない。後着の可能性はモデルでも保持する。
close／ClockFault後も既登録証拠をreadできる。new read IDは別read poolとbytesの余力が必要で、無制限read登録を認めない。

## 7. ID・終了・曖昧さ

epochはmodel作成時に明示し、process再起動の模擬は新model＋新epochで行う。
旧modelのJSON receiptを新epochのaccepted根拠に使わない。principal／epochを変えた入力はForbiddenである。
closeは新しい効果を止めるだけで元証拠を消さず、既存ticketの終端入力も保存できる。closeはcancelやquiescenceではない。
Dropは単なるモデルメモリ破棄であり、native resourceを持たない。productionのowner Drop安全性をこの試験で証明しない。
モデル保存／restore、registry永続化、retire／GC、seal、rearmは今回追加しない。
ID墓標と本文はmodel終了まで保持する。本文を保持できないほど容量が詰まれば新受付を止め、古い証拠を暗黙削除しない。

## 8. prep2aの有限資源

ModelLimitsは下表の上限以下への縮小だけを許す。ゼロcapは境界試験として許してよいが、bytes上限の加算／控除はcheckedで行う。

| 資源                           | prep2a上限                             |
| ------------------------------ | -------------------------------------- |
| mutation admission ID          | 4096                                   |
| reconciliation admission ID    | 独立4096、wire namespace衝突は横断照合 |
| mutation/read lease request ID | 各4096                                 |
| 未消費lease                    | mutation/read各4                       |
| admission inspection ID        | 4096                                   |
| CallInspection ID              | 独立4096                               |
| 未終端dispatcher               | 1                                      |
| 本文・返信・予約の保守bytes    | 合計8MiB、うち2MiBを回復read専用に予約 |

read専用はread admission／read lease／両inspectionに使用し、mutationから消費しない。readは専用枠内だけを使うと決め、残余共有枠を使う複雑な借入は初回導入しない。
親設計のhost全体16MiB／複数scope allocatorはprep2b以降であり、単一モデルの8MiB検証をhost全体保証と呼ばない。

会計は既存scada-model::recording_wireで提供する `conservative_recording_json_bound(&Value, WireBound) -> Result<WireBound, RecordingWireError>` を使う。既存measure／JsonBudgetを再利用し、caller limitが4MiB／196608nodes／depth96以下であることをwalker開始前に検査する。これは構造metricsだけでありschema・native資格の検証ではない。既存validatorの予算・意味は変更しない。

prep2b4aでadmissionの保持予約を[要求由来のlifetime上界](historian-recording-registry-workflow-model.md#6-tight-lifetime上界)へ統一した。元request、knowledge／terminalの各保守上界とcompletionを個別に予約し、discardにcompletion枠を加算しない。独立したcurrent knowledgeとimmutable terminal replyを両方保管でき、unknown返信後のlate proofも予約を取り直さず保存できる。未確定枠も早期解放しない。余剰返却／retire／GCはprep2aでは実装しない。
leaseは既知issued reply＋元requestの実測を原子登録前に計数する。inspect_admissionもその時点で構築したsnapshot reply＋元requestの実測を計数し、後のknowledge更新でその元replyを変更しない。
CallInspectionはrequestのID binding実測だけを保存し、既存terminalを参照して返す。毎回4MiBのreplyコピーを永久保存しない。一時返却値はwire上限4MiBで別に有限化し、retained 8MiBと同じ会計だと主張しない。
同値再送／二重proof／二重終端でID・bytesを二重課金しない。新proofが矛盾する場合は元証拠と会計を変えず拒否する。4096件は件数上限であって全件収容保証ではない。
byte計数は構造JSON payloadの上界でありBTreeMap／Arc等のallocator実消費と同一ではない。件数capで固定管理overheadも有限化する。
最大reply予約がread専用枠へ収まらない要求はCapacityで停止する。最大profileサイズを実要求サイズと混同せず、使用可能なhelperの保守上界を採用する。

後続の[prep2b4設計](historian-recording-registry-workflow-model.md)で4admissionと2caller operation、将来lease／保持bytes／projection／revisionの予約を具体化した。旧固定予約の単純4倍ではmutation6MiBを超えるため、既知要求に基づく保持上界へ変更した。Workflow modeの最初の一候補は全段階予約と明示pause／apply／discardを提供する。下記の保守停止はStandalone modeに維持する。

**workflow3stage分のID／bytesの事前credit予約はprep2aで実装しない。** 単一callの原子予約を試験し、Accepted後の継続を止めることで未実装の予約保証を必要としない。
prep2bでphase進行を解禁する前に、preflight／pause／apply／discard credit、callerOperation pool、reconcile poolとnative c2別cap拒否を追加設計・受入する。
この違いは親wire設計のproduction要件を緩和したものではなく、モデルの提供段階の制限である。

## 9. prep2bの接続点（結果観測・取消・購読は実装済み）

結果観測はprep2b1でfake operation／read handleごとの不変completionを保持し、元call terminalとは別のread-only protocolとして実装した。read Acceptedは既存apply handleに束縛し、read結果から元applyの静止・回復解除を推測しない。
cancelはprep2b2でfake通知をhandleごと高々一回記録し、requestedを完了へ変換しない。元cancel replyはfinish後にCallInspectionから取得できる。
結果projectionではreceipt／quiescence／sticky recoveryを独立させ、receiptFoundでunknown静止をconfirmedへ変更しない。

snapshot／subscriptionは同じ逐次gateで購読登録とrevision Rのsnapshotを原子取得する。
prep2b3で購読slotはstate1＋control1、coalesceは完全snapshotだけとして実装した。ACK前frame、遅いsubscriber、detach／reconnect、不変旧snapshotを仮想手順で試験する。受信側の並べ替え・同revision矛盾検出は後続clientの別工程である。
frameだけで元call terminalを埋めない。Observation／Cancelに加えAttach／Controlも実model遷移へ接続した。
新scopeを作って旧unknownを消す便法を置かず、closed／epoch交代／Unknownの表示根拠を保持する。

## 10. 直近PRと受入

prep2aの一PRはRustモデルmodule、private遷移表、仮想時計scenario、期待JSON transcript、既存wire validatorでの出力確認までとする。
TSへ第二の権威registryを作らない。browserは同じ期待DTO fixtureを既存validatorで確認し、Rust状態遷移の実行やnative接続があるとは主張しない。
scenarioはRust入力命令（advance／issue／begin／proof／finish／inspect／close）と期待結果を持ち、wire schemaに試験命令を追加しない。

| 受入       | 必須確認                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------ |
| 仮想時計   | 同値／前進／逆行sticky、期限直前／同値、overflow、late exact lease replayは期限延長無し          |
| binding    | 同文字ID別principal／epoch、role偽装、同ID別本文、member順差、整数同値                           |
| 原子受付   | ID／bytes／slot不足で一切消費無し、Registeredは一回、Pending／Replayで決定再投入無し             |
| 二つの真実 | 元unknown終端不変のままknowledge Accepted、元reply照会と最新受付照会の差                         |
| 正常再送   | Rejected／Discard終端のexact replay、失効後既登録admission replay、異なるfake proof拒否          |
| 応答喪失   | begin後未finish、proof後未finish、finish後未配送、frame代替無し、notFound後着非解除              |
| 回復枠     | mutation ID／bytes満杯でも独立read照会可能、read自身枯渇は有限停止                               |
| 容量       | exact／1不足、固定予約維持／二重課金無し、全IDcap、複数lease4上限                                |
| 未実装gate | Accepted後新mutation拒否／fake read登録可、未対応CallInspection originalはunavailable、reset無し |
| 終了       | close後新効果拒否・元ticket終端／read維持、別model ticket拒否、旧epochへの自動再送無し           |

実lease／認証／runtime取消／native物理join／SQL原子性／network backpressureは今回のモデル試験の保証外である。
実adapterは[P3b](transport-boundary.md)と[wire／host設計](historian-recording-wire-host.md)のgateを満たし、prep2bの不足境界も閉じてから別PRで接続する。
