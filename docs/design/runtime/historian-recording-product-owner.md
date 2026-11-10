# 製品hostの記録ownerと画面接続（C5）

状態: **採用**。2026-11-09作成、同日ユーザー判断で§8を推奨案のとおり確定（日本時間）。[認証・host gate](historian-recording-host-gate.md)の手順1〜4（PR #131〜#142）を閉じた後の区切りである。[実Hub・S7接続計画](../../project/real-hub-connection-plan.md)のC5（実データの記録・履歴受入）のうち、製品hostへ記録DB・Supervisor・記録registryを置く範囲と、通常Appの履歴・記録画面へ接続する範囲を定め、PRの分割を決める。

## 1. 現状

- 製品host（`apps/banto-scada/src-tauri/src/main.rs`）は`DesktopRecording::unavailable(NO_RECORDING_OWNER)`を置き、記録registryの10個のcommandは`recordingUnavailable`を返す。記録DB、Supervisor、`HistoryHost`は製品hostにない。
- 通常Appは`historyService`・`recordingManagementService`・`recordingOperationsService`・`recordingAsyncOperations`をpropで受けるが、`NativeShell`は`readSource`と`catalogSource`だけを渡す。渡しているのはPlaywright試験の差し替えだけである。履歴・記録管理・記録操作の画面は、デスクトップでは「未接続」を表示する。
- TSの記録wire層（`recording-wire-receiver.ts`、`recording-wire-delivery-ledger.ts`、`recording-wire-local-v2.ts`、`recording-wire-coordinator-v2.ts`）はtest-onlyで、通常Appから参照されない。通常Appが受けるのはv1の`AsyncOperationsClient`（`recording-async/coordinator.ts`が作るbrand付きの値）だけである。

## 2. ownerを組める状態

`RecordingOperationsOwner::try_new`は、Supervisorの記録が`Running`か正常な`Joined`で、`RecordingRun`があることを要求する（[native owner](historian-recording-native-owner.md)§3）。`Idle`のhost、つまり記録を一度も始めていないstoreや、再起動直後のstoreからはownerを組めない。再起動時の`open_existing`は前回の`active` sessionを`interrupted`へ確定するので、再起動後のhostは必ず`Idle`から始まる。

このため製品hostでは、記録registryを有効にできるのは記録を始めた後である。記録を始める経路は次の二つで、どちらもregistryの外にある。

- **初回設定と開始**: storeへmapping登録・保持方針の適用・記録計画の適用を行い（`Host::new`の前の既存`SqliteStore` API。[supervisor](historian-recording-supervisor.md)のH5c2b）、`start_managed`で始める。
- **再起動後の明示resume**: H5c2c2の`start_resume_inspection`→fresh SDK解決→`prepare_resume`→`resume`。初期Idleで使える（supervisor設計の「初期Idleでの明示resumeは既存Hostの初回開始と同じ許可範囲であり、自動復旧ではない」）。

[native registry adapter](historian-recording-native-registry-adapter.md)はこの二つ（initialIdle bootstrap、mapping登録、fresh SDK解決とresume）を「別capability・別受入」としている。本書はこれをregistryのwireへ加えず、**hostの記録制御command**として扱う（§5）。

## 3. 配置

| 対象                               | 置き場所・所有                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 記録DB（`SqliteStore`）            | アプリdata dirの`historian\`（`store.sqlite3`・`writer.lock`・WAL）。認証DB（`scada-auth.sqlite3`）とは別（host-gate §8.3）。Project・ブラウザstorageには置かない                                                                                                                                                              |
| store identity                     | `historian-store.json`（`version`・`storeId`・`deploymentId`・`historianNamespace`）。`storeId`と`historianNamespace`は作成時に乱数で引き、`deploymentId`は作成時のinstallation IDとする。`durable.rs`の一時file→sync→置換で、store作成より前に保存する。`open_existing`はこの値で照合し、読めない・不正なら上書きせず拒否する |
| 記録host（新設`RecordingRuntime`） | 起動時に作り、process終了まで保持する。storeから先に`HistoryReader`を一つ取り（readerは最大2つ。残りの一つはSupervisorのpreflight用）、storeを`RecordingSupervisor::try_new`へ渡す                                                                                                                                             |
| 記録用SDK接続                      | `Bootstrapper::rest_client()`を記録の開始ごとに新しく取る。読取host（`hub_read_start`）のclientと共有しない。Hubの切断操作（`hub_disconnect`）は読取だけを止め、記録は止めない                                                                                                                                                 |
| owner・root・gate                  | 記録が`Running`になった後に、`RecordingOperationsOwner`→`RecordingRegistryOwnerSeed`→`create_recording_root`→`RecordingGate`の順に組む。記録runごとに入れ替える（§4）                                                                                                                                                          |
| `HistoryHost`                      | 起動時に取ったreaderで作り、process終了まで保持する。記録の開始・停止と独立に動く（[History host](historian-history-host.md)）                                                                                                                                                                                                 |

storeが存在しない初回起動ではstoreを作り、`Idle`のSupervisorを置く。storeを開けない場合（identityの不一致、形式違い、別processのwriter lock）は記録hostを`unavailable(理由)`とし、アプリは止めない（認証の起動失敗と同じ扱い、host-gate §6）。

C5-1の実装で次を定めた。

- **履歴namespace**: [Trend定義](historian-trend-definition.md)のnamespaceは「deployment／callerが割り当てる不透明な履歴データ集合の識別」で、DB再作成で系列継続性が保証できなければ新しく割り当てる。製品hostではstoreを一つの履歴データ集合とし、store作成時に`historianNamespace`（`historian:`＋UUID）を`storeId`とは別に引いて`historian-store.json`へ保存する。`storeId`からは導出しない（[記録管理](historian-recording-management.md)の「storeIdから生成しない」）。
- **起動時の分岐**: identity fileがなくstore dirもなければ、identityを保存してからstoreを作る。identity fileがあってstore dirがなければ（保存とstore作成の間で止まった起動）、保存済みのidentityでstoreを作る。identity fileがなくstore dirがあれば、新しいidentityで採用せず`store_identity_missing`とする。identityの読取からstoreのopenまでは`historian-store.lock`の排他lockの下で行い、新しいdata dirで同時に起動した二つのprocessがそれぞれのidentityを保存しないようにする（後のprocessは先のprocessのstoreを見つけ、writer lockで`store_locked`になる）。
- **理由コード**: `no_data_dir`・`store_identity_unreadable`・`store_identity_invalid`・`store_identity_missing`・`store_identity_unsaved`・`store_identity_mismatch`・`store_locked`・`store_init_lock_failed`・`store_unsupported`・`store_unavailable`。path・SQLiteの文言・identityの値はUIへ出さない。

## 4. gateの導入と入替え

registryのapplyは、設定をcommitした後に記録を再開しない（native owner §5「設定commit済み、resumeしない」）。ownerは単一workflowで、resumeはregistryの外にある（§2）。そのため一つのgate（owner・root・ownerEpoch）が受け持つのは一つの記録runで、記録を再開するたびにgateを入れ替える。

```
Empty ──開始・再開──▶ Installed(gate N) ──handoff・停止──▶ Empty ──再開──▶ Installed(gate N+1)
```

- `RecordingSlot`（新設）は`Empty(理由)`か`Installed(gate)`を持つ。`DesktopRecording`と`DesktopAuth`は同じslotを共有し、現在の`AuthState::with_gate`・`DesktopRecording::new`（起動時にgateがある前提）を置き換える。
- slotの変更は移行lock（`AuthHost::gate()`）の下で行う。desktop sessionの`seq`はslotと独立で、registry sessionはgateの中で初回に発行するので、入替えの前後でloginし直す必要はない。
- `Empty`の間、registry commandは`{"kind": "recordingUnavailable", "reason": "no_recording_run" | "store_unavailable" | "owner_unavailable"}`を返し、認証commandはgateなしの経路（現行）を通る。
- gateを外すときは、そのrootの`try_handoff`だけでSupervisorを取り戻す。`try_handoff`は成功したときにだけ自分で`begin_shutdown`を呼ぶ。未静止（Candidate／Paused、未確定の配送）なら`busy`で、rootは`Open`のまま何も変えない。先に`begin_shutdown`を呼ぶと、取り消せない受付停止（Draining）と未配送登録の確定が残り、拒否した後も既存のworkflowが進めなくなるので、入替えと停止では呼ばない（`begin_shutdown`を先に呼ぶのは終了時だけ、§6）。handoffしたrootは閉じ、そのrootの購読には`ownerClosed`のcontrol frameが届く。clientは新しいownerEpochのrootへattachし直す。閉じたrootの不変記録の照会は、gateを外した時点で終わる（新しいrootでは旧ownerEpochの要求を`closed`とする）。
- 新しいgateのownerEpochは`create_recording_root`が世代ごとに引き直す（host-gate §7）。

C5-3aの実装で次を定めた。

- **slotの置き場所**: `RecordingSlot`を別の型にせず、`RecordingGate`の内側に置いた。gateはprocessに一つで、起動時に`RecordingGate::empty(理由)`で作り、`DesktopAuth::with_gate`と`DesktopRecording::new`が共有する。gateの中身（root・issuer・registry session・workflow・購読の束縛）が記録runごとの`RootState`で、`install`（`Empty`→`Installed`）と`try_take`（handoffして`Installed`→`Empty`）で入れ替える。どちらも移行lockの`PhaseGuard`を引数に取る。認証commandは常にgateを通り、quiescenceと`holds`はそのとき導入されているrootに問う（rootがなければ静止、誰も保持しない）。こうすると、認証commandがslotを読んでから移行lockを取るまでの間に入替えが起きる競合がない。
- **世代**: gateは導入したrootに1からの連番（generation）を振る。購読の参照（`native-subscription:<n>`）はrootごとに1から始まるので、frame pumpとpageの購読表は`(generation, subscriptionRef)`で引く。`recording_attach`の結果は従来どおりwireの返信だけをUIへ返し、generationはhostの中に留める。
- **handoffしたroot**: `try_take`で外したrootは閉じたまま一つだけ保持し（`retired`）、その購読のframe配送（`ownerClosed`のcontrol frame）にだけ使う。registry commandは導入中のrootにしか届かないので、閉じたrootの照会は外した時点で終わる。次の`try_take`で置き換わり、置き換わったrootの購読は`closed`で終わる。
- **Emptyの応答**: registry commandは、要求の解析より先にslotを見て`{"kind": "recordingUnavailable", "reason"}`を返す（移行lockの下でもう一度確かめる）。理由は、記録DBを開けなければ`store_unavailable`、記録が一度も動いていないかhandoff後なら`no_recording_run`、導入に失敗したら`owner_unavailable`である。

## 5. 記録制御command

registryの外で、記録の開始・再開・停止をhost独自のcommandとして提供する。照会はViewer以上、他は認証のAdmin（認証無効モードの合成Adminを含む）を要し、移行lockの下で再検証する。

| command                   | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recording_status`        | storeの有無とidentity、Supervisorのphase、適用済みの計画・mapping・保持の各revision、slotの状態を返す。記録管理画面の照会（`RecordingManagementService.inspect`）もこれと同じ読取を使う                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `recording_initial_setup` | Projectの`recordingPlan`とHubのcatalogから、mapping（`hub_instance_id`と各memberのidentity）を作って登録し、既定の保持方針（§8の4）を適用し、記録計画を適用し、`start_managed`で開始する。storeに適用済みの計画があるときは`not_allowed`（以後の変更は、記録中はregistryのworkflow、停止中は`recording_reconfigure`）                                                                                                                                                                                                                                                                                                |
| `recording_resume`        | slotが`Installed`ならgateを外す（§4）。そのうえで適用済みの計画を、fresh SDK解決（新しい`TagClientHandle`で得た一つの`GenerationSnapshot`）で`prepare_resume`し、`resume`で開始する。registryのapply後の再開と、再起動後の再開の両方に使う。記録が`Running`のときは`not_allowed`                                                                                                                                                                                                                                                                                                                                     |
| `recording_stop`          | 設定を変えずに記録を止める。slotが`Installed`ならgateを外してから`request_stop_recording`→`join_recording`を行う                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `recording_reconfigure`   | 記録が止まっている間（slotが`Empty`で、Supervisorが`Idle`か正常な`Joined`）に、Projectの`recordingPlan`を適用する。`enabled: false`の計画を適用した後に有効へ戻す経路と、再起動後に計画を変える経路はこれだけである。手順は、`RecordingSupervisor::take_store`でstoreを取り出し、memberの組が変わっていればmappingを登録し直し（`expected_mapping_revision`で照合）、`apply_recording_plan`（`expected_applied_revision`で照合）で適用し、`RecordingSupervisor::try_new`で組み直す。保持方針は変えない。開始はしない（有効な計画なら続けて`recording_resume`を使う）。記録中とslotが`Installed`のときは`not_allowed` |

