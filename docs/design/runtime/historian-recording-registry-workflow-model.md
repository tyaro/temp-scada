# 記録registryモデルのworkflowと全段階予約

状態: **prep2b4a／b4b純粋モデル実装済み、実接続は後続**。2026-11-05（日本時間）。主設計はユーザー指定のAstra。
[subscriptionモデル](historian-recording-registry-subscription-model.md)までがPR #76で統合済み。本書はその後の段階進行を設計する。
Project 0.37.0、DB7、H1、wire schema、SDK／Banto／依存は維持する。実native、host、DB、auth、transport、P3bへの接続は行わない。

## 1. 設計PRを分ける理由

Standalone modeはAcceptedが残る限り新mutationを保守的に拒否する。prep2b4aで追加したWorkflow modeは、本書の予約と明示段階進行を必要とする。
これを単純にcompletion後解除すると、異なる元runや候補の混入、apply失敗後の誤retry、discard資源の消失を招く。
prep2b3までの固定予約はmutation一件につきrequest＋2×512KiB＋958464bytesであり、4stageを予約するとmutation専用6MiBへ収まらなかった。prep2b4aは両modeを要求由来の保持上界へ統一した。

**先に要求由来のtight lifetime上界と4stage escrowを確定し、その後にphaseを解禁する。**
cap拡大、read2MiB借入、applyとdiscardの排他的max予約は採用しない。
applyがtyped Rejectedとなった後も元Paused候補を明示discardでき、その両方の元replyを保持する必要があるためである。

実装PRはprep2b4a（最初の一workflowと全段階予約）、prep2b4b（正常終端後の次workflow受理）に分ける。
最初から正常結果を根拠に自動apply／resumeするcontrollerを作らない。

## 2. nativeとの対応と限定

根拠は[native owner](../../../crates/scada-runtime/src/recording_host/supervisor/operations/mod.rs)のnext／lockedと[driver](../../../crates/scada-runtime/src/recording_host/supervisor/operations/driver.rs)の終端分類である。
CandidateからpauseJoin、Pausedからapplyだけを許し、discardはCandidate／Pausedだけとする。
受付前typed拒否は元phaseを維持するが、Accepted後のfailed/notDispatchedを元候補へ戻さない。
正常confirmed／recovery=falseでもcandidate／paused以外のcompletionはCompletedであり、再apply資格ではない。
unknown静止、readUncertain、recovery、未終端call、closeを無視してphaseを進めない。

モデルは元contextのrecordingRunRef／sessionIdを宣言として照合するだけで、実Running／cleanJoinedを調査しない。
起動時に試験が与えるSimulatedRunQualificationを明示し、実SDK、cleanup、writer所有の証明と称さない。
DB applied CAS、同一計画のnative receipt再送、認証、UIの現在owner資格も既存層の責務で、モデルが代替しない。

## 3. 提供modeとAPI

既存RegistryModel::newはStandaloneとして現行の保守gateを維持する。
workflow modeは別constructorで明示し、作成後のmode切替やforce resetを設けない。

```rust
pub enum SimulatedRunQualification { Running, CleanJoined, Unqualified }
pub enum WorkflowAction { Preflight, PauseJoin, Apply, Discard }
pub struct WorkflowTicket { /* private Arc instance + sequence + change ID */ }
pub struct WorkflowAttemptIds { pub operation_id: Option<String> }
pub enum WorkflowPhase {
    Reserved, Preflighting, Candidate, Pausing, Paused, Applying,
    Discarding, Completed, Discarded, Blocked, Uncertain,
}
impl RegistryModel {
    pub fn new_workflow(session: ModelSession, limits: ModelLimits,
        qualification: SimulatedRunQualification) -> Result<Self, ModelError>;
    pub fn reserve_workflow(&mut self, session: &ModelSession,
        change: RecordingChangeRequest) -> Result<WorkflowTicket, ModelError>;
    pub fn issue_workflow_lease(&mut self, workflow: &WorkflowTicket,
        stage: WorkflowAction, ids: WorkflowAttemptIds, request: RecordingWireLeaseRequest)
        -> Result<RecordingWireLeaseReply, ModelError>;
    pub fn begin_workflow_admission(&mut self, workflow: &WorkflowTicket,
        request: RecordingAdmissionRequest) -> Result<AdmissionStart, ModelError>;
}
```

