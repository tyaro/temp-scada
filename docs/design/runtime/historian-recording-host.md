# Historian H3c: 単一groupの記録実行hostと終了所有

2026-11-01。状態: **Astra 主設計、ローカル実装・受入済み。全体CIはPRで確認する**。[H3a周期recorder](historian-periodic-recorder.md)と[H3b専用SDK source](historian-sdk-source.md)を接続するlibrary実行ownerである。

## 今回閉じる境界

callerのテストハーネスに置かれていた、専用source・同期recorder・SQLite writerの開始、反復実行、停止、join、plan差替えを再利用可能なRecordingHostへ移す。storeが許すactive sessionは一つなので、単一固定groupに限定する。複数group scheduler、queue／spool、永続slot台帳、製品設定配布、auth／transport、UI、サービスインストールは追加しない。

明示inprocess planを使用し、SDK接続先とwriterはcallerが渡す。通常App／実Hub／S7／実環境へ接続しない。隔離loopbackと一時SQLiteで受入する。DB format 5、H1、SDK固定rev、Project、Bantoを維持する。

## 実行方式

既存tokio::task::spawn_blockingで一つの長寿命blocking workerを作る。同期sleep・capture・SQLite処理をasync executor上で反復しない。専用std threadと別join監視taskを増やさず、Tokio JoinHandleをhostが保持する。

SDK workerは外側のTokio runtimeで動く。blocking workerは終了時に捕捉したruntime Handleのblock_onでsource.shutdownを待つ。callerはruntimeをjoin完了まで生存させる。current-thread runtimeでも、hostのjoinをasyncにawaitしてexecutorが動いていればSDKは進められる。一方、そのexecutorのthreadを同期join／sleepで塞ぐ使い方は対象外である。

長寿命blocking workerはblocking poolの一枠を使用する。これは単一groupのlibrary契約であり、group数だけ無制限に増やす設計ではない。外側runtimeを先に停止しても正常終了を保証する、同期I/Oをhard timeoutできる、といった主張はしない。

## APIと入力

最終の綴りは実装に従う。

- RecordingHost::new(SqliteStore): 明示作成／open済みwriterを所有する。DB pathから暗黙create／migrationしない。
- start(plan: SdkRecorderPlan, options: RecordingOptions, client: RestClient): 同期API。新run tokenを返し、worker開始を受理する。記録sessionが正常開始済みというreceiptではない。
- request_stop(): 取消tokenをsetしStoppingを公開する。停止完了を返したと解釈しない。
- join(): asyncでworkerのJoinHandleを借用awaitし、storeをhostへ回収して`Arc<RecordingCompletion>`を返す。
- state()／state_watch(): bounded latestの状態を公開する。
- take_store(): IdleまたはJoinedでwriterを保持している場合だけcallerへ返す。以後hostはNoStoreとなりstartを拒否する。

RecordingOptionsはPlanRef、任意slot_count、max_clock_skew_ms、clock_epoch。SessionSpecとperiod_msはSdkRecorderPlan.session()から一意に取得し、別のsessionや周期入力を二重に渡さない。H3aに読み取り専用RecorderConfig::validateを追加して同じ内部正規化検証をstartと共有し、PlanRef::validateも既存TimedStart検証から抽出して利用する。staticな不正入力はSDK接続前に拒否する。clock_epochはSystemRecorderClock::newで検証し、実anchorのreadはworker開始時に行う。actual clock anchor、既存session、active retention job、DB障害等の実行時条件はworkerのRecorder::startで判断する。

startにはTokio runtime contextが必要である。runtime無し、既存worker未join、NoStore／Faultedは同期要求エラーとして扱う。開始失敗を受けて暗黙に別planや短い周期へ切り替えない。

## 所有と状態遷移

hostはIdle／Joined時にはstoreを持ち、実行中はworkerへstoreと専用sourceを移す。hostには取消token、run token、JoinHandleが残る。worker終了結果はstoreと終了reportを返す。

| phase            | 意味                                                     |
| ---------------- | -------------------------------------------------------- |
| Idle             | 新規host、workerなし。hostがwriterを保持                 |
| Joined           | workerをjoin済み。hostがwriterと直近completionを保持     |
| Starting         | worker受理済み、Recorder::startの成否は未確定            |
| Running          | 記録session開始済み、周期stepを実行中                    |
| Stopping         | 停止要求済み。進行中capture／commit／cleanupが残り得る   |
| FinishedUnjoined | worker終端結果が公開されたがhostによるjoin確認前         |
| Faulted          | panic／JoinError等でstore回収不能。host内で再startしない |
| NoStore          | 明示take_store後。start不可                              |