registryのworkflowは記録中（`Running`）の変更だけを受け持ち、ownerのない停止中の変更は`recording_reconfigure`が受け持つ。これにより、`enabled: false`の計画を適用して再起動しても、Projectで有効に戻して`recording_reconfigure`→`recording_resume`で再開できる（`prepare_resume`は有効な計画だけを受けるため）。

各段階の受付不明を二重に実行しないよう、`request_id`・`activation_id`・`session_id`・`clock_epoch`はhostが一度だけ引いて保存し、再実行は同じ値で照合する（H5b1のreceiptとH5b2のactivation照会を使う）。開始・再開が`Running`になったら、同じcommandの中でgateを導入する。導入に失敗したら記録は止めず、slotを`Empty("owner_unavailable")`とし、理由を表示する。

C5-2の実装で次を定めた。

- **照会**: `recording_context(projectJson)`が管理context v1（`contextId`は起動ごとに引く`host:`＋UUID、`deploymentId`・`storeId`・`historianNamespace`はstore identity）を返し、`recording_status(request)`が照会応答v1を返す。DB viewはSupervisorのresume inspection（一つのSQLite snapshot）から作り、Host viewはSupervisorの最新状態を別時点の観測として載せる。`runRef`は`run:<連番>`で、同じrunには同じIDを返す。SDK viewは独立の観測がないので`unknown`とする。DBの読取に失敗したらDB viewだけを`unavailable`とし、契約の検査に通らない投影は`projectionFailed`とする。slotの状態はC5-3aで別command（`recording_slot`）とした。
- **初回設定の判断**: 受付不明の再実行は、IDを保存して同じ値で照合する代わりに、**storeの現在の状態から各段階を決め直す**方式とした。登録済みmappingが計画に適合すれば（`hubRef`、各memberの`memberId`・`externalName`・`valueType`・周期）そのidentityを使い、保持方針が適用済みならそのrevisionを使い、同じ計画（members順を除いて同一）がenabledで適用済みかつactivationが一度もなければ開始だけを行う。それ以外の適用済み計画、activation済み、記録中は`not_allowed`とする。各書込みはrevisionのCASで照合するので、受付不明の後に同じcommandを呼んでも二重に登録・適用しない。request IDは段階ごとに新しく引く（再実行時は状態の読み直しが先に行われるため、receiptのreplayに頼らない）。開始のactivation・session・clock epochは開始の試行ごとに新しく引く（同じsession・epochの再利用はstoreが拒否するため）。
- **identity**: 新しいmappingでは、hostが`hub:`・`series:`・`incarnation:`・`segment:`＋UUIDを引く。名前やHubの数値IDから導出しない。`source`はfresh SDK解決の値（`ValueEntry.value_source`）から、`unit`はcatalogから埋める。保存の前に`SdkRecorderPlan::from_generation`で型・取得元・世代を確かめ、合わなければ何も保存せず`resolution_mismatch`とする。
- **手順**: Supervisorの読取（resume inspection）で判断し、fresh SDK解決（専用clientで一世代を開き、全memberが解決して値を持つ最初のsnapshotを取って閉じる。上限10秒）を済ませてから、`take_store`で書込みを行う。拒否やHubの失敗ではSupervisorを変えない。書込み後は`RecordingSupervisor::try_new`で組み直し、適用済み計画を明示resume（`start_resume_inspection`→`prepare_resume`→`resume`）で開始し、`Running`まで最大10秒待つ。開始前に止まったら`start_failed`とし、workerをjoinしてwriterを戻す。履歴の系列一覧はこの適用で更新する。
- **既定の保持方針**: `retention:default` revision 1、`Elapsed`で30日。clock guardの値は許容差2秒、観測間隔の上限1時間、一度に進めるcutoffの上限1日とし、初回cutoffの上限は置かない（fenceのない初回の削除候補を作らない。削除の運用はC6）。recorderの`max_clock_skew_ms`は1000とする。
- **認可と監査**: 照会（`recording_context`・`recording_status`）はViewer以上、初回設定はAdmin（認証無効モードの合成Adminを含む）で、どれも移行lockの下で再検証する。初回設定は認証phaseが`transitioning`の間は`not_allowed`とする。初回設定は結果を`initial_setup`（resource `recording`、成功は`ok`、失敗は`failed`とerror kind）として監査に残す。
- **エラー**: `{"kind": ...}`で、`not_allowed`・`busy`・`no_recording_plan`・`plan_disabled`・`invalid_plan`・`hub_not_configured`・`hub_unauthorized`・`hub_unavailable`・`tags_unresolved`・`resolution_mismatch`・`store_failed`・`start_failed`、記録DBを開けていなければ`{"kind": "recordingUnavailable", "reason"}`、認証はBantoの形とする。
- **画面**: `RecordingManagementService`に省略可能な`initialSetup`を加え、nativeではAdminのsessionにだけ渡す。記録管理画面は、照会でDBに適用済みの計画がなく、Projectの計画が有効なときだけ「初回設定と開始」を有効にし、結果（または失敗の理由）を表示して照会し直す。成功したら履歴のcontextを読み直す。管理serviceはProjectのID・revision・計画とsessionが変わるたびに作り直し、未ログインでは渡さない。

C5-3aの実装で次を定めた。

