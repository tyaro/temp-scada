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

| 対象                               | 置き場所・所有                                                                                                                                                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 記録DB（`SqliteStore`）            | アプリdata dirの`historian\`（`store.sqlite3`・`writer.lock`・WAL）。認証DB（`scada-auth.sqlite3`）とは別（host-gate §8.3）。Project・ブラウザstorageには置かない                                                                   |
| store identity                     | `historian-store.json`（`version`・`storeId`・`deploymentId`）。`storeId`は作成時に乱数で引く。`durable.rs`の一時file→sync→置換で、store作成より前に保存する。`open_existing`はこの値で照合し、読めない・不正なら上書きせず拒否する |
| 記録host（新設`RecordingRuntime`） | 起動時に作り、process終了まで保持する。storeから先に`HistoryReader`を一つ取り（readerは最大2つ。残りの一つはSupervisorのpreflight用）、storeを`RecordingSupervisor::try_new`へ渡す                                                  |
| 記録用SDK接続                      | `Bootstrapper::rest_client()`を記録の開始ごとに新しく取る。読取host（`hub_read_start`）のclientと共有しない。Hubの切断操作（`hub_disconnect`）は読取だけを止め、記録は止めない                                                      |
| owner・root・gate                  | 記録が`Running`になった後に、`RecordingOperationsOwner`→`RecordingRegistryOwnerSeed`→`create_recording_root`→`RecordingGate`の順に組む。記録runごとに入れ替える（§4）                                                               |
| `HistoryHost`                      | 起動時に取ったreaderで作り、process終了まで保持する。記録の開始・停止と独立に動く（[History host](historian-history-host.md)）                                                                                                      |

storeが存在しない初回起動ではstoreを作り、`Idle`のSupervisorを置く。storeを開けない場合（identityの不一致、形式違い、別processのwriter lock）は記録hostを`unavailable(理由)`とし、アプリは止めない（認証の起動失敗と同じ扱い、host-gate §6）。

## 4. gateの導入と入替え

registryのapplyは、設定をcommitした後に記録を再開しない（native owner §5「設定commit済み、resumeしない」）。ownerは単一workflowで、resumeはregistryの外にある（§2）。そのため一つのgate（owner・root・ownerEpoch）が受け持つのは一つの記録runで、記録を再開するたびにgateを入れ替える。

```
Empty ──開始・再開──▶ Installed(gate N) ──handoff・停止──▶ Empty ──再開──▶ Installed(gate N+1)
```

- `RecordingSlot`（新設）は`Empty(理由)`か`Installed(gate)`を持つ。`DesktopRecording`と`DesktopAuth`は同じslotを共有し、現在の`AuthState::with_gate`・`DesktopRecording::new`（起動時にgateがある前提）を置き換える。
- slotの変更は移行lock（`AuthHost::gate()`）の下で行う。desktop sessionの`seq`はslotと独立で、registry sessionはgateの中で初回に発行するので、入替えの前後でloginし直す必要はない。
- `Empty`の間、registry commandは`{"kind": "recordingUnavailable", "reason": "no_recording_run" | "store_unavailable" | "owner_unavailable"}`を返し、認証commandはgateなしの経路（現行）を通る。
- gateを外すときは、そのrootの`begin_shutdown`→`try_handoff`でSupervisorを取り戻す。未静止（Candidate／Paused、未確定の配送）なら`busy`で何も変えない。handoffしたrootは閉じ、そのrootの購読には`ownerClosed`のcontrol frameが届く。clientは新しいownerEpochのrootへattachし直す。閉じたrootの不変記録の照会は、gateを外した時点で終わる（新しいrootでは旧ownerEpochの要求を`closed`とする）。
- 新しいgateのownerEpochは`create_recording_root`が世代ごとに引き直す（host-gate §7）。

## 5. 記録制御command

registryの外で、記録の開始・再開・停止をhost独自のcommandとして提供する。照会はViewer以上、他は認証のAdmin（認証無効モードの合成Adminを含む）を要し、移行lockの下で再検証する。

| command                   | 内容                                                                                                                                                                                                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recording_status`        | storeの有無とidentity、Supervisorのphase、適用済みの計画・mapping・保持の各revision、slotの状態を返す。記録管理画面の照会（`RecordingManagementService.inspect`）もこれと同じ読取を使う                                                                                          |
| `recording_initial_setup` | Projectの`recordingPlan`とHubのcatalogから、mapping（`hub_instance_id`と各memberのidentity）を作って登録し、既定の保持方針（§8の4）を適用し、記録計画を適用し、`start_managed`で開始する。storeに適用済みの計画があるときは`not_allowed`（以後の変更はregistryのworkflow）       |
| `recording_resume`        | slotが`Installed`ならgateを外す（§4）。そのうえで適用済みの計画を、fresh SDK解決（新しい`TagClientHandle`で得た一つの`GenerationSnapshot`）で`prepare_resume`し、`resume`で開始する。registryのapply後の再開と、再起動後の再開の両方に使う。記録が`Running`のときは`not_allowed` |
| `recording_stop`          | 設定を変えずに記録を止める。slotが`Installed`ならgateを外してから`request_stop_recording`→`join_recording`を行う                                                                                                                                                                 |