既存observe_native／finish_admission_call／complete_handleを使って試験の証拠を入力し、同じ原子publicationを通す。
WorkflowTicketはDeserializeなし、別modelや異なるchangeへ転用できない。
workflow modeの通常begin_admission／issue_leaseでmutationを発行する迂回を拒否する。read用入口は別poolを使う。b4bのWorkflow modeでは新readをcurrentのaccepted applyへ限定し、旧readの正確な再送・回収は保持する。Standaloneの低レベルread制約は維持する。
reserve_workflowは純粋モデルの予約で、native受付・preflight開始・停止・書込ではない。
同sessionの同changeId・全文同値の再呼出しは同じWorkflowTicketを返し、追加課金しない。異本文はProtocolViolation、別modelのticketはForbidden。別changeIdはb4aでは既存予約がある限りBusy。
予約放棄／clear APIは初回に設けない。Reservedで資格や容量を失った場合は有限停止し、証拠照会だけを残す。modelを破棄できてもnative解除や製品上の復旧を証明したとは扱わない。

b4aは最初のworkflowを一つだけ受け入れる。Completed／Discarded後も新workflowは未対応として拒否する。
実装済みb4bの専用APIで終端根拠・ID／bytesの残量・run資格を再検証して次workflowを許す。旧recordのGCを暗黙前提にしない。

## 4. 固定する元意図

予約時にchange全文／contextをownedで保持する。desired、expected applied/mapping/retention版、requestId、member順を後続stageで変えない。
同context／run／sessionの完全一致を必要とし、別Projectや別runの候補へticketを付け替えない。
preflight Acceptedから得たchangeRefとOperationRequestを保持し、後続actionのchangeRefをその値へ照合する。
pause/applyのOperationRequestは元change全文と明示stageを共有し、operationIdだけを新しく与える。
Discardは元changeと同changeRefを要求する。新mapping解決、初期Idle bootstrap、fresh SDK resumeはこのcapabilityに含めない。

SimulatedRunQualificationがUnqualifiedなら予約前拒否する。
Running／CleanJoinedはどちらもpreflightできるが、Candidate後は自然完了を理由にpauseJoinを省略しない。
Paused結果のsessionIdは元context.sessionIdへ一致させ、元runはそのworkflow中immutableである。

## 5. 三軸からphaseを決める

元admission dispatcher terminal、受付knowledge、operation completionを別々に保持し、どれか一つで全体完了と扱わない。
新stage送信は元callが正常terminalを持ち、knowledgeが確定し、必要なcompletionがある場合だけである。
元callのunknown返信は不変で、後にAccepted知識とcompletionが判明しても書き換えない。
unknown返信が正常terminalとして保存されていることと、受付knowledgeの未確定は別である。
優先順位はclose／sticky recovery・readUncertain等の安全gate、元call未終端の進行中phase、元call終端後のknowledge未確定Uncertain、確定knowledgeとcompletionによるphaseの順とする。begin直後のRegisteredだけでUncertainへ変更せず、unknown正常terminal後もknowledge未確定の時にUncertainを表示する。安全gateはphase名とは別に全送信入口で検査する。close／ClockFaultはBlockedを優先する。sticky recoveryがある場合も基本はBlockedとし、元call終端後にunknown completionを保持する場合だけUncertainへ分類する。正常completion先着だけで元call終端前に次stageを許さない。

| 現stage／証拠                                                        | 次phase／許可                                           |
| -------------------------------------------------------------------- | ------------------------------------------------------- |
| 予約のみ                                                             | Reserved。明示preflightだけ                             |
| call未終端、またはAccepted completion未到着                          | 対応する進行中phase。新mutation不可                     |
| knowledge未確定                                                      | Uncertain。read照会のみ、後着の同ticket証拠で再評価可能 |
| preflight typed Rejected、元call終端済み                             | Reserved。新IDによる明示再試行は追加枠を要する          |
| preflight candidate、confirmed、recovery=false                       | Candidate。pauseJoinまたはdiscardだけ                   |
| preflight replay／その他正常終端                                     | Completed。pause/apply不可                              |
| pause typed Rejected、元call終端済み                                 | Candidate維持。retryまたはdiscard                       |
| pause paused、confirmed、recovery=false、元session一致               | Paused。applyまたはdiscard                              |
| apply typed Rejected、元call終端済み                                 | Paused維持。retryまたはdiscard                          |
| apply applied、confirmed、recovery=false                             | Completed。自動resumeなし                               |
| Accepted後failed（notDispatched等を含む）、confirmed、recovery=false | Completed。元Candidate／Pausedへ戻さない                |
| completionのquiescence=unknown                                       | Uncertain。receiptがあっても新mutation不可              |
| recovery=true／readUncertain                                         | Blockedまたは静止不明ならUncertain。clear APIなし       |
| discard CompletedDiscard、元call終端済み                             | Discarded。記録再開はしない                             |
| discard typed Rejected、元call終端済み                               | 直前Candidate／Pausedを維持。retryには追加枠            |

