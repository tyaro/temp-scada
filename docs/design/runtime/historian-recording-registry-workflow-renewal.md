# Historian registry workflow renewal model

- 設計日: 2026-11-04 JST
- 段階: H5d4c4c-prep2b4b。純粋Rustモデル実装済み（2026-11-05 JST）。実接続は後続。
- 前提: [workflow model](historian-recording-registry-workflow-model.md) のprep2b4aを維持する。
- 対象: Rustの決定的な純粋simulation modelのみ。native dispatch、実時計、SDK、DB、host、認証、transportは追加しない。
- Project 0.37.0、DB7、H1、wire/schema、固定依存を変更しない。P3b保留は解除しない。

## 1. 採用する区切り

同一modelの同一scope/context内で、正常に終端したworkflowから新しいchangeを明示受付できるようにする。
旧workflowを上書きしてcapacityやrecoveryをリセットする機能にはしない。
元admission call、現在knowledge、operation completion、read completion、cancel call、observationの各軸を維持する。
正常終端だけでは自動で次preflightを発行しない。新workflowにも4stage全予約を必要とする。

本段階は一PRで実装可能な台帳・gateの拡張とする。次の機能は含めない。

- 新しいrecording run/sessionへの切替、SDK再解決、recording resume。
- unknown/recovery/clock fault/closedの解除、記録済みIDや本文のGC。
- 実nativeのRunning/cleanJoined判定、reader/workerの実join、実資源予約。
- host間handoff、process再起動での永続台帳復元、UI/transport接続。

## 2. native根拠とsimulationの限界

`recording_host/supervisor/operations/mod.rs`のpreflightは、ownerのIdleまたはCompletedでのみ受理する。
`Shared::locked`はclosed、in-flight、read Uncertain、recovery、Supervisor不在を拒否する。
`driver.rs`はhealthy candidate/paused以外をCompletedへ移し、旧workflowの未使用native creditを返却する。
Candidate/Pausedのdiscardは実Supervisorのdiscard成功後にIdleへ移す。

さらにSupervisorの`recording_operations_context`は、現在Runningまたは正常Joined、同run/session、reader健全性、pending candidate、retention/plan turnと各latchを検査する。
そのためownerのCompletedという表示だけで次native preflightの成功を保証できない。

本modelの資格はcallerが明示するsimulation入力にすぎない。毎回同runの資格を宣言させるが、nativeの検査を行った証拠とは称さない。
後の実adapterはその時点のnative gateを再実行し、typed Rejectedも正常な結果として扱う。

## 3. 正常終端と次候補の関係

| 元workflowの根拠                                             | 次workflowの受付 | 同runの扱い                                                             |
| ------------------------------------------------------------ | ---------------- | ----------------------------------------------------------------------- |
| preflight Replay、confirmed、recovery=false、元call終端      | 可               | recordの開始/停止を推測しない。現在RunningまたはCleanJoined宣言が必要   |
| preflight healthy failed、confirmed、recovery=false          | 可               | 実sourceが健全とは推測しない。宣言と後のnative gateを分離               |
| Candidateから正常discard、元discard call終端                 | 可               | pauseしたとは扱わない。Running/CleanJoinedの現在宣言                    |
| Pausedから正常discard                                        | 可               | 同runのCleanJoined宣言を要求。自動resumeなし                            |
| applyの正常applied、confirmed、recovery=false                | 可               | 同runのCleanJoined宣言を要求。appliedは新録画開始ではない               |
| Accepted後のhealthy failed/notDispatched                     | 条件付き可       | Completedを維持し、旧Candidate/Pausedへ戻さない。現在の管理資格を再宣言 |
| typed RejectedでCandidate/Paused/Reservedを維持              | 不可             | 元workflowのretryまたは許可されたdiscardのみ                            |
| 未終端call、Accepted completion未到着                        | 不可             | 元の処理を忘れない                                                      |
| unknown quiescence、未確定knowledge、readUncertain、recovery | 不可             | receiptFoundやcancel ackでも解除しない                                  |
| close、ClockFault                                            | 不可             | model内のreset/rearmなし                                                |

model全体にstickyな`ever_clean_joined`を保持する。初回`new_workflow`のCleanJoined宣言、成功したrenewalのCleanJoined宣言、正常paused completionの保存のいずれでもtrueとし、falseへ戻さない。
一度でもtrueになった同runの後継資格はCleanJoinedのみとする。自然完了Joinedからも、正常pause後からも、Runningへの復帰を宣言だけで認めない。新しい宣言の拒否や失敗したrenewalでは、このflagを含む旧stateを変更しない。
新runの録画開始は別の管理境界であり、このmodelにcontextを上書きするAPIは作らない。