- **導入**: `recording_initial_setup`は、記録が`Running`になったら同じcommandの中（移行lockの下）でrootを導入し、応答に`"owner": "installed" | "owner_unavailable"`を加える。導入は、Supervisorを`RecordingOperationsOwner::try_new`へ渡し（contextは§5の管理context、`capabilityId`は`capability:`＋UUID、`recordingRunRef`は照会と同じ`run:<連番>`、`sessionId`は記録中のsession）、seed、`create_recording_root`、`RecordingGate::install`の順に行う。どの段階で失敗してもSupervisorを取り戻し、記録は止めず、slotを`owner_unavailable`とする。開始待ちが10秒を越えた（`starting`）ときも導入しない。
- **導入中の照会**: Supervisorはownerの中にあるので、`recording_status`のDB viewはHistory hostのreaderで一回のresume inspectionを読む（History照会と同じreaderを順に使い、実行中の照会は取り消さずに完了を待つ）。Host viewは導入前に取ったSupervisorの記録状態のwatchから作り、ownerの中にあるplan・retentionのguardは`null`（契約§6の未観測）とする。導入中の初回設定は`not_allowed`である。
- **`recording_slot`**（Viewer）: `{"state": "installed", "generation", "scope"}`か`{"state": "empty", "reason"}`を返す。`scope`はrootのwire scope（`ownerRef`・`ownerEpoch`・`context`）で、C5-5のclientがattachとleaseに使う。照会応答v1は契約で形が決まっているので、slotは別commandとした。
- **`recording_stop`**（Admin、移行lockの下）: 導入中のrootを`try_take`で外してSupervisorを取り戻し、`request_stop_recording`→`join_recording`（上限10秒）で止める。rootが未静止なら`busy`で何も変えない。記録が動いていなければ`not_allowed`。結果を`stop`（resource `recording`）として監査に残す。応答は`{"phase": "joined"}`。

C5-4の実装で次を定めた。

- **`recording_resume(projectJson)`**（Admin、移行lockの下）: 導入中のrootが記録中（`Running`・`Starting`など）なら外さずに`not_allowed`とする。そうでなければrootを`try_take`で外し（未静止なら`busy`で何も変えない）、自然に終わった記録（`FinishedUnjoined`・`Faulted`）はjoinしてから進む。storeの適用済み計画がなければ`no_recording_plan`、無効なら`plan_disabled`とする。適用済み計画の解決済みmappingでfresh SDK解決を行い、初回設定と同じ`start`（新しいactivation・session・clock epoch、`Running`まで最大10秒）で開始し、`Running`になったら同じcommandの中で新しいrootを導入する。応答は初回設定と同じ`{"phase", "owner"}`。履歴の系列一覧は適用済み計画で更新する（registryのapplyで変わりうるため）。監査は`resume`（resource `recording`）。
- **`recording_reconfigure(projectJson)`**（Admin、移行lockの下）: slotが`Installed`のとき、記録中、DBにactive sessionがあるとき、DBに適用済み計画がないとき（初回設定を使う）は`not_allowed`。Projectの計画が適用済み計画と同じ（members順を除く）なら何もせず`{"applied": "unchanged"}`を返し、受付不明の後の再実行を二重に適用しない。無効な計画はmappingを束縛せず（両方の期待revisionは`null`）、Hubを読まない。有効な計画は、登録済みmappingが適合すればそれを束縛してHubを読まず、適合しなければ新しいmappingを登録する。新しいmappingでは、Hub（`hubRef`）が同じなら`hub_instance_id`を引き継ぎ、`memberId`・`externalName`・`valueType`・周期が同じmemberは登録済みのidentityをそのまま使い（系列が続く）、それ以外のmemberだけ新しいidentityを引いてfresh SDK解決で`source`・`unit`を埋める。登録は`expected_mapping_revision`、適用は`expected_applied_revision`で照合し、保持方針は変えない。storeが`Conflict`で拒否したら（同じplanId・revisionが別内容で適用済み、または読んだ後にDBが変わった）`plan_conflict`とする。応答は`{"applied": "applied" | "unchanged", "enabled"}`。開始はしない。監査は`reconfigure`。
- **画面**: 記録管理画面へ、Adminにだけ「記録を再開」「停止中に計画を適用」「記録を停止」を加えた（停止は§8の5にないが、C5-6の受入で停止・明示再開を行うため加えた）。有効にする条件は照会結果からの目安で、最終判定はhostが行う。最新activationが中断（`interrupted`）なら、前回の記録が中断したことと「記録を再開」で再開できることを表示する。

## 6. 終了

`RunEvent::ExitRequested`で次を順に行う（native registry adapter「recorderを含むnative処理のstop／joinが完了するまでruntimeを終了しない」）。

1. gateがあれば`begin_shutdown`で新規受付を止める。未配送の登録はここで`rejected`／`cancelled`に確定する。受理済みのnative処理（preflight・pause/join・apply・read）は取り消さず、上限（§8の3）の中で完了を待つ。
2. `try_handoff`でSupervisorを取り戻す。`busy`のときはownerの段階で分ける。
   - **Candidate**（preflightの候補があり、記録は動いている）: このままではSupervisorが戻らず、記録を止められない。gateが**終了時の破棄**（§6.1）を行い、完了したら`try_handoff`をやり直す。
   - **Paused**（pause/join済み）: 記録はすでに正常に止まってjoinされ、storeに`active`のsessionはない。handoffせずに終了しても中断にはならない。候補はprocessとともに失われる（registryの状態は保存しない）。次回は`Idle`から起動し、適用済みの計画を`recording_resume`で再開する。
   - **受理済み処理の未完了・未確定の配送**: 上限まで待ってもhandoffできなければ、そのまま3へ進む。
3. Supervisorが戻ったら、記録を`request_stop_recording`→`join_recording`で止める。
4. 1〜3の全体の待ち時間に上限（§8の3）を置く。上限を越えたら終了し、次回の`open_existing`が`interrupted`へ確定する。この場合は記録の欠測として扱う。

UIを閉じても、hostのprocessが生きている間は記録を続ける（C5の完了条件）。トレイ常駐などでwindowとprocessの寿命を分けることは本書の範囲外とし、window終了はprocess終了とする。

C5-3aでは1・3・4を実装した。最初の`ExitRequested`で終了を止め（`prevent_exit`）、移行lockの下で`begin_shutdown`→`try_handoff`（静止するまで50msごとに再試行）→`request_stop_recording`→`join_recording`を10秒以内に行ってから`exit(0)`する。その間に届いた終了要求も止め、手順の後の要求だけを通す。rootのないhost（初回設定前、またはhandoff後）では記録の停止だけを行う。2のうちCandidateの終了時破棄（§6.1）とPausedの即時終了はC5-3b1で実装した。`try_handoff`が`busy`の間はownerの段階（registryの`owner_phase`）を見て、Candidateなら破棄を一度だけ行ってhandoffをやり直し、破棄が完了しなければ中断として終了する。Pausedならhandoffせずにすぐ終了する（`ExitOutcome::Paused`）。それ以外（preflightの実行中、受理済み処理の未完了）は上限まで50msごとに待つ。確認dialogはC5-3b2で実装した（§6.1）。

**期限切れのdiscard leaseの取り直し**（下の§6.1）はC5-3aで`scada-runtime`に入れた。同じIDでの取り直しは保存済みの返信を返し、取り替えられた古いleaseも同じIDなら自分の返信を返す。

### 6.1 終了時の破棄

終了時の破棄は、利用者の認可によらずhostが行う唯一のregistry操作である。候補の破棄はnativeの物理状態（記録計画・mapping・保持・記録）を変えず、ownerをCandidateから`Idle`へ戻すだけなので、終了のためだけにこれを認める。

**対象**: ownerがCandidateで、その候補が次をすべて満たすときだけ行う。registryの`issue_discard_lease`が同じ条件を確かめ、満たさなければ拒否する。

- preflightのadmissionが`accepted`で、元callの完了が`candidate`・`quiescence: confirmed`・`recoveryRequired: false`である。
- gateが保持するworkflow（`HeldWorkflow`）にpreflightのticketがある。

preflightの配送が未完了なら、上限の中で完了を待ってから判断する。完了が`replay`や`failed`ならownerは静止しているので、破棄せずにhandoffへ進む。Paused（pause/join済み）は破棄しない（§6の2）。

**手順**（gateの`shutdown_discard`、移行lockとgateのlockの下で行う）:

1. **session**: gateのissuerから、`HeldWorkflow`の予約principalに、mutation roleのregistry sessionを新しく発行する。issuerはshutdown中も発行できる。desktop sessionの再検証は行わない。予約principalがlogout済み、降格済み、削除済みでも行う。このsessionは破棄にだけ使い、終わったら`revoke_session`で失効させる。gateのsession表（`seq`とroleごと）には入れない。
2. **lease**: discard leaseはworkflowごとに一つで、予約時に枠が確保されている。
   - 利用者がすでにdiscard leaseを取っていたら、同じ`leaseRequestId`・`admissionId`で取り直す（違うIDは`protocolViolation`になる）。そのため、gateは`recording_workflow_lease`の`discard`段階で発行したleaseのIDを`HeldWorkflow`に記録する（C5-3bで追加）。
   - まだなければ、hostが新しいIDを引いて取る。期限は残りの待ち時間以内とする。
   - 利用者のdiscard leaseが登録されないまま期限切れなら、下の「期限切れのdiscard leaseの取り直し」で新しいIDのleaseへ取り直す。

3. **admission**: hostが受理済みpreflightの返信（`changeRef`）からdiscardのadmission requestを組み立て、`register_discard`→`dispatch_discard`で配送する。
   - 利用者のdiscard登録がすでにある場合（`DiscardRegistration::Existing`）は、それをそのまま配送する。`begin_shutdown`はdiscardの未配送登録を取り消さない。
   - 配送済みなら完了を待つ。