モデルのread completionがreadyなだけでは、未回収の観測slotや元read admission callを終了させない。
phaseがCandidate／Pausedでも、read未確定／readUncertain、現在のdispatcher、close、ClockFault、recoveryによるgateを別に確認する。
read receiptFoundで元operationのimmutable結果を合成し直してphaseを正常へ変えない。

## 6. tight lifetime上界

JSON metricsは既存保守計数を使う。元要求の内容は固定されており、未知fieldはID／enum／安全整数／小さなreceiptに限られる。
qをAdmissionRequest実測、hを最大AcceptedRef.request実測、Eを64KiB／4096nodesの固定包絡とする。

| 保持要素                    | 保守上界（bytes／nodesそれぞれ） |
| --------------------------- | -------------------------------- |
| current knowledge reply K   | q＋h＋E                          |
| 元call terminal reply T     | q＋h＋E                          |
| operation completion C      | h＋E                             |
| reconciliation completion C | 2h＋E                            |
| discard completion C        | 0（handleを持たない）            |
| 一admission lifetime L      | q＋K＋T＋C                       |

Tはunknown返信とKが異なる場合も別々に保管する。本文共有を仮定して容量を過小算出しない。
OperationResultのlegacy compact予算とwireの独立予算は引き続き検査する。tight boundは既存rootの上限変更ではない。
包絡の根拠とdepthは[projection設計](historian-recording-registry-subscription-model.md)の有限branch方式を共用する。
全schema branchの未知部分を独立fixtureで計測し、helper自身だけをoracleにしない。
実現可能性の参考として、既存recording-registry-model-cases.jsonの通常changeと最大64文字の将来ID/refを用いた独立保守bytes試算では、旧4stage予約約8,036,105bytesに対しtight lifetime合計756,293bytes（lease等別）となる。これは全合法入力の収容保証ではなく、通常候補の一例である。実装受入では同じ式とfixtureから再計算し、全追加escrowを含めて6MiB内か検査する。

この変更は既存prep2a固定2MiB方式からのモデル会計変更として明示する。Standaloneも同helperへ統一し、既存exact byte fixtureの期待値を更新する。
reply／completion保存は受付時L以内で行い、Accepted後に容量不足で証拠を捨てない。
モデル寿命中、使用済みrecordのLを返却しない。GC／retireによる返却は未実装である。

## 7. 4stage escrow

reserve_workflowは将来stageのrequestを最大64 ASCIIの未知ID/refで構築して、preflight／pause／apply／discardのLを全て合算する。
未知admissionId、deadlineLeaseRef、operationId、changeRef、leaseRequestIdを最大長で予約し、実値の短さに依存しない。
4件すべてを別に保管できる予約であり、applyとdiscardをmaxにまとめない。

| 資源                          | 最初の予約                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| mutation admission ID         | 4credit（各初回stage）                                                                      |
| mutation lease request ID     | 4credit（各初回stage）                                                                      |
| caller operation ID           | pause/apply用2credit、preflight生成IDは別扱い                                               |
| change ID                     | 1credit、同ID別本文不可                                                                     |
| fake native identity capacity | change＋generated preflight＋pause＋applyの計4credit                                        |
| mutation bytes                | 全4stage L＋全4leaseの元request/issued reply上界＋workflow元change保持分＋管理費用1024bytes |
| projection                    | 全将来stageのhigh-water boundを先に合成し1MiB等を確認                                       |
| revision                      | preflight3＋pause3＋apply3＋discard2の計11credit。close1は既存別予約                        |

prep2b4aでreadAdmissionとは別のreconciliation ID台帳を実装した。ModelLimits.reconciliation_ids（最大4096・縮小のみ）を追加し、Standalone／Workflow両modeの新read admission登録時にreadAdmission ID・bytes・revisionと原子的に確認／登録する。mutation escrowやcaller operation枠へ依存させない。
reconciliationIdは元ReconciliationRequest全文とadmissionIdへ束縛し、同admissionIdのexact Pending／Replayは既存入口で返して再登録しない。異なるadmissionIdで同reconciliationIdを使う要求は、本文同値でもProtocolViolationとする。このモデルでは同readの複数admission共有を実装しない。新たなreadを明示する場合は新reconciliationIdを必要とし、元不明readの自動再dispatchを許可しない。
台帳は元本文を既存AdmissionRecordへ不変参照し、JSONを重複保管しない。ID／参照の管理overheadは1件256bytesの固定上界をread予算へ原子課金し、最大4096件をmodel終了まで保持する。read自身のpool／bytes枯渇は有限停止であり、native c3の実4096枠を予約した証拠ではない。未知／拒否／完了という結果でIDを再使用可能にしない。