各段階の受付不明を二重に実行しないよう、`request_id`・`activation_id`・`session_id`・`clock_epoch`はhostが一度だけ引いて保存し、再実行は同じ値で照合する（H5b1のreceiptとH5b2のactivation照会を使う）。開始・再開が`Running`になったら、同じcommandの中でgateを導入する。導入に失敗したら記録は止めず、slotを`Empty("owner_unavailable")`とし、理由を表示する。

## 6. 終了

`RunEvent::ExitRequested`で次を順に行う（native registry adapter「recorderを含むnative処理のstop／joinが完了するまでruntimeを終了しない」）。

1. gateがあれば`begin_shutdown`で新規受付を止め、`try_handoff`でSupervisorを取り戻す。未静止（Candidate／Pausedなど）で`Busy`のときも終了は止めない。
2. Supervisorの記録を`request_stop_recording`→`join_recording`で止める。
3. 待つ時間には上限（§8の3）を置く。上限を越えたら終了し、次回の`open_existing`が`interrupted`へ確定する。この場合は記録の欠測として扱う。

UIを閉じても、hostのprocessが生きている間は記録を続ける（C5の完了条件）。トレイ常駐などでwindowとprocessの寿命を分けることは本書の範囲外とし、window終了はprocess終了とする。

## 7. 画面接続

### 7.1 履歴

nativeの`HistoryService`を作る。`source.query`は`history_query` commandで`HistoryHost`の`start_query`→`join_query`を呼び、`AbortSignal`で`history_cancel`を呼ぶ。`context`（v2、`historianNamespace`を含む）はhostが適用済みの計画とstore identityから作り、`history_context(projectJson)`で返す。Projectのmanifestと一致しない場合や、計画がない場合はserviceを渡さない（画面は未接続を表示する）。

### 7.2 記録操作

[client接続境界](historian-recording-wire-client-boundary.md)§10は、現在のv1 local portへwireの情報を落として載せることと、通常Appへ三つ目の注入propを加えることを禁じている。そこで次のとおりとする。

- v1の`AsyncRecordingOperationsPort`を**port v2**へ改訂する。ownerEpoch、`ownerClosed`・`authorizationLost`・`resyncRequired`・`nativeRecoveryRequired`の別field、leaseの`role`、元callの終端とcached frameの別経路、配送の`readUncertain`を表す。v1のportを渡したcoordinatorは作成時に拒否する。
- `createAsyncRecordingOperationsCoordinator`はport v2だけを受け、`AsyncOperationsClient`の形とbrandは変えない。通常Appのpropは増やさない。
- port v2のnative実装（`native/recording/`）は、Tauri commandの呼出しと`getCurrentWebview().listen("scada:recording")`の受信を、test-onlyの台帳（`recording-wire-delivery-ledger`）と受信器（`recording-wire-receiver`）へ通す。現在の世代と違う`seq`の返信・eventは捨て、`ended`と再読込の後は新しいattachIdでattachし直す。
- 時計は、leaseの期限をhostの`Instant`だけで判定し、JSの`performance.now()`をnativeの期限へ写さない。
- 同期形の`RecordingOperationsService`はnativeでは渡さない（記録操作の入口はasyncの一つにする）。