healthy failedがpauseより前か後かは元の保存証拠から決める。failedというenumだけでJoinedを生成しない。pause/applyのhealthy failedはpure DTOとして合法でも、実nativeでは多くの失敗がrecovery=trueとなる。モデルで受理できる結果から実nativeの回復資格を推測しない。
自然完了したrunをCleanJoinedと宣言することは可能だが、CandidateからapplyへpauseJoinを省略できるようにはしない。

## 4. API

既存`new_workflow`、初回`reserve_workflow`、stageのissue/begin、proof/completion APIを維持する。
次の専用入口を追加する。

```rust
pub fn reserve_next_workflow(
    &mut self,
    session: &ModelSession,
    predecessor: &WorkflowTicket,
    qualification: SimulatedRunQualification,
    change: RecordingChangeRequest,
) -> Result<WorkflowTicket, ModelError>;
```

WorkflowTicketは従来どおりprivate Arc identity、sequence、changeIdを保持し、Deserializeしない。
qualificationのUnqualifiedは新受付をForbiddenとする。
Running/CleanJoinedの宣言はscope/contextのrecordingRunRef/sessionIdと同じrunについてのみ有効とする。`ever_clean_joined=true`で新規renewalにRunningを指定した場合はForbidden。過去Runningで成功したrenewalのexact再送は保存結果の照会なので許し、flagを戻さない。

`reserve_workflow`は初回予約とそのexact再送のみ。新changeでの暗黙renewalは許さない。
`reserve_next_workflow`は次の順に検査する。

1. session/principal/scope/context、predecessorのmodel instance帰属を検査。
2. 新changeIdが保存済みなら、本文・保存predecessor・qualificationの全てを照合して同ticketを返す。
3. 新規IDならpredecessorが現在workflowであることと正常終端・全gateを検査。
4. qualificationの整合、全累積pool、bytes、projection highwater、revision/sequenceを検査。
5. 新recordとpredecessor link、予約、currentポインタを一度だけcommitする。

exact再送はclose後でも保存結果を返せるが、新しい効果を発生させない。
本文同値は既存helperでobject順/整数表記を同値、member配列順を厳密一致とする。
同ID別本文・別predecessor・別qualificationはProtocolViolation。
別modelのticketはForbidden、存在しない改変ticketはInvalidInput、現在でない有効predecessorから新changeへの分岐はBusyとする。

初回reserveでRenewal生成recordの同changeIdを指定した場合、またはrenewal入口でInitial生成recordを指定した場合はProtocolViolationとする。creation kindも再送照合に含め、現phase/currentのgateより前に照合する。
過去の初回reserve再送と過去renewalのexact再送は現在workflowを切り替えない。
新changeIdでも同じdesired内容を指定できる。既存DB receiptを返すかは後のsimulated preflight結果で決まり、reserve段階では推測しない。

## 5. currentと永久台帳

WorkflowModeは単一recordから、有限のchange台帳とcurrent参照へ拡張する。

- `workflows: BTreeMap<changeId, WorkflowRecord>`、最大workflow_changes件。
- `current: Option<changeId>`。最初の受付前だけNone。
- 各recordにcreation kind（Initial/Renewal）、sequence、元change、predecessor sequence、資格宣言、attempts、未使用slot、native credit、release済みflagを保持。
- admissionIdから所属workflowへの索引、または同じ上限内の有限検索でproof/completionを解決。
- caller operation ID、fake native identityの使用済み集合はmodel全体で照合する。client/nativeの会計poolは別のまま、caller/生成operation IDの異なる操作への再束縛はscope寿命のunionで拒否する。
- changeRefはAccepted preflightごとに全歴史workflowとの一意性を検査する。同じproofのexact再送以外で旧changeRefを異なるchangeへ再束縛しない。operationRef/readRefの既存global一意性も維持する。

旧record、元要求、attempt binding、消費済みID、元call terminal、knowledge、completionは不変保持する。
旧ticketを新currentと読み替えない。workflowsの最大4096は実際に4096件がbytes内に入る保証ではない。
小さい正常workflowでも累積bytes等に先に到達したらCapacityで停止する。

stage APIで旧ticketに届いたexact再送は、保存されたlease/admission結果だけ返す。
旧ticketで新lease/new attempt/stageを始めることはBusy。
proof/finish/completionの既存private ticketは保存recordを指し続ける。currentを暗黙参照して更新しない。

## 6. renewal gate

次の全てを満たす場合のみ新workflowを受理する。