fake native identity capacityはモデルの有限比較用で、既存native registryの実枠を予約したことにはならない。
frontend role別4096とnative change＋operation合計4096を同じ数として扱わない。後のSimulatedDecisionがCapacity等でRejectedとなることは依然可能である。

ModelLimitsの新poolはworkflow_changes、caller_operation_ids、simulated_native_identitiesとし、各上限4096・縮小のみを許す。既存mutation_admissions／mutation_leasesにもused＋reserved合計で4096以下を適用する。新poolの上限はrecords.lenだけで判定しない。
workflow change IDはreserve_workflow成功時にusedへ入り、4stageの将来枠はreservedとなる。exact reserve再送では増えない。
初回issue_workflow_leaseは、lease IDとadmission ID、pause/applyならWorkflowAttemptIds.operation_idを当該attemptへ原子的にbindする。この時点で対応client ID creditをused（使用禁止tombstone付き）へ移す。operation_idはpause/applyのみSome、preflight/discardはNoneを要求する。後のbeginはこのadmissionId／operationIdを照合し、予約をrecordsへ移すだけで追加ID課金しない。
このためcallerOperationの消費点は本設計ではbeginより早いlease発行時とする。未dispatchの期限切れattemptでもIDは再使用できず、used件数は登録済みadmission件数と一致しない。

simulated_native_identitiesはproofがAcceptedとなる際にだけusedへ移す。最初のpreflight Acceptedでchange＋生成preflight operationIdの2、pause/apply Acceptedで各1を消費する。typed Rejected／discardは新native identityを消費しない。native preflight IDはAccepted proofから取得し、callerが事前発行しない。
typed Rejectedが確定して元callも終端したattemptの未使用native creditは、同stage retryのためにreservedのまま再割当できる。immutable Rejectedを後からAcceptedへ変えられないため、過去attemptとの二重消費は起きない。新client retry枠とは区別する。

全予約を検査後に一度だけcommitする。mutation6MiBへ入らなければ最初のpreflight前にCapacityで拒否し、read2MiBへ借りない。
lease発行前からID/bytes creditを確保するが、未使用leaseを4本同時発行したとは扱わない。将来期限は予約時に作らず、各stageの明示issue_workflow_lease時の仮想nowから一度だけ確定する。全stage予約済みでも同lease/admissionの再発行・期限延長は禁止する。active未消費lease各4という既存上限は別に維持する。
Stageを初回使用した際、reserved→usedへ移し、そのstage実要求が最大template上界内であることを確認する。二重移管・二重課金をしない。revisionも最初に確保した11creditを各stageへ移すだけで、既存beginの+3をさらに加算しない。close用1との合計12を二重予約・二重解放しない。

使用済みID／Lは永久保持。正常Completed／Discardedでは未使用stage creditだけ解放できる。
unknown／Blockedでは未使用creditも保守保持し、別workflowのために不明な候補を捨てない。

## 8. retryと失効

同admissionId／leaseRequestIdのexact再送は元結果を返すだけで、新stage creditを使わない。
issue_workflow_leaseの受付前ModelErrorでは初回creditを消費しない。発行成功後はattempt bindingが既にusedなので、beginがModelErrorでもそのIDを未使用へ戻さない。同じ未失効lease／同本文のbegin再試行だけは追加課金せず許す。
既にleaseを発行して失効した場合は元IDを保持し、新lease／新admissionによる明示retryは追加credit／bytesを確保する。
期限延長、同admissionIdへの別lease付替え、元unknownの自動再送は禁止する。
期限切れ／typed拒否後の新attemptは新leaseId／admissionId／pause/apply operationIdと追加lifetime bytesを要求する。初回stageの発行でboundになった未登録attemptも使用済みとして保持し、その未使用Lを別stageへ流用しない。未発行の将来stage escrowだけを「未使用credit」と呼ぶ。

初回applyがtyped Rejectedになっても、その元request／knowledge／terminal Lは残る。
初回discardの独立creditは未使用のまま残るので、retry資源が枯渇していても当初予約内のdiscardが可能である。
追加retryが未来の初回pause／apply／discard creditを横取りしない。