port v2の型の詳細はC5-5の着手時にこの節へ追記し、レビューを受けてから実装する。

## 8. 確定事項（2026-11-09ユーザー判断）

2026-11-09のユーザー判断で、次の7点を推奨案のとおり確定した。

1. **記録DBの置き場所**: アプリdata dir（`%LOCALAPPDATA%\temp-scada`）の`historian\`と`historian-store.json`とする。
2. **起動時の自動再開**: 行わない。再起動後は`Idle`で起動し、Adminが「記録を再開」を押す（supervisor設計の「自動復旧ではない」に合わせる）。押すまでregistryは`no_recording_run`である。
3. **終了時の待ち時間の上限**: 10秒。越えたら終了し、欠測として扱う。
4. **既定の保持方針**: 経過時間で30日保持とする（`CutoffRule::Elapsed`）。容量の評価と変更の操作はC6で扱う。
5. **初回設定の画面**: 記録管理画面（「記録管理状態」）へ、Adminにだけ「初回設定と開始」「記録を再開」を加える。Projectの`recordingPlan`をそのまま使い、別の入力欄は作らない。
6. **Hub切断と記録**: ヘッダーのHub切断は読取だけを止め、記録は続ける。記録の停止は明示の操作だけとする。
7. **適用後の再開**: registryのapplyの後、記録は止まったままになる（§4）。記録操作画面で適用が確定したら「記録を再開」を案内し、Adminが押して再開する。自動では再開しない（失敗時の再試行と受付不明の扱いを明示の操作に限るため）。

## 9. 実装順

| 区切り                  | 内容                                                                                                                                                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C5-1 記録DBと履歴読取   | `historian-store.json`とstoreの作成・open（§3）、`RecordingRuntime`の起動（Supervisorは`Idle`のまま）、`history_context`・`history_query`・`history_cancel`のcommand、nativeの`HistoryService`。一時DBの試験とIPC mockのe2e |
| C5-2 初回設定と開始     | `recording_status`・`recording_initial_setup`（§5）、記録管理画面の照会と操作。mock Hub＋一時DBで、mappingからtickの保存まで。受付不明からの再実行                                                                          |
| C5-3 ownerとgateの導入  | `RecordingSlot`（§4）、開始後のgate導入、`recording_stop`、終了処理（§6）。registry commandが`Running`の記録に対して働くことと、gateを外すと購読が`ownerClosed`で終わることをsrc-tauriのIPC試験で確かめる                   |
| C5-4 再開               | `recording_resume`（applyの後と再起動後）、fresh SDK解決、gateの入替え、`interrupted`の表示                                                                                                                                 |
| C5-5 記録操作の画面接続 | port v2（§7.2）、native実装、coordinatorの改訂。IPC mockのe2eで予約からapply・reconcileまで、logoutでの`ended`、再読込後のattachし直し                                                                                      |
| C5-6 Windows実機受入    | 実Hubを読み、検証用DBへ記録し、履歴画面と保存Trendで確かめる。UIを閉じない間の継続、停止・join・明示再開、raw／minmax、欠測・Quality・SIM、再起動後の照会、実時間の件数とDB増分を記録する（ユーザー作業）                   |

C5-1は記録registryと独立で、C5-2以降の前提（store・`RecordingRuntime`）を置く。C5-5はC5-3の後ならC5-4と並行できる。