4. **確認**: discardの完了を待ち、ownerが`Idle`へ戻ったら`try_handoff`をやり直す。拒否された場合や上限を越えた場合は、§6の4（中断として終了）へ進む。
5. **監査**: 既存のgateの監査と同じ`recording_admission`として、結果（成功・`denied`・`failed`）を記録する。detailは`{"stage": "discard", "origin": "shutdown", "principal": <予約principal>}`とする。既存の記録はdesktop sessionのidentityをactorにするが、この破棄には利用者のsessionがない。そこでactorはhostを表す合成のidentityとする（C5-3b1で決定）。`actor_username`は`host:shutdown`（Bantoのusernameは`:`を含まないので、どのaccountも指さない）、`actor_role`は`admin`、`entity_id`は破棄のadmission ID（hostが引いたIDは`shutdown-discard:<uuid>`）とする。拒否のdetailには`error`を、配送したが完了しなかった場合は`outcome`（`rejected`・`unknown`）を加え、resultは`failed`とする。

**期限切れのdiscard leaseの取り直し**（registryの変更、C5-3aで実装済み）: 現行のregistryでは、未登録のまま期限切れになったdiscard leaseから戻る経路がない。

- 期限切れのleaseは表から消えないので、同じIDで取り直すと保存済みの返信（古い期限）が返り、`register_discard`は`Expired`になる。
- 違うIDの取り直しは`issue_discard_lease`が`protocolViolation`とする。
- discard leaseがある間はpause/joinのleaseも`busy`になる。

このため、そのCandidateは利用者の操作でも終了時でも破棄できず、handoff（§4の入替え・停止と§6の終了）もできなくなる。そこで`scada-runtime`の`issue_discard_lease`を次のとおり変える。

- 保存済みのdiscard leaseがあり、かつ**未登録で、hostの`Instant`で期限を過ぎている**ときだけ、同じ予約枠（保持bytesと`reservedRevisions`）で新しい`leaseRequestId`・`admissionId`のleaseを発行する。
- 古いleaseは`expired`のまま残し、新しいleaseで登録できるようにする。
- 期限内のleaseや登録済みのleaseがあるときは、従来どおり違うIDを`protocolViolation`とする。
- 同じIDでの取り直しが期限を延ばさないこと（wire-host §14「同ID返信で延長無し」）は変えない。

利用者の通常のdiscard（記録操作画面）も同じ経路で回復できる。試験は、未登録のまま期限切れにした後に新しいIDで取り直してdiscardが一度だけ配送されること、期限内と登録済みでは拒否されること、予約枠の会計が増えないことを`scada-runtime`で確かめる。

**確認dialog**: windowの`CloseRequested`で、hostは`quiescence()`を読む。未静止なら閉じるのを止め、UIへ理由を送る。

- Candidateなら「未完了の変更候補があります。破棄して終了しますか」と示し、「破棄して終了」と「キャンセル」を出す。
- 受理済み処理の完了待ちなら「記録の操作が終わるまで待って終了します」と示す。
- キャンセルしたら何もしない。利用者は記録操作画面で候補を適用するか破棄できる。
- dialogを出せない終了（OSのshutdown、UIの応答なし）では、確認なしに§6の手順を進める。

C5-3b2の実装で次を定めた。

- 判定はgateの`close_check`で、registryの`owner_phase`と`quiescence()`を一つのlockの下で読む。終了手順と同じ分け方をする: rootがない・静止している・Pausedなら閉じる（`close`）、Candidateなら確認する（`candidate`）、それ以外は待つ（`waiting`）。移行lockは取らない（dialogのための観測で、終了手順は改めて判断する）。roleも見ない。
- src-tauriは`CloseRequested`で判定し、`close`以外では閉じるのを止めて、そのwebviewへ`scada:close`（`{"id", "kind"}`）を送る。`candidate`ではUIの回答を待ち、`waiting`ではすぐに`app.exit(0)`で終了手順へ進む（UIは「記録の操作が終わるまで待って終了します」を示すだけで、閉じられない）。
- UIは`app_close_reply(id, reply)`で答える。受け取ったらすぐ`shown`を返し、ボタンで`discard`（`app.exit(0)`で終了手順へ進み、手順が候補を破棄する）か`cancel`を返す。3秒以内に`shown`がなければUIの応答なしとみなし、確認なしに終了手順へ進む。確認中にもう一度閉じると新しいIDで聞き直し、古いIDの回答は`stale_prompt`で拒否する。
- 終了手順が始まった後（`ExitRequested`、回答、応答なし）の`CloseRequested`は止める。手順の終わりにprocessが終了する。

**試験**（C5-3b2）: gateの判定（scada-hostの`recording_gate/tests/shutdown.rs`、Candidate・Paused・rootなしと、段階と静止の組合せ）、確認の状態遷移と`app_close_reply`のIPC（src-tauriの`close.rs`・`control_tests.rs`）、UIの受信と回答（`src/native/close.test.ts`）、IPC mockのe2e（`e2e/native-close.spec.ts`）。`CloseRequested`そのものはmock runtimeのevent loopでしか起きないので、src-tauriの試験は判定と回答を分けて確かめる。

**実装上の補足**（C5-3b1）:

- gateは`HeldWorkflow`に予約時の変更要求と、`discard`段階で新しいIDで発行したdiscard leaseの要求を記録する。利用者が置き換えられた古いleaseを同じIDで取り直しても、記録は最新のleaseのままにする。
- 利用者のdiscard登録は、gateでは登録と配送を同じlockの下で行うので、未配送のまま残ることはない。hostは利用者のleaseの`admissionId`と`deadlineLeaseRef`から同じadmission requestを組み立てるので、登録済みなら`Existing`として返り、その保存済みの返信を使う。完了済みならownerはすでにCandidateではない。拒否済みならその結果を破棄の失敗として扱う。
- 降格と削除は、Candidateの間は§4により`busy`で拒否されるので、実際に起きるのはlogoutと別の利用者のloginである。破棄はdesktop sessionを読まないので、どの場合も同じに動く。
- registryが`busy`と答えたとき（preflightの完了がまだ見えない）は何も登録せず、次の再試行で判断し直す。

**試験**（C5-3b1、scada-hostの`recording_gate/tests/shutdown.rs`と`recording_runtime/setup_tests/owner.rs`）:

- Candidateで終了すると、破棄、handoff、stop/joinの順に進み、次回の起動で`interrupted`が残らない。計画は変わらない。preflightが受理された直後（native処理の完了前）に終了を始め、完了を待ってから破棄することも同じ試験で確かめる。
- 予約principalがlogoutし、別の利用者（Viewer）がloginした後でも破棄できる。
- 利用者が取ったdiscard leaseを同じIDで引き継ぐ。未登録のまま期限切れのleaseは新しいIDで取り直す。
- Pausedでは破棄せずに終了し（`ExitOutcome::Paused`）、次回の起動で`interrupted`が残らない。
- 破棄が拒否されたら中断として終了する。rootとCandidateはそのまま残り、記録はprocessの終了まで続く（拒否は試験用のhookで起こす）。
- 監査の記録が残る（成功は`ok`、拒否は`denied`、actorは`host:shutdown`、detailに予約principal）。

## 7. 画面接続

### 7.1 履歴

nativeの`HistoryService`を作る。`source.query`は`history_query` commandで`HistoryHost`の`start_query`→`join_query`を呼び、`AbortSignal`で`history_cancel`を呼ぶ。`context`（v2、`historianNamespace`を含む）はhostが適用済みの計画とstore identityから作り、`history_context(projectJson)`で返す。Projectのmanifestと一致しない場合や、計画がない場合はserviceを渡さない（画面は未接続を表示する）。

C5-1の実装で次を定めた。

- **系列**: 起動時に`recording_plan_state`で読んだ適用済み計画の、解決済みmapping（無効な計画では登録済みmapping）のmemberを`seriesId`・`label`（`externalName`）とする。計画を変える操作（C5-2以降）はこの一覧を更新する。
- **Projectとの照合**: Projectの`recordingPlan.planId`が適用済み計画の`planId`と一致するときだけcontextを返し、`projectId`・`projectRevision`はそのProjectの値を入れる。`contextId`は`applied:<適用revision>`とする。一致しない、計画がない、storeがないときは`null`を返し、画面は未接続を表示する。
- **画面への受け渡し**: `App`にProjectの置換えを通知する`onprojectchange`を加え、`NativeShell`がProjectのID・revision・計画IDが変わるたびに`history_context`を呼び直してserviceを作り直す。返信を待つ間と前のProjectへの返信は捨てる（serviceなし）。履歴はHubではなく記録DBを読むので、Hubの接続・切断に従わない（§8の6）。
- **照会**: `history_query(callId, query)`は一件ずつ実行し、後の要求は前の要求の終了を待つ。期限は5秒。`callId`は呼出し側が引くIDで、H1の`requestId`とは別である。`history_cancel(callId)`は実行中の同じcallIdにだけ取消を通知し、照会より先に届いた取消は記録して、その照会を実行しない。エラーは`unavailable`・`busy`・`cancelled`・`deadline`・`tooManyPoints`・`invalidRequest`・`failed`で、画面へは`deadline`・`tooManyPoints`・`busy`をそのまま、他を`failed`として渡す。
- **認可**: 履歴の照会はHubの読取と同じく認証を要求しない。

### 7.2 記録操作