Accepted後failedはCompleted／Blocked／Uncertainであり、同候補のretryではない。この区別をeffect=notDispatchedの文字列だけで解除しない。
新たなworkflowを行う場合はb4bの明示受付へ戻る。旧receiptを新しい実行として扱わない。

## 9. 原子publicationと所有

既存event overlayを拡張し、phase、escrow消費、ID/ref登録、descriptor/revision更新の全候補を検証してからcommitする。
古いticketのlate proofはそのrecordだけを更新し、現在workflowやheadを別の候補へ移さない。
現在workflowに対応する証拠でも、元call正常終端と既知completionの両方が揃うまで次stageを許さない。

既存read pool・取消pool・subscriptionは独立で、workflow creditを消費しない。
取消requested／alreadyCompleted、frame配送、CallInspection Foundはそれ自体でstageを正常進行させない。
close／ClockFault後は新stage／retryを拒否するが、受理済み証拠の保存と既存read照会は維持する。
元要求の同値性と元run/session照合を、fixtureの見た目やprefixで代用しない。
WorkflowPhase／escrowの統計はモデル固有Rust stateとして公開し、OwnerSnapshotへ新fieldを足さない。reserve／lease／finishでphaseだけが変わりsnapshot本文が同じなら、publication revisionを増やさない。workflow Busy／Reserved／CandidateをownerBlockedへ混ぜず、ownerBlockedは従来どおり明示recovery根拠だけとする。

## 10. 実装順と受入

### prep2b4a

最初の一workflowだけを対象に、tight lifetime meter、4stage escrow、private ticket、明示三段階／discardを実装する。
b4aの初回APIは最初の一workflowだけを扱う。正常終端後も同APIによる暗黙更新はBusyとし、b4bの明示更新へ分離する。
既存Standaloneの保守phaseと低レベル試験を維持し、会計と独立reconciliation ID制約の期待値を更新する。同reconciliationIdを別admissionで使う旧fixtureは新IDへ明示変更するか、再使用拒否の回帰試験へ変更する。applyを直接開始する既存144scenarioはStandaloneの有限低レベルsimulation試験として残す。strict workflowへ移したと偽らず、Workflow modeにpredecessor省略・seed・force phaseを公開しない。新workflow scenarioは必ずreserveとpreflightから始める。native／UI／wire schemaを変更しない。

### prep2b4b

[次workflow受入のAstra設計](historian-recording-registry-workflow-renewal.md)で、正常な現在predecessor ticket・毎回の同run資格宣言・全静止gateによる明示更新を定めた。Running／clean Joinedの同run継続と、新run/contextが必要な場合を分ける。純粋Rustモデルへ実装済みである。
旧receipt／ID／終端callを保持したまま残予算を検査し、未知またはrecoveryをnew owner作成で消さない。
resume／fresh SDK／初期bootstrap／実native接続はこの工程からも自動許可しない。

| 受入                | 必須証明                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| 正常列              | preflight candidate→明示pause→paused→明示apply→applied。各call未終端では次送信不可                       |
| 分岐                | Replay/errorでpauseしない、Candidate/Pausedだけdiscard、自然完了でpause省略なし                          |
| 拒否                | typed Rejectedは元phase維持、Accepted failed/notDispatchedはCompletedへ・retry不可                       |
| 意図                | 同run/context/changeRef/desired/expected版、member順、同ID異本文、別model ticket拒否                     |
| 独立軸              | 元unknown返信不変＋late Accepted、unknown静止/recovery/readUncertainでblock維持                          |
| 4credit             | apply typed拒否後も初回discard可能、retryで初回stage枠を奪わない                                         |
| bytes               | tight全branch上界、全4record同時保持、6MiB exact/1不足、read2MiB非借入                                   |
| read独立台帳        | mutation枯渇でもread ID予約可、同admit exact再送無課金、別admit同reconciliationId拒否、cap不足の全原子性 |
| ID/lease            | 全pool shrink、初回予約の原子性、lease失効後の明示retry、unknown自動再送無し                             |
| projection/revision | 将来全stageの受付前予約、未使用credit返却と使用済み不変、close credit保持                                |
| 未接続              | fake qualificationはnative資格でない、wire／DB／SDK／認証／transport不変                                 |

設計PR #77はworkへ統合済み（`84b325b`）。prep2b4aでは新47シナリオ597ステップと10境界試験を実装し、既存192シナリオも要求由来の会計で維持する。92期待DTOと全入力をTS／browserの既存validatorへ照合し、TS側に第二のworkflow権威を作らない。b4bでは共有50シナリオ947ステップと10境界試験を追加し、旧239シナリオを維持した。実接続は未実装である。
