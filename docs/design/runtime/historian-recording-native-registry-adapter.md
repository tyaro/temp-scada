# 記録wireのnative registry adapter

状態: **C4の採用詳細設計。排他的owner seed・純粋予算kernel・実時計leaseを実装、native admissionは後続**。2026-11-06（日本時間）。Historianの主設計・レビューはユーザー指定のAstra。[coordinator-v2](historian-recording-coordinator-v2.md)、[wire・host契約](historian-recording-wire-host.md)、[共有native owner](historian-recording-native-owner.md)、[接続境界](historian-recording-bridge-boundary.md)に続く。

## 1. この区切りの対象

GUI非依存の`scada_runtime::recording_registry`を、外部composition rootが保持する**一つの実`RecordingOperationsOwner`**に接続する。初回は既存Runningまたは正常Joinedの単一group・単一workflowを対象とし、mock Hubと一時SQLiteでnative受理・物理完了・readを検証する。新たなwriter、Supervisor、SDK接続をcallerやrequestごとに作らない。Project 0.37.0、DB7、H1、既存wire JSON rootとSDK固定版は変更しない。

この設計の採用は、認証の再開、通常Appからの変更操作、Tauri command、外部HTTP待受、実記録運用の完成を意味しない。C0〜C3で実装したTauri埋込hostは**読取用**であり、その`Active`と`stop_read()`の寿命を記録ownerへ転用しない。製品transportはnative adapterのmock Hub・一時DB受入後の区切りとする。

## 2. 所有と資格

| 値・所有者                            | 役割                                                                                   | 作れない証拠                                              |
| ------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 非Clone `RecordingRegistryRoot`       | native owner、実registry、ownerのTokio `Handle`、lease、全caller gate、完了監視を保持  | UI viewや通信接続の寿命から作らない                       |
| Clone可能な`RecordingRegistrySession` | root identity、固定scope、hostが認可したprincipalと許可操作を束縛する非JSON capability | wireのprincipal名・role文字列・Hub read keyから復元しない |
| 内部`AdmissionTicket`                 | 登録sequence、元request全文、leaseとroleを一回のnative呼出しへ束縛                     | ID文字列から再作成しない                                  |
| 内部`NativeBinding`                   | ticketと実change／operation／reconciliation handleの一対一対応                         | frame・result・ref文字列から推定しない                    |

factoryは実`RecordingOperationsOwner`を消費し、ownerのcontext全文を`scope.context`へ照合する。ownerRefとownerEpochはregistry管理側が別に決め、owner自身にそれらが存在すると仮定しない。epoch生成源はhostが注入し、process再起動後の再利用を防ぐ契約を製品公開前に固定する。旧epochのref・lease・sessionは新rootへ移さない。検査失敗ではcallerへownerを返し、状態や資源を失わない。

ownerをmoveしただけでは、発行済みの`RecordingOperationsClient` cloneからregistry外のpreflight等を実行できる。native owner側に専用の排他的引渡し契約を追加し、未使用・操作未進行・外部client未発行をowner内部の排他下で確認する。既に発行したclientが後でdropされても、この引渡しを許さない。成功後にrootだけが内部clientを取得し、外部へ生のclientを渡さない。現行`client()`のままfactoryで自己申告を信じて排他性を得たと扱わない。

製品session発行は、認証済みhostの非JSON capabilityを受ける管理APIが確定してから接続する。現在の認証延期中も、kernel、実owner binding、実lease、受付・完了・取消・購読、閉じたerror、管理側shutdownは製品ライブラリとして実装できる。試験用issuerは`#[cfg(test)]`等の試験専用入口に閉じ、公開`issue_session(principal: String, permissions: ...)`を仮置きしない。製品mutation endpointは公開しない。`Scope.context`の一致は対象照合であり、認証ではない。認可失効後は新lease・新mutationを拒否し、既受理native操作の内部監視を続ける。失効したcallerへの結果開示はhostが残した監視権限で別途判定する。保護されたHub read keyを記録変更principalへ昇格させない。

## 3. simulationと実authority

現行`scada_runtime::recording_registry_model`は`ModelInstant`、`SimulatedPrincipal`、`SimulatedDecision`、`SimulatedCompletion`を受ける純粋モデルである。任意のsimulation入力からAcceptedや完了を作れるため、そのfacadeをnative authorityとして公開しない。`RegistryDomain`のscope ticketも実native handleではない。