phase名は内部表現に合わせてよいが、FinishedUnjoinedとIdle／Joinedの意味を混同しない。thread完了通知はwriter解放通知でもない。正常join後はstoreがhostへ戻るため、writer lockはIdle／Joinedでもhostが持つ。明示take_storeしたcallerがdropするか、Idle／Joined hostをdropして初めて解放する。

run tokenはopaqueなprocess内identityで、Project ID、session ID、SDK generationとは別にする。各statusへtokenを載せ、過去runのArcを保持するcallerが新runと区別できるようにする。tokenを永続再開tokenにしない。

## 開始とworkerループ

static plan／optionsを検証し、SDK sourceを開始する。storeをworkerへ移す前に失敗した場合はhostのstoreを維持する。workerは初めに取消を確認し、既に要求済みならRecorder::startとDB session作成をスキップし、source shutdownだけを行う。

取消されていなければSystemRecorderClockを用意してRecorder::startを行う。失敗時もsourceをshutdownし、storeと開始エラーを返す。成功後はH3aのstepを反復する。各stepのreceipt／counterを状態へ反映し、terminalになったらループを終了する。source変更によるsticky停止、時計異常、DB FULL等を自動restartで消さない。

H3aのabsolute deadline、slot0、観測UTC、missed数、gapとtickの別commitという境界を変更しない。hostの反復制御が「step終了後さらにperiod sleep」を追加してはならない。有限slot_count完了時のhorizon待機と実時刻closeもH3aへ委ねる。

## bounded latest状態

statusはwatch<Arc<RecordingHostStatus>>の一枠を基準にする。全tick reportを無制限queueへ送らず、遅いsubscriberは途中更新を飛ばし得る。これは診断statusであり全commitの監査ログではない。

statusはrun token、phase、stop_requested、RecordingProgress（累積RecorderCounters、直近観測slot／lateness、直近成功commit／gap receipt、停止・cleanup分類）、開始エラーの安全な文字列、SDK shutdown結果を持つ。同じrun内で直近stepのobservation／tick receipt／gap receiptがNoneなら、それぞれ前回の値を維持する。counterと停止・cleanup分類は現在stepの結果を使う。観測・tick・gapは種類ごとの最新値なので、同一stepの組とは限らない。たとえば最新観測のcommitが失敗した場合、観測は新しくてもreceiptは以前の成功分を指す。全receiptをqueueに保存する保証はしない。raw観測値、endpoint、API key、生のSDK／SQLiteエラー本文、DB pathは公開しない。保持するreportは最大一つまたは固定個数に限定する。RecordingCompletion.progressにも同じ最終sanitized progressを格納する。詳細なRecorderReport／RecorderStartErrorはjoinのRecordingCompletionだけに保持し、reportはmergeせず最後のH3a結果そのものとする。公開statusのRecordingProgressへは有限分類とStoreErrorの安全なDisplay文字列で投影する。Joinedではこのcompletionを保持して再joinに同じ結果を返す。

request_stopとworker publishは同じ現在状態に対して判定する。旧tokenの更新を拒否し、Stoppingになった後のstep完了がRunningへ戻さない。進行中commitのreceipt／counter更新は維持し、terminalだけFinishedUnjoinedへ進める。取消tokenの確認だけで競合する無条件send_replaceを行わず、現在phase／tokenを含む更新を原子的にする。

## 停止、join、取消

request_stopは取消をsetするだけであり、同期I/Oを中断しない。H3aは次の確認点で新規採取を止め、既に成功したcommit／gapのreceiptとcounterを保持する。最後のcleanup完了後にsource.shutdownをawaitする。SDK shutdown失敗をrecorder成功で隠さず、別結果として返す。

joinはJoinHandleをself内に残したまま`&mut JoinHandle.await`する。futureを途中で取消してもJoinHandleやstoreの所有を失わない。callerは改めてjoinできる。join単独は停止要求ではなく、有限完了または自然停止まで待つ。通常停止はrequest_stop→joinである。

callerがtimeoutを使う場合は、このjoin futureを外側でtimeoutできる。ただしtimeoutは「まだjoin未確認」であり、Joinedへの遷移、別planの開始、writerの返却を許可しない。JoinHandle::abortを停止手段にしない。実行中blocking taskはabortでは停止できず、未開始taskだけを破棄して所有・cleanup経路を変える危険もある。

workerのpanic／JoinErrorは正常終了としない。storeを回収できないhostはFaultedとなり、同じhostへ代替storeを暗黙注入して継続しない。SDK ownerのDropはbest-effort abortに留まり、join成功とは呼ばない。callerは障害を確認して外側でstoreを再openし、既存のinterrupted復旧を行う。