[client接続境界](historian-recording-wire-client-boundary.md)§10は、現在のv1 local portへwireの情報を落として載せることと、通常Appへ三つ目の注入propを加えることを禁じている。そこで次のとおりとする。

- v1の`AsyncRecordingOperationsPort`を**port v2**へ改訂する。ownerEpoch、`ownerClosed`・`authorizationLost`・`resyncRequired`・`nativeRecoveryRequired`の別field、leaseの`role`、元callの終端とcached frameの別経路、配送の`readUncertain`を表す。v1のportを渡したcoordinatorは作成時に拒否する。
- `createAsyncRecordingOperationsCoordinator`はport v2だけを受け、`AsyncOperationsClient`の形とbrandは変えない。通常Appのpropは増やさない。
- port v2のnative実装（`native/recording/`）は、Tauri commandの呼出しと`getCurrentWebview().listen("scada:recording")`の受信を、test-onlyの台帳（`recording-wire-delivery-ledger`）と受信器（`recording-wire-receiver`）へ通す。現在の世代と違う`seq`の返信・eventは捨て、`ended`と再読込の後は新しいattachIdでattachし直す。
- 時計は、leaseの期限をhostの`Instant`だけで判定し、JSの`performance.now()`をnativeの期限へ写さない。
- 同期形の`RecordingOperationsService`はnativeでは渡さない（記録操作の入口はasyncの一つにする）。

port v2の型の詳細はC5-5の着手時にこの節へ追記し、レビューを受けてから実装する。

C5-5の設計を次のとおり定めた（2026-11-10、§8.1の判断）。

#### port v2の型

- v1の`AsyncRecordingOperationsPort`・`LocalLeaseRequest`・`LocalCancelRequest`・`LocalOwnerFrame`・`LocalOperationObservation`・`LocalReconciliationObservation`は削除し、`recording-async/port.ts`をv2の型に置き換える。v1を受ける経路は残さない（test harnessもv2へ移す）。
- portは`defineAsyncRecordingPortV2(impl)`だけが作る。この関数は実装objectの形（下の`AsyncRecordingPortV2Impl`の全method・`scope`・`access`）を検査し、methodを束縛したfrozenなobjectを返して、`port.ts`のmodule内WeakSetへ登録する。返すobjectは`version: 2`を持つ。
- **v1の拒否**: `createAsyncRecordingOperationsCoordinator`は最初に`isAsyncRecordingPortV2(port)`（WeakSetの所属）を確かめ、所属しなければ`Error("Recording async owner: port v2 required")`を投げる。`version`は型の判別（v1型を渡すとcompile errorになる）に使い、実行時の判定はWeakSetだけで行う。`version: 2`を書いただけの構造的な偽物、Proxy、v1 harnessは拒否される。同じportの二度目の使用は従来どおり拒否する（tombstone）。
- **scope**: portは`RecordingWireScope`（`ownerRef`・`ownerEpoch`・`context`）を一つ固定する。native実装では`recording_slot`の`scope`をそのまま使う。一つのportは一つのroot（ownerEpoch）と一つのdesktop session世代（`seq`）だけを受け持ち、別epoch・別`seq`へ付け替えない。
- **元callの終端とcached frameの別経路**: 元call（lease・admission・admission inspection・cancel・call inspection）の結果は`PortCallV2.reply`だけで返る。これは保存済みの正常な元replyでだけresolveし、rejectしない。物理呼出しの終わりは`PortCallV2.transport`で別に返る。subscriptionのsnapshot（cached frame）は`current()`・`subscribe()`の`display`にだけ現れ、元callの`reply`を代用しない。
- **観測**: operation・reconciliationの結果は`observe(target)`の`result`で、observation queryの**終端**reply（`pending`以外）だけを返す。reconciliationの`readUncertain`は正常な終端（`outcome.kind: "reconciliation"`の`delivery.outcome.kind: "readUncertain"`）として返す。`unavailable`もqueryの終端として返し、operationの失敗にもreadUncertainにも置き換えない。返信を失ったattemptや、終端を得られずに打ち切ったqueryは`result`を解決せず、`current().observations`の`transportLost`で表す。
- **owner状態の別field**: `ownerClosed`・`authorizationLost`・`resyncRequired`・`nativeRecoveryRequired`は、それぞれ別のfieldで、どれもほかのfieldへORしない。`ownerClosed`と`authorizationLost`は原因（control frame、hostの拒否、slot、`seq`）を値に持つ。
- **leaseの`role`**: lease要求は`role`（`mutation`・`reconciliation`）を明示し、mutationでは段階（`stage`）を持つ。preflightは予約に使う変更要求の全文、pause/joinとapplyはそのadmissionが運ぶ`operationId`を持つ。ID prefixから役割を推測しない。wireのLeaseRequest本文の`role`と外側の`role`が違えば、portは送らずに`invalidRequest`とする。

```ts
// recording-async/port.ts（v2）
import type { RecordingChangeRequest } from "../recording-operations-contract";
import type {
  RecordingAdmissionRequest,
  RecordingAdmissionReply,
  RecordingAdmissionInspectionRequest,
  RecordingAdmissionInspectionReply,
} from "../recording-admission-contract";
import type {
  RecordingWireScope,
  RecordingWireLeaseRequest,
  RecordingWireLeaseReply,
  RecordingWireCancelRequest,
  RecordingWireCancelReply,
  RecordingWireObservationTarget,
  RecordingWireObservationReply,
  RecordingWireCallInspectionReply,
} from "../recording-wire-contract";
import type { RecordingWireDisplay } from "../recording-wire-receiver";

/** hostが`{"kind": ...}`で拒否した。元replyはない（受理済みかどうかは種類による）。 */
export type PortHostRefusal = Readonly<
  | { kind: "recordingUnavailable"; reason: string }
  | { kind: "invalidRequest" }
  | { kind: "phase"; phase: string }
  | { kind: "unauthorized" | "forbidden" | "authUnavailable" }
  | {
      kind:
        | "invalidInput"
        | "protocolViolation"
        | "capacity"
        | "busy"
        | "expired"
        | "closed";
    }
>;

/** 一回の物理呼出し（Tauri invoke）の終わり。元replyの有無とは別。 */
export type PortTransportEnd = Readonly<
  | { kind: "returned" } // `{seq, reply}`を受け、seqが一致した
  | { kind: "refused"; refusal: PortHostRefusal }
  | { kind: "staleSeq"; seq: number } // 別世代の返信。捨てた
  | { kind: "failed" } // invokeの例外・不正な形。受付不明
>;

export interface PortCallV2<Q, R> {
  /** 送った（送る予定の）元request。owned/frozen。 */
  readonly request: Q;
  /** 保存済みの正常な元replyでだけresolveする。rejectしない。 */
  readonly reply: Promise<R>;
  /** 物理呼出しの終わり。rejectしない。 */
  readonly transport: Promise<PortTransportEnd>;
}

export type PortLeaseRequestV2 = Readonly<
  | {
      role: "mutation";
      stage: "preflight";
      change: RecordingChangeRequest; // recording_workflow_reserveの本文
      lease: RecordingWireLeaseRequest;
    }
  | {
      role: "mutation";
      stage: "pauseJoin" | "apply";
      operationId: string; // action.operation.operationId
      lease: RecordingWireLeaseRequest;
    }
  | { role: "mutation"; stage: "discard"; lease: RecordingWireLeaseRequest }
  | { role: "reconciliation"; lease: RecordingWireLeaseRequest }
>;

export interface PortObservationV2 {
  readonly target: RecordingWireObservationTarget;
  /** queryの終端reply（outcome.kindが`pending`以外）でだけresolveする。 */
  readonly result: Promise<RecordingWireObservationReply>;
}

export type PortOwnerClosed = "controlFrame" | "hostClosed" | "slotEmpty";
export type PortAuthorizationLost =
  "controlFrame" | "ended" | "refused" | "seqChanged";

export interface PortStateV2 {
  readonly version: 2;
  readonly scope: RecordingWireScope;
  /** このportを作ったsessionの権限。`read`ではmutationを送らない。 */
  readonly access: "mutation" | "read";
  /** 束縛したdesktop sessionの世代。最初の正常返信まで`null`。 */
  readonly seq: number | null;
  /** receiverの表示（client境界§4）。cached frameはここだけに出る。 */
  readonly display: RecordingWireDisplay;
  readonly subscription:
    "idle" | "attaching" | "attached" | "ended" | "stopped";
  /** 最後に届いた`ended`の理由。 */
  readonly ended: string | null;
  readonly ownerClosed: PortOwnerClosed | null;
  readonly authorizationLost: PortAuthorizationLost | null;
  /** receiverが再同期を要し、attachし直しが成功していない。 */
  readonly resyncRequired: boolean;
  /** `display.nativeRecoveryRequired`の写し（sticky）。 */
  readonly nativeRecoveryRequired: boolean;
  readonly observations: readonly Readonly<{
    target: RecordingWireObservationTarget;
    query: "pending" | "terminal" | "transportLost";
    attemptsInFlight: number;
  }>[];
  readonly usage: Readonly<{
    ledger: import("../recording-wire-delivery-ledger").DeliveryLedgerState["usage"];
    receiver: RecordingWireDisplay["usage"];
  }>;
}

export interface AsyncRecordingPortV2Impl {
  readonly scope: RecordingWireScope;
  readonly access: "mutation" | "read";
  prepareLease(
    request: PortLeaseRequestV2,
  ): PortCallV2<PortLeaseRequestV2, RecordingWireLeaseReply>;
  admit(
    request: RecordingAdmissionRequest,
  ): PortCallV2<RecordingAdmissionRequest, RecordingAdmissionReply>;
  inspectAdmission(
    request: RecordingAdmissionInspectionRequest,
  ): PortCallV2<
    RecordingAdmissionInspectionRequest,
    RecordingAdmissionInspectionReply
  >;
  /** 元callの返信喪失からの回収（CallInspection）。元callを再送しない。 */
  inspectCall(
    original: PortCallV2<unknown, unknown>,
  ): PortCallV2<unknown, RecordingWireCallInspectionReply>;
  requestCancel(
    request: RecordingWireCancelRequest,
  ): PortCallV2<RecordingWireCancelRequest, RecordingWireCancelReply>;
  observe(target: RecordingWireObservationTarget): PortObservationV2;
  current(): PortStateV2;
  subscribe(listener: (state: PortStateV2) => void): () => void;
}

export interface AsyncRecordingOperationsPortV2 extends AsyncRecordingPortV2Impl {
  readonly version: 2;
}
export declare function defineAsyncRecordingPortV2(
  impl: AsyncRecordingPortV2Impl,
): AsyncRecordingOperationsPortV2;
export declare function isAsyncRecordingPortV2(
  value: unknown,
): value is AsyncRecordingOperationsPortV2;
```