- currentがCompletedまたはDiscardedであり、対応する元callが終端済み。
- modelがopen、clock健全、sticky recovery=false。
- 全admission dispatcherが終端済み。未知knowledgeの保存recordが残っていない。
- 全Accepted operation/read handleのcompletionが保存済み。元operationのquiescenceはconfirmed。
- readUncertainなし。read resultの元operationのquiet/recoveryを勝手に昇格していない。
- pending observationはoperation/read両roleで0。completion先着だけでslotを解放せず、明示observe retrievalを必要とする。
- pending cancel callが0。notify済みでもfinish_cancel_call未完了なら不可。
- 現在の資格がRunningまたはCleanJoinedで、ever_clean_joined=trueならCleanJoined。

call inspection/admission inspectionは本modelでは同期readであり、保存pending結果を物理処理中のcallと混同しない。
attach/controlも同期APIである。購読自体、未取得latest state/control frame、保存call-inspection IDはrenewalを妨げない。
それらの台帳とread bytesは保持する。将来async adapterではモデル外の未完了read callを別途gateする。

未消費leaseが期限内でも、旧終端workflowから新効果を作れないようcurrent ticket gateを優先する。
旧lease期限を延長せず、そのID/bytes/attemptの使用記録を保持する。
leaseの存在をactive workerと誤認しない一方、旧stageへのdispatch許可として利用しない。

このgateはnative ownerより保守的に、model内のpending observation/cancelも待つ。
nativeの実worker数を表すとは称さない。型付きcancel ackはoperation静止やrollbackの証拠ではない。

## 7. 累積資源と失敗原子性

新workflowもb4aと同じ4stage全予約を行う。

| 資源                     | renewal時の規則                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------- |
| change ID                | 過去used＋新1が上限内。過去changeの再使用不可                                           |
| mutation admission/lease | 全workflowのused＋残reserved＋新4を確認                                                 |
| caller operation         | 全workflowのused＋残reserved＋新2。過去生成native opとの衝突も証拠受付で拒否            |
| fake native identity     | 全used＋残reserved＋新4。実native registryの予約保証ではない                            |
| bytes                    | 全使用済みL/lease/change保持費＋新4L/4lease/change予約。read2MiB借入なし                |
| projection               | 過去highwaterと新全stage上界のcomponent-wise max。縮小しない                            |
| revision                 | current revision＋全残reserved＋新11がceiling内。close1はmodel開始時の1を維持           |
| read                     | 独立reconciliation/admission/cancel/observation/inspection/subscriptionの既存制約を維持 |

過去正常終端で返却できるのは未発行stage slotだけ。使用済みattemptのL、ID、残publication creditをrenewalで再利用しない。
未発行native reserved creditの返却は一回だけ。used native identityは保持する。
close creditをworkflowごとに追加/返却しない。exact再送とphaseだけの変化ではsnapshot revisionを増やさない。

新recordのpredecessor link等の追加管理情報は1workflowあたり固定1024bytesをmutation予算へ課金する。
初回workflowにも同じchargeを適用し、旧exact fixtureはこの差分を明示更新する。
本文は既存WorkflowRecord/AdmissionRecordへ参照し、renewalのために過去JSONを重複複製しない。
これはmodelの保守的な保持会計でありallocatorの厳密なheap測定ではない。

全候補の検証が完了するまで旧current、old release flag、統計、sequence、subscription queueを変更しない。
Capacity/Forbidden/Busy/ProtocolViolationのどの場合も旧workflowを有効なまま残す。
rootが複数recordへ移る実装では、reserve/issue/proof/completeの局所計画を先に組み立て、commit後に失敗し得る検証を置かない。

## 8. projectionと後着

reserve_next_workflowだけではOwnerSnapshotのadmission/operation/readを消さない。
新admissionが実際に登録された時に既存sequence規則で最新admissionを選ぶ。
新Accepted operationはそのcompletion前からoperation headを切り替えられる既存規則を維持し、旧receiptを新operationの結果に付け替えない。

古いworkflowのexact proof/completionは冪等で、revisionも追加消費しない。
正常renewalには全proof/completionが確定しているため、新たな矛盾証拠はProtocolViolationで原子的拒否となる。
元callのunknown terminalは後で書き換えない。先に確定knowledge/completionが到着してgateを満たした場合のみ、unknown terminalを保存したままrenewalできる。