Dropは取消をsetするがblocking workerをabortせず、JoinHandleをdetachする。workerが動いている限りstoreを所有するため、writer lockはcleanup終了まで残る。Drop自体はjoin保証／即時解放保証ではない。runtime終了や停止不能I/Oのため完了しない可能性も明記し、製品hostは明示stop/joinを使用する。

## planの差替え

専用replace wrapperは必須にしない。callerがrequest_stop→join→start(new plan)を明示する。workerが自然終了していても未joinなら新startはBusy。join後の旧SDK shutdown／recorder cleanup失敗をcallerへ返し、正常差替えと偽称しない。

新planは新session ID／明示identityを要求する。source変更や同名再作成を旧sessionへ自動継続しない。新start時には新run tokenを発行する。古いwatch frameや遅れたworker通知が新run状態を上書きしない。

正常にstoreを回収できてもNeedsReopen等の失敗が残り得る。そのstoreで新startが失敗することを許し、hostがDB障害を消したり勝手にreopenしたりしない。単一active session／active retention jobの制約は既存storeを権威とする。保持掃除のための自動停止・再開協調は後続である。

## 受入

- current-thread Tokio上でloopback SDK workerが動き続け、hostのblocking workerがH3a→SQLiteへ記録する。UI ownerと独立し、async heartbeatが同期sleep／DB処理で塞がれない。
- static invalid options／runtime無し／Busy／NoStoreで開始を拒否し、不要なDB sessionや接続を作らない。worker内開始失敗でもsource shutdownとstore返却を行う。
- 有限slot完了→FinishedUnjoined→join→Joined、明示停止→cleanup→SDK join、最後commitのreceipt維持を検証する。
- request_stop直後の進行中step完了でもphaseがRunningへ戻らない。状態は一枠であり、低速readerがいても無制限蓄積しない。
- join future取消／外側timeout後もstartとtake_storeは拒否し、再joinでstoreを回収できる。SDK shutdown未確認を成功と偽称しない。
- 旧run stop/join後だけ新session／tokenで開始する。古いstatus参照を新runと区別でき、旧publisherが状態を巻き戻さない。
- SDK shutdown失敗、worker panic、開始時DB失敗をhost経路で検証し、自動restartしない。時計異常／実SQLite FULL／gap後tick失敗はH3aの実試験を継承し、host側は診断投影の分離を検証する。今回host統合試験で実時計jumpや実FULLを新たに注入したとはしない。
- Drop後もworker cleanup中は別writer openがBusyで、worker終了後に解放される。正常Idle／Joinedでもhostがstoreを所有している間はBusyで、take_store後のdropで解放される。
- 1秒周期での位相固定をH3aから維持し、hostが相対sleepを追加しない。OS／I/Oのhard realtime保証はしない。

H3cで単一groupの常時実行ownerを完成対象とする。desired計画の製品配布、recording planの永続CAS、複数group、retentionとの休止協調、容量運用、サービス化、実環境接続は次工程に残す。

## 実装・検証結果

`scada_runtime::recording_host`にHost、options／opaque run token／status／completion、workerを分離した。static validationをH3a／evidenceと共有し、DB format 5・H1・外部依存を維持する。statusは安全なprogress一枠、completionは最後の詳細H3a結果を保持し、SDK shutdownの成否を分離する。

Rust workspace360件（新規6単体・7統合）・Clippy `-D warnings`／rustfmt・関連Chromium6件が成功。単体は制御gateを使ったjoin取消、Drop中のwriter lock、panic後Faulted／明示reopen、worker開始前取消によるDB無変更、Stopping／旧run通知拒否、最新receipt維持と診断の生エラー非公開を担当する。

loopback統合はcurrent-thread SDKの稼働、有限horizonから実SQLiteへの記録とraw照会、未join中のBusy、join timeoutからの再join／新session差替え、static拒否・runtime無し・開始時DB失敗、UnauthorizedとSDK shutdown失敗、Drop後のcleanupを検証する。H3bの既存9統合も共有mock Hub fixtureへ移して回帰した。Astra最終レビューに必須修正はない。

実S7の点数／精度、host固有の実FULL・実時計jump、停止不能I/Oやruntime早期破棄のhard timeoutを新たに保証しない。H3aの仮想1時間3600枠・実FULL・時計異常等の回帰は成功しており、hostが追加の相対sleepや自動restartで契約を変えないことを維持する。

## H3dで追加した再開条件

[記録と保持の協調](historian-recording-retention.md)で、Joinedからの再開をclean pause、job未完了／不明なし、保持の停止状態解除済みに限定した。新sessionと直前runとは異なるclock_epochを要求する。異常終了やInterruptedを通常再開で修復せず、必要な手動復旧はtake_store等の明示経路へ返す。保持workerが未joinの間もstart／take_store等はBusyとなる。