v1との差分:

| v1                                                    | v2                                                                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `ownerRef`・`context`                                 | `scope`（`ownerEpoch`を含む）                                                                                                        |
| `LocalLeaseRequest`（roleなし、`leaseRequestId`なし） | `PortLeaseRequestV2`（`role`・`stage`・`operationId`・予約用change、wireのLeaseRequest全文）                                         |
| 各methodが`Promise<unknown>`（rejectで不明）          | `PortCallV2`（元replyの`reply`と物理終了の`transport`を分ける。どちらもrejectしない）                                                |
| `observeOperation`・`observeReconciliation`のPromise  | `observe(target).result`（queryの終端だけ）。`readUncertain`・`unavailable`は正常な終端                                              |
| `LocalOwnerFrame`（`connected`・`ownerBlocked`だけ）  | `PortStateV2`（`display`、`ownerClosed`・`authorizationLost`・`resyncRequired`・`nativeRecoveryRequired`の別field、`seq`、`access`） |
| `LocalCancelRequest`（`cancelId`なし）                | wireの`RecordingWireCancelRequest`全文                                                                                               |
| 返信喪失の回収手段なし                                | `inspectCall`（CallInspection）                                                                                                      |

#### coordinatorの改訂

- `createAsyncRecordingOperationsCoordinator(port, now?)`は、上のとおりport v2だけを受ける。`AsyncOperationsClient`の形（`context`・`ownerRef`・`current`・`subscribe`・`bindView`）、`ViewLease`のmethod、brand（`isAsyncOperationsClient`のWeakSet）は変えない。通常Appのprop（`recordingAsyncOperations`）は増やさない。
- `context`は`port.scope.context`、`ownerRef`は`port.scope.ownerRef`とする。`ownerEpoch`はcoordinatorの中に持ち、作った要求の`scope`へ入れる。
- **IDの採番**: `leaseRequestId`と`cancelId`はcoordinatorが引く。ID poolへ`lease`と`cancel`の役割を加える。observation・call inspection・attach・controlのIDはportが引く（transportの内部で、coordinatorの比較対象にならない）。
- **lease**: 段階に応じて`PortLeaseRequestV2`を組む（preflightは予約するchange、pause/joinとapplyは作った`RecordingOperationRequest`の`operationId`、reconcileは`role: "reconciliation"`）。`reply`が`issued`ならadmissionへ進む。`rejected`は送らずに終える（`finishUnsent`）。`transport`が`returned`以外で`reply`が来なければ、v1の「leaseのPromiseがreject」と同じく`call: "uncertain"`とする。
- **admission**: `reply`を`integrate`へ渡す。`transport`が`returned`以外で`reply`が来ていなければ`admission: "unknown"`とし、`invalid`にはしない（v1はrejectで`invalid`にしていたが、v2では物理終了の失敗は受付不明であってportの不正ではない）。
- **inspectAdmission（ViewLeaseは不変）**: 元admitの`reply`がない（返信喪失）ときは`inspectCall`で元replyを回収し、元replyが`unknown`のときは従来どおりAdmissionInspectionを送る。CallInspectionの`notFound`で元admitを再送しない。
- **観測**: acceptedのhandleから`observe(target)`を呼ぶ。`result`がoperationの終端なら、v1の`completion`と同じく`original`・`settled`を確定する。reconciliationの終端は`readResult`へ渡し、`readUncertain`は`read: "readUncertain"`とする。`unavailable`の終端と`observations[].query: "transportLost"`は`read: "deliveryUnknown"`（operationでは`settled`のまま進めない）とし、どちらも`safeToSwitch`をfalseに保つ。
- **cached frame**: `display.snapshot`（`snapshotRelation`が`none`以外）を従来の`applyFrameEvidence`の入力とする。snapshotは`latest`の知識だけを更新し、元callの`settled`・creditの解放・`original`の確定に使わない（v1と同じ）。
- **状態の写像**: `connected`は`display.transportConnected && subscription === "attached"`、`ownerBlocked`は`nativeRecoveryRequired`（または操作結果の`recoveryRequired`）とする。coordinator自身の`closed`へ`ownerClosed`等をORしない。四つの別fieldと`seq`は`AsyncOperationsState`へ追加のfield（`owner`）として出す。`ownerClosed`・`authorizationLost`・`resyncRequired`の間は、すべての`can*`をfalseにする（`common()`の条件に加える）。
- **access**: `port.access`が`read`なら、preflight・pause・apply・discard・cancel（operation）を`can*`の段階でfalseにし、portへ送らない。
- **`intact()`**: portはfrozenで、methodを差し替えられないので、v1のmethod同一性検査は不要になる。scopeの比較だけを残す。

#### native実装（`src/native/recording/`）

| file            | 内容                                                                                                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commands.ts`   | 10個のregistry commandと`recording_slot`の呼出し。`{seq, reply}`と`{kind, ...}`の解析（`PortTransportEnd`への変換）                                                                    |
| `events.ts`     | `getCurrentWebview().listen("scada:recording")`の受信と、payload（`frames`・`ended`）の解析                                                                                            |
| `port.ts`       | `createNativeRecordingPortV2`。scopeごとに台帳（`createRecordingWireDeliveryLedger`）・受信器（`createRecordingWireReceiver`）・local-v2配送を作り、`defineAsyncRecordingPortV2`で返す |
| `operations.ts` | `createNativeRecordingOperations(invoke, listen, publish)`。slotとsessionに従ってport・coordinatorを作り直し、`AsyncOperationsClient`をpublishする                                     |
| `*.test.ts`     | 各fileのvitest                                                                                                                                                                         |

**commandの対応**（引数名はTauriの既定どおりcamelCase）:

| port v2                                      | command                                                                                                                             | 台帳・受信器                                                                                                                                  |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepareLease`（mutation・preflight）        | `recording_workflow_reserve({request: change})`→`recording_workflow_lease({stage: "preflight", operationId: null, request: lease})` | reserveの返信（`{changeId}`、wire文書でない）はportが`change.changeId`と照合するだけで台帳に入れない。leaseは`beginOriginal`→`acceptOriginal` |
| `prepareLease`（mutation・pauseJoin／apply） | `recording_workflow_lease({stage, operationId, request: lease})`                                                                    | 同上（lease）                                                                                                                                 |
| `prepareLease`（mutation・discard）          | `recording_workflow_lease({stage: "discard", operationId: null, request: lease})`                                                   | 同上                                                                                                                                          |
| `prepareLease`（reconciliation）             | `recording_lease({request: lease})`                                                                                                 | 同上                                                                                                                                          |
| `admit`                                      | `recording_admission({request})`                                                                                                    | `beginOriginal`→`acceptOriginal`。acceptedのhandleは`bindObservationTarget`の元になる                                                         |
| `inspectAdmission`                           | `recording_admission_inspection({request})`                                                                                         | `beginOriginal`→`acceptOriginal`                                                                                                              |
| `requestCancel`                              | `recording_cancel({request})`                                                                                                       | `beginOriginal`→`acceptOriginal`                                                                                                              |
| `inspectCall`                                | `recording_call_inspection({request})`                                                                                              | `beginInspection`→`acceptInspection`（attemptごと）。回収した元replyは元tokenのterminalになる                                                 |
| `observe`                                    | `recording_observation({request})`                                                                                                  | `bindObservationTarget`→`beginObservation`→`acceptObservation`。`pending`なら`repeatObservation`                                              |
| （内部）attach                               | `recording_attach({request})`                                                                                                       | `receiver.beginAttach`→`acceptAttach`                                                                                                         |
| （内部）snapshot・detach                     | `recording_control({request})`                                                                                                      | `receiver.beginControl`→`acceptControlReply`                                                                                                  |