native c3はcurrent original applyのみを新reconciliationの対象にする。ここでのcurrent制約は新workflow予約時に更新するmodelのlogical currentであり、reserveだけでnative側のcurrentが移動した証拠ではない。本Workflow modeでも新read admissionを現在workflowの既存Accepted applyへ限定し、operationRefと元OperationRequest全文を照合する。renewal後の歴史applyへの新read admissionはProtocolViolationとし、後のAccepted proof登録でも同じ帰属を防御的に検査する。Standaloneの低レベル契約は変更しない。
既登録readのexact admission再送、observe retrieval、call inspection、private ticketによる保存証拠の回収は許す。これらからpending/readUncertain/recoveryが判明した時は現在workflowの全新mutationへglobal gateを適用する。
過去readのreceiptFoundで現在workflowや元immutable operationのphaseを正常化しない。
現在workflow以外のrecordを探すためにSnapshotDescriptorの過去参照を破壊しない。

## 9. fresh scope/runが必要な境界

同scope/contextのrun/sessionを変更するAPIは追加しない。
実recording resumeで新session/clock epoch/runを作る場合は、将来の管理handoff/owner作成契約を通す。
新scopeを作れば既存unknown/recoveryを解除してよい、という意味ではない。
その移管元の静止・sticky gate・保持証拠の移送はnative owner設計の責務であり、b4bは実装しない。

本modelでClockFault/closedになったinstanceは新workflowを受けない。
別simulation instanceは独立試験であり、実process復旧の許可証明ではない。
同文字列scopeで二つのmodelを作った時にwire JSONだけから同一ownerを証明できない、という既存制限も維持する。

## 10. 受入と実装順

1. change台帳/current分離、全累積counter、固定管理charge、ticket lookupを実装。既存Standaloneはmode変更なし。
2. reserve_next_workflowと全gate、同run ever_clean_joined履歴、atomic escrowを実装。
3. 既存scenarioを明示的に移行し、新renewal scenario/境界試験とwire transcript検査を追加。

| 受入        | 必須例                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 正常        | Replay→新preflight、Candidate discard→次、Paused discard→次、正常apply→次                                                            |
| failed      | 各stage healthy failed→Completed→次、typed Rejectedから次renewal不可                                                                 |
| 資格        | Running/CleanJoined、Unqualified拒否、初回CleanJoined／Running→CleanJoined renewal／正常pausedの各後でRunning拒否、同context違い拒否 |
| current     | 古いpredecessor分岐拒否、旧ticket新stage拒否、過去exact再送がcurrentを変えない                                                       |
| 三軸        | completion先着/未終端call、unknown terminal＋late proof/complete、確定後の矛盾拒否                                                   |
| read/cancel | pending両role observation、finish前cancel、readUncertain、receiptFoundでもsticky維持、歴史applyへの新reconcile拒否と既登録exact回収  |
| 資源        | 全pool exact/1不足、累積bytes/revision/projection不足時旧current不変、read枠独立                                                     |
| ID          | 過去caller/native/change/admission/lease/reconciliation IDとchangeRefを別workflowで再利用拒否                                        |
| 購読        | attach継続、renewalだけでframe/revision不変、後の新admissionでlatest1更新                                                            |
| 終了        | close/ClockFault/recoveryで不可、exact再送のみ可、close credit再予約なし                                                             |

b4aの「正常終端後も次workflow禁止」fixtureは、初回reserve APIによる暗黙更新禁止として維持する。
新専用APIを用いた正常renewalは別caseにする。Standaloneの直接apply等をstrict workflow試験へ偽装しない。
固定管理chargeによる既存会計期待値の変更は、schema変更や記録保証の変更と混同しない。
Rust scenarioが唯一のstate権威であり、TS/browserは同じ出力を既存wire validatorで検査するだけとする。

## 12. 実装と検証の区切り

`recording_registry_model/workflow/renewal.rs`へ初回・次workflow予約、有限履歴台帳の累積予約、全静止gateとcurrent apply限定の新read検査を実装した。`workflow/mod.rs`は旧ticketの正確な再送と新規操作を分け、proof／completionは元recordへ保存する。初回を含む各workflowへ管理費用1024bytesを追加し、旧recordと使用済みcaller／native IDの衝突をmodel寿命全体で拒否する。

共有50シナリオ947ステップ・10境界試験を追加した。既存239シナリオは初回管理費用の期待だけを反映して維持する。154期待DTOと全入力をTS／browserの既存validatorへ照合し、累積escrowの独立会計と通常App保存不変を確認する。実行権威はRustだけであり、TSに第二のregistryは追加しない。Astraの最終read-onlyレビューに残る必須所見はない。複数scope allocatorと受信frameの順序・矛盾検出、実adapter／host接続とP3bは後続である。