登録・予約・不変返信・projectionの状態遷移と予算計算は、既存fixtureを維持しながらcrate-private kernelへ抽出する。従来のsimulation facadeと、実owner handle・typed rejection・完了だけを入力できるnative facadeを分ける。認可、`Instant`、実handle、runtime taskはsimulation APIへ混ぜない。抽出の前後で既存Rust scenarioを通し、純粋モデルの意味を変えない。StandaloneモデルはAccepted後の新mutationを保守的に止めるため、三段階のpreflight→pause/join→applyにはworkflow予約が必要である。simulationのcaller宣言`qualification`を実native資格として採用しない。

## 4. 受付の確定順序

1. sessionのroot・principal・権限、scope/context、lease role、元request全文、現在workflow段階、全pool容量を照合する。preflight受付前に後続pause/apply/discardと結果・projectionのworkflow creditを予約する。nativeの4096枠はchangeとoperationの合算で、wireのrole別容量と同一視しない。
2. 元admission record、結果保存・監視metadata、参照IDを**native呼出し前**に登録する。同ID同本文の再取得は既存recordを返し、別本文は拒否する。登録済みでもnative未受理ならAcceptedとしない。
3. 登録ticketから実nativeを一回だけ呼ぶ。registry lockを保持してDB、join、awaitを行わない。登録からhandle保存までにtransport Futureのdropが割り込めないよう、root所有の受付処理を使う。
4. 同期返却した実handleをticketへ保存する。typedな同期`OperationRejection`だけを未受理の`rejected`へ投影する。handle返却後のfailed／notDispatchedは**accepted operationのcompletion**である。panic・返却有無不明を確定拒否へ変換せず、Uncertainとして新mutationを止める。
5. 元dispatcher reply全文を不変保存してからcallerへ返す。通信が返却値を失っても、CallInspectionから同じ元replyを回収する。後のAdmissionInspectionの受付知識で元`unknown`を書き換えない。
6. completion監視は実handleごとに一つとし、Observation照会ごとにnative taskを増やさない。実handleの完了証拠と元call taskの終了は別に保持する。

送信前の全pool予約とnative側のBusy／容量gateが競合した場合、nativeのtyped拒否をそのrecordへ保存する。登録済みrequestや予約済みIDを別操作へ再利用しない。上限時は有限停止し、root作り直しで未回収要求を消さない。

## 5. 実leaseとworkflow対応

lease発行時に`Instant::now().checked_add(granted)`で絶対期限を一度決める。`grantedBudgetMs`は要求以下かつ1〜10000とする。leaseはroot、scope、principal、admissionId、roleへ固定し、未使用から消費済み／失効へ一方向に進む。同一lease要求の再取得は元期限と元replyを返し、延長しない。登録時とnative呼出し直前に期限を照合し、同じ絶対期限をnative`QueryControl`へ渡す。JSの時計値や壁時計offsetを変換しない。pauseのstop発行後に期限が来てもjoinを途中で打ち切って静止を捏造しない。rows／bytes等のnative上限はhost policyで固定する。

| wire操作         | 実nativeに必要な束縛                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| preflight        | `AcceptedRecordingChange`のchangeとoperationを同時保存。preflight operationIdはnative生成値                                                      |
| pauseJoin／apply | 登録済みchange handleと元request全文を照合し、callerのoperationIdを既存native検査へ渡す                                                          |
| discard          | 実`discard`の同期成功後だけ`completedDiscard`。送信成功は証拠にならない                                                                          |
| reconcile        | 現workflowの元apply handleへ限定する。元completion確定・Supervisor回収・健全なreceipt readerを要求し、任意の過去ID・resultからread資格を作らない |
| cancel           | 対応する実handleへ高々一回通知。ackは物理終了やcommit取消を示さない。pauseは`notSupported`                                                       |
| Observation      | 保存済みhandleのcompletionを読む。`pending`、`unavailable`、`readUncertain`を分ける                                                              |