- **送信の順序**: 元callは、台帳の`begin*`（または受信器の`beginAttach`・`beginControl`）で元requestと最大replyを予約してから`invoke`する。予約が`capacity`等で失敗したら送らず、`transport`を`refused`相当（`{kind: "capacity"}`）で終える。
- **返信の受取り**: `invoke`の値が`{seq, reply}`で、`seq`が束縛した世代と一致すれば、`reply`を台帳・受信器の`accept*`へ渡し、local-v2の`pump()`で`PortCallV2.reply`へ一度だけ配送する。`transport`は`returned`。値の形が違えば`failed`、`{kind}`での拒否は`refused`とする。どれも元callを台帳のpendingのまま残し、再送しない。
- **世代（`seq`）**: portは最初に`returned`となった返信（通常はattach）の`seq`を束縛する。以後、別の`seq`の返信は台帳へ渡さずに捨て、`transport: staleSeq`、`authorizationLost: "seqChanged"`とする。`frames` eventも`seq`が違えば捨てる。`unauthorized`の拒否は`authorizationLost: "refused"`とする（registryは登録・監視を続ける。host-gate §5）。
- **root（ownerEpoch）**: rootの世代（`recording_slot`の`generation`）はportの作成時に一つ固定し、slotが別の`generation`になったら作り直す。`recordingUnavailable`の拒否は`ownerClosed: "slotEmpty"`、`closed`の拒否は`ownerClosed: "hostClosed"`とし、どちらもslotを読み直す契機にする。stateのsnapshotとcontrol frameは、受信器へ渡す前に`scope`（`ownerEpoch`を含む全文）がportのscopeと一致するかを確かめ、違えば捨てる（受信器へ渡すとscope不一致で受信器が停止するため）。
- **`scada:recording`の受信**: hostは`frames`・`ended`のeventに、そのrootの`ownerEpoch`を加える（`RecordingEvent`の1field。rootの`generation`はhostに留める）。portは最初のattachより前に`listen`の登録を終える。eventの`ownerEpoch`がportのscopeと同じで、`subscriptionRef`が現在のattachの購読と一致するものだけを受信器へ渡す。rootは`native-subscription:1`から参照を引き直すので、`ownerEpoch`がないと短時間に二度入れ替わったときに旧rootの`ended`が新しい購読に当たりうる。
  - attachの返信より先に届いた`frames`は、attach中の世代へ渡す（受信器の`attaching`中のprovisional処理。`provisionalRef`で購読が固定される）。
  - `frames`の`state`は`acceptState`、`control`は`acceptControlFrame`へ、この順に渡す。`control`が`ownerClosed`なら`ownerClosed: "controlFrame"`、`authorizationLost`なら`authorizationLost: "controlFrame"`とする（受信器の表示にも同じ事実が残る。portのfieldは原因つきの別の記録）。
  - `ended`は、`ownerEpoch`がportのscopeと同じで、`subscriptionRef`が現在の購読のときだけ扱う。受信器の世代を`retire`し、`subscription: "ended"`、`ended`へ理由を記録する。理由が`unauthorized`・`forbidden`なら`authorizationLost: "ended"`、`closed`なら`ownerClosed: "hostClosed"`とし、attachし直さない。それ以外（`invalidInput`、`capacity`など）は、新しいattachIdで一度だけattachし直す。続けて`ended`になったら`subscription: "stopped"`とし、自動ではやり直さない。
  - 受信器が`resyncRequired`になったら、新しいattachIdで`afterRevision: null`のattachをし直す。成功するまで`resyncRequired: true`とする。回数は`ended`と同じ上限を共有する。
- **観測のrepeat**: `observe`は一つのtargetに一つのquery（observationId）を作り、`pending`の間は250ms（hostの`FRAME_POLL_INTERVAL`と同じ）ごとに同じrequestを送る（台帳の`repeatObservation`で新しいattempt）。attemptの返信を失った（`transport`が`returned`以外）queryは、そのqueryをrepeatしない。新しいobservationIdのqueryを最大2回まで作り直し、それでも終端を得られなければ`query: "transportLost"`とする。observationは読取だけで、native処理を起こさない。
- **再読込（page reload）**: hostはpageの終わりにそのpageの購読を終える（`Pages`・`end_page`）。新しいpageでは新しい台帳・受信器・portを作り、新しいattachIdでattachする。前のpageの元callのtokenは引き継がない。前のpageで予約したworkflowは、新しいcoordinatorでは続けられず、snapshotの表示（`lastKnown`／`currentSubscription`）だけになる。画面は「前の画面の作業が残っています。アプリを終了すると候補は破棄されます」と案内する。hostから保持workflowを引き継ぐ読取commandと、同じprincipalの再login後のCallInspectionによる回収は後続の区切りで扱う。§9の「再読込後のattachし直し」は表示までとする。
- **slotがEmptyのとき**: `recording_slot`が`{"state": "empty", "reason"}`ならportもcoordinatorも作らず、`recordingAsyncOperations`へ`undefined`をpublishする（記録操作画面は「未接続」）。理由は記録管理画面の照会で示し、記録操作画面へ新しいpropで渡さない。
- **slotの読み直し**: 次の契機で`recording_slot`を読み直す。定期的なpollingはしない。
  - 起動時、sessionの変化（`ManagementAccess.sessionKey`）、ProjectのID・revisionの変化。
  - `ownerClosed`になったとき（原因が`controlFrame`・`hostClosed`・`slotEmpty`のどれでも。`ended`の`closed`、`recordingUnavailable`・`closed`の拒否を含む）。
  - `authorizationLost: "seqChanged"`になったとき（sessionKeyの変化を画面が検知しないまま、hostのsession世代が変わった場合）。
  - `ownerClosed`・`authorizationLost`以外の理由の`ended`で、attachし直しの上限に達したとき（`subscription: "stopped"`）。
  - 記録管理画面の操作（初回設定・停止・再開・停止中の計画適用・owner contextの付け替え）の完了。
- **作り直し**: 読み直して`generation`が変わっていれば、旧coordinatorを`close()`し、新しいportとcoordinatorを作ってpublishする。`seqChanged`の後は、`generation`が同じでも新しいportとcoordinatorを作る（portは一つの`seq`だけを受け持つため）。slotが`Empty`ならpublishを`undefined`にする。旧coordinatorは受理済みの監視を続ける（v1の`close()`と同じ）。`seqChanged`以外の`authorizationLost`（logout・権限の喪失）は、sessionの変化で作り直すので、ここでは作り直さない。
- **sessionと権限**: portはsessionごとに作る。未ログインでは作らない。`access`はAdminのsession（認証無効モードの合成Adminを含む）で`mutation`、それ以外で`read`とする。
- **`NativeShell`**: `createNativeRecordingOperations`の結果を、既存のprop `recordingAsyncOperations`へ渡す。同期形の`recordingOperationsService`は渡さない（§7.2）。

#### 時計

- leaseの期限はhostの`Instant`だけで判定する。portとcoordinatorは`grantedBudgetMs`から期限を計算せず、表示にも使わない。期限切れは、hostの`expired`の拒否か、admissionの返信としてだけ知る。
- JSの`performance.now()`（coordinatorの`now`）は、UIの意図の期限（`intentDeadlineMonotonicMs`。admitを送る前に打ち切る）とtimerにだけ使う。`requestedNativeBudgetMs`は`lease.requestedBudgetMs`へそのまま入れる要求値で、nativeの期限ではない。
- 観測のrepeat間隔（250ms）と`ended`後のattachし直しはJSのtimerで行うが、どちらもnativeの期限を判定しない。

#### 試験

- **vitest（coordinator）**: v1の`__fixtures__/recording-async-port.ts`をv2のharness（`defineAsyncRecordingPortV2`で作る制御可能なport）へ移し、`coordinator.test.ts`・`monitor.test.ts`の既存シナリオを通す。追加: v1形のport・構造的な偽物・Proxyを作成時に拒否する。四つのowner状態を別々に立てて`can*`と表示を確かめる。cached frameが元replyより先に届いてもcreditを解放しない。admitの返信喪失から`inspectCall`で元replyを回収し、元`unknown`を書き換えない。`readUncertain`の正常終端・`unavailable`・`transportLost`を区別する。`access: "read"`でmutationを送らない。leaseの`role`・`stage`・`operationId`が段階どおりになる。
- **vitest（native）**: fakeの`invoke`と`listen`で、段階ごとのcommandと引数、`seq`不一致の返信・eventの破棄と`authorizationLost: "seqChanged"`、`recordingUnavailable`・`closed`での`ownerClosed`、attachの返信より先のframe、別epochのframeの破棄、`ended`の理由ごとの扱いと新しいattachIdでのattachし直し（上限つき）、observationの`pending`→repeat→終端と返信喪失、slot Emptyでのpublishなし、generationが変わったときの作り直しを確かめる。vitest 5では`mockRejectedValue`が未処理rejectとして試験を落とすので、rejectする`invoke`は手書きの関数にする。
- **Playwright e2e（IPC mock、`e2e/native-recording-operations.spec.ts`）**: `native-close.spec.ts`と同じく`__TAURI_INTERNALS__`を差し替え、mock hostがslot・registry command・`scada:recording`を模す（eventはevent名で配送する）。
  1. 予約からapply・reconcileまで: Admin（認証無効モードの合成Admin）でslotが`installed`、preflight→pause/join→apply（`failed`・`effect: unconfirmed`）→reconcile（`receiptFound`）を画面の操作で進め、送られたcommandの順序と引数（`stage`・`operationId`・`role`）を確かめる。
  2. logoutでの`ended`: 購読中にmock hostが`{"kind": "ended", "reason": "unauthorized"}`を送ると、操作ボタンが無効になり、attachし直さないことを確かめる。
  3. 再読込後のattachし直し: `page.reload()`の後、新しいattachIdで`recording_attach`が呼ばれ、snapshotが表示され、前のpageの要求を再送しないことを確かめる。
  4. （追加）`ownerClosed`のcontrol frameの後に`recording_slot`を読み直し、新しい`generation`のscopeでattachすることを確かめる。