reconcile対象は元applyがfailed／unconfirmed、またはappliedでquiescence unknown／recoveryありの場合に限る。未完了applyと並行してreadを開始しない。dispatcher panicでSupervisorを失った場合、read不可を正常な不在結果に置換しない。初回の一workflowを超える更新、initialIdle bootstrap、mapping登録、fresh SDK解決とresumeは別capability・別受入にする。次workflowの同run資格は実owner状態から導出する方法を設計してから追加する。

## 6. 監視、終了、公開前gate

native watchが閉じた、監視taskが失敗した、通信が切れた場合は正常結果に丸めず、元handleと不確定性を保持する。readのreceiptFoundから元applyの物理静止を合成せず、ownerのsticky recoveryを消さない。frame、元Admission reply、CallInspection、Observation terminal、個別transport taskは別の証拠である。

view close、Project切替、Hub読取再接続はrootをdropしない。既存ownerは作成時のTokio runtime `Handle`を固定しており、registryが別runtimeを作っても移らない。hostはownerとSDKが使うruntimeを保持し、handoff後はその所有・維持責任を移管先へ渡す。recorderを含むnative処理のstop／joinが完了するまでruntimeを終了しない。明示shutdownは新受付停止、既登録の管理処理・監視の回収、Supervisorとrecovery evidenceの管理側への返却に限定する。`try_handoff()`は既存のBusy／recovery gateに従い、未静止ならrootと資源を保持して成功としない。handoffが成功してもrecorderはRunningであり得るため、記録workerのstop／joinは返却先の別の明示処理とする。`Drop`時の取消やruntime終了を正常停止・joinと扱わない。registry close、認可失効、native recoveryは独立状態として公開する。

製品transport接続前に、host 1でのroot配置・起動／終了、trusted principal供給、role照合、認可失効後の監視許可、epoch生成と永続衝突防止、送信前全pool予約、Tauri読取hostとの別寿命を実装・確認する。UIが非同期受付を同期`RecordingOperationsService`として偽装しない。

## 7. 受入と実装順

2026-11-06の実装区切りでは、seedを固定scopeの非Clone rootへ移し、試験専用sessionと実`Instant`期限のlease台帳を追加した。同一要求の再取得は元replyを返して期限を延長しない。製品session発行、一workflow事前予約、native admission／handle保存は後続であり、leaseの存在をnative受理の証拠としない。

一時SQLiteとmock Hubを使い、実`RecordingOperationsOwner`で次を受け入れる。

1. preflight→Candidate→pause/join→apply→Observationを同じopaque handle chainで完走する。native即時完了、typed同期拒否、受理後failed／notDispatched、panicを区別する。
2. 元reply喪失後のCallInspectionと後着AdmissionInspectionで、native呼出回数一回、元`unknown`不変を確認する。completion監視登録前に実handleが完了しても取りこぼさない。
3. cancel重複、pauseの`notSupported`、cancel後late結果、Observation pendingと明示repeatを確認する。
4. lease reply遅延、dispatch待機、期限境界、role交換、同ID別lease、別caller・scope・epoch・principal・同ref別handleを拒否する。
5. 元apply completion確定・Supervisor回収後に限定したreconcile、receiptFound後のrecovery維持、readUncertainとread不可を分ける。全poolのexact／1不足と最大replyの保存を確認する。
6. view切断・認可失効・root close後も既登録操作を監視し、Rust生成wire DTOを既存TS validatorで検査する。通常AppとTauri読取経路に副作用を作らない。

最初の独立した安全gateとして、既存ownerを失敗時返却付きで`RecordingRegistryOwnerSeed`へ排他的に移した。公開client発行履歴はdrop後も残し、native Coreが未使用でないownerを拒否する。次にAdmission一件の保存上界とbytes／nodes／depth照合をcrate-private kernelへ抽出し、simulationの登録・予約・投影で使う。さらに固定scopeのroot・試験専用session・実時計leaseを追加した。この先は (1) 一workflow事前予約とlease消費、(2) native admission／handle保存／元reply・inspection／completion、(3) cancel・snapshot／subscription・失効・管理側shutdown、(4) mock Hub＋一時DBの一貫受入の順に分ける。製品hostのsession issuer、権限失効後の結果開示、epoch生成・永続衝突防止、Tauri endpointは認証・host gateとして別に固定する。その後に製品transportと通常Appへ接続する。