- **既存e2e**: `e2e/recording-async-workspace.spec.ts`はv1 harnessを`main.ts`の差し替えで注入しているので、v2 harnessへ移す。
- Rust: `RecordingEvent::Frames`・`Ended`へ加える`ownerEpoch`を`desktop_recording/tests.rs`で確かめる（`cargo test -p scada-host`）。

#### Projectの編集とowner context

- ownerのcontext（`RecordingOperationsContext.target`）は、導入時のProjectの`projectId`・`projectRevision`で作られる。editorは編集のたびに`projectRevision`を上げ、monitorはrevisionが違えば`contextMismatch`とする。そのため、記録を始めた後にProjectを編集すると、そのProjectからはregistryのworkflowを始められない。照合は緩めず、contextだけを付け替える。
- **`recording_owner_rebind(projectJson)`**（Admin、移行lockの下）: 導入中のrootが静止しているとき（ownerが`Idle`、未確定の配送なし）だけ、`try_take`で外し、同じSupervisorで`install_owner`（新しいProjectのcontext、新しいownerEpoch）を行う。記録は止めない。未静止なら`busy`で何も変えず、slotが`Empty`なら`not_allowed`とする。応答は`{"owner": "installed" | "owner_unavailable"}`で、監査は`owner_rebind`（resource `recording`）。
- **画面**: 記録管理画面に、Adminにだけ「記録操作の対象を現在のProjectに合わせる」を出す（明示の操作に限る。§8の7）。slotが`installed`で、そのscopeのProject revisionが現在のProjectと違うときに有効とする。完了したら`recording_slot`を読み直す。

## 8. 確定事項（2026-11-09ユーザー判断）

2026-11-09のユーザー判断で、次の7点を推奨案のとおり確定した。

1. **記録DBの置き場所**: アプリdata dir（`%LOCALAPPDATA%\temp-scada`）の`historian\`と`historian-store.json`とする。
2. **起動時の自動再開**: 行わない。再起動後は`Idle`で起動し、Adminが「記録を再開」を押す（supervisor設計の「自動復旧ではない」に合わせる）。押すまでregistryは`no_recording_run`である。
3. **終了時の待ち時間の上限**: 10秒。越えたら終了し、欠測として扱う。
4. **既定の保持方針**: 経過時間で30日保持とする（`CutoffRule::Elapsed`）。容量の評価と変更の操作はC6で扱う。
5. **初回設定の画面**: 記録管理画面（「記録管理状態」）へ、Adminにだけ「初回設定と開始」「記録を再開」を加える。記録が止まっている間は「停止中に計画を適用」（`recording_reconfigure`）も加える（確定後のレビューで追加）。Projectの`recordingPlan`をそのまま使い、別の入力欄は作らない。
6. **Hub切断と記録**: ヘッダーのHub切断は読取だけを止め、記録は続ける。記録の停止は明示の操作だけとする。
7. **適用後の再開**: registryのapplyの後、記録は止まったままになる（§4）。記録操作画面で適用が確定したら「記録を再開」を案内し、Adminが押して再開する。自動では再開しない（失敗時の再試行と受付不明の扱いを明示の操作に限るため）。

## 8.1 確定事項（2026-11-10ユーザー判断）

2026-11-10のユーザー判断で、C5-5の設計の次の13点を推奨案のとおり確定した（§7.2に反映）。

1. **Projectの編集とowner context**: Adminの`recording_owner_rebind`で、静止したrootのcontextを現在のProjectへ付け替える。画面のボタンで明示的に行う（C5-4b）。照合（Project revision）は緩めない。
2. **portが束縛する`seq`**: 最初の正常返信（通常はattach）の`seq`を束縛する。portはsessionごとに作り直す。
3. **eventのroot識別**: `scada:recording`の`frames`・`ended`へ`ownerEpoch`を加える（hostの小変更、C5-5b）。
4. **slotの変化**: 起動、session・Projectの変化、owner終了（`ownerClosed`）、`seqChanged`、attachし直しの上限、記録管理画面の操作の完了を契機に`recording_slot`を読み直す（§7.2）。pollingもslotのeventも加えない。
5. **再読込・session交代後のworkflow**: C5-5では表示と案内までとする。hostからの引継ぎは後続で扱い、browser storageへは保存しない。
6. **owner状態の出し方**: `AsyncOperationsState`へ追加のreadonly field（`owner`・`hostRefusal`）を加え、既存のfieldへまとめない。
7. **`leaseRequestId`・`cancelId`**: ID poolへ`lease`・`cancel`の役割を加えて引く。
8. **observationの返信喪失**: 新しいobservationIdのqueryを自動で最大2回作り直す。
9. **observationのrepeat間隔**: `pending`の間250ms。
10. **slotがEmptyの理由**: 記録操作画面は「未接続」だけとし、理由は記録管理画面に出す。propを増やさない。
11. **local-v2の`mode`**: `"native"`を加え、native portはlocal-v2で元replyを配送する。coordinator-v2（test-only）は製品で使わない。
12. **長時間のrootの容量**: 上限に達したら`capacity`で止め、再読込で回復する。回収はC6で扱う。
13. **再login後の回収**: C5-5では扱わず、5と一緒に後続で扱う。

## 9. 実装順

| 区切り                        | 内容                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C5-1 記録DBと履歴読取         | **実装済み（2026-11-09）**。`historian-store.json`とstoreの作成・open（§3）、`RecordingRuntime`の起動（Supervisorは`Idle`のまま）、`history_context`・`history_query`・`history_cancel`のcommand、nativeの`HistoryService`。一時DBの試験とIPC mockのe2e                                                                                                 |
| C5-2 初回設定と開始           | **実装済み（2026-11-09）**。`recording_status`・`recording_initial_setup`（§5）、記録管理画面の照会と操作。mock Hub＋一時DBで、mappingからtickの保存まで。受付不明からの再実行                                                                                                                                                                          |
| C5-3a ownerとgateの導入       | **実装済み（2026-11-09）**。gate内のslot（§4）、開始後のgate導入、`recording_slot`・`recording_stop`、終了処理の1・3・4（§6）、期限切れのdiscard leaseの取り直し（§6.1、`scada-runtime`の変更）。registry commandが`Running`の記録に対して働くこと（scada-hostの一時DB＋mock Hub）と、gateを外すと購読が`ownerClosed`で終わること（src-tauriのIPC試験） |
| C5-3b1 終了時の破棄           | **実装済み（2026-11-09）**。Candidateの終了時破棄（§6.1、`HeldWorkflow`へのdiscard leaseの記録、hostの合成actorの監査）、Pausedでの即時終了。§6.1の試験                                                                                                                                                                                                 |
| C5-3b2 確認dialog             | **実装済み（2026-11-09）**。`CloseRequested`の確認dialog（§6.1）。gateの`close_check`による判定、UIへの通知（`scada:close`）と回答（`app_close_reply`）、「破棄して終了」「キャンセル」、UIの応答なしでの続行。IPC mockのe2e                                                                                                                            |
| C5-4 再開                     | **実装済み（2026-11-10）**。`recording_resume`（applyの後と再起動後）、`recording_reconfigure`（停止中の計画変更と無効計画からの有効化）、fresh SDK解決、gateの入替え、`interrupted`の表示                                                                                                                                                              |
| C5-4b owner contextの付け替え | `recording_owner_rebind`（§7.2）と記録管理画面のボタン。静止したrootのhandoffと同じSupervisorでの再導入、未静止での`busy`。scada-hostの一時DB＋mock Hubの試験とIPC mockのe2e                                                                                                                                                                            |
| C5-5a port v2とcoordinator    | port v2（§7.2）、`defineAsyncRecordingPortV2`、coordinatorの改訂、v2 harnessへの移行（vitest・`recording-async-workspace` e2e）。TSのみで、通常Appの接続は変えない                                                                                                                                                                                      |
| C5-5b 記録操作の画面接続      | native実装（`src/native/recording/`）と`NativeShell`の接続、`scada:recording`への`ownerEpoch`（host）、local-v2の`mode: "native"`。IPC mockのe2eで予約からapply・reconcileまで、logoutでの`ended`、再読込後のattachし直し（表示まで）、`ownerClosed`の後のslotの読み直し                                                                                |
| C5-6 Windows実機受入          | 実Hubを読み、検証用DBへ記録し、履歴画面と保存Trendで確かめる。UIを閉じない間の継続、停止・join・明示再開、raw／minmax、欠測・Quality・SIM、再起動後の照会、実時間の件数とDB増分を記録する（ユーザー作業）                                                                                                                                               |

C5-1は記録registryと独立で、C5-2以降の前提（store・`RecordingRuntime`）を置く。C5-5はC5-3aの後ならC5-3b・C5-4と並行できる。C5-4bとC5-5aは並行でき、C5-5bは両方の後に行う。
