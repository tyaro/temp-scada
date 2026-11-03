# Historian H5c1: managed計画からのRecorder開始

状態: Astra主設計の採用契約、H5c1は実装・ローカル受入済み。2026-11-03（日本時間）。

[計画台帳](historian-recording-plan-ledger.md)、[原子的activation](historian-recording-activation.md)、[RecordingHost](historian-recording-host.md)、[保持協調](historian-recording-retention.md)に続く。DB7、Project 0.36.0、H1、固定SDK、依存を維持する。

## 目的と区切り

H5b2は適用済み計画とtimed sessionを一つのSQLite commitへ束縛する。現行Recorder::startはmanual beginを使うため、そのままmanaged storeでは動かせない。H5c1では実時計からschedule anchorを決める箇所で専用activationを呼び、同じanchorのRecorderを構築する。専用SDK sourceを持つRecordingHostにも明示managed開始入口を加える。

永続receiptの再送は元commitの照会であり、新worker開始ではない。既存activationを取得して通常Recorder::startへ渡す方法や、再送成功を利用して同sessionをsequence 1から再開する方法は禁止する。

H5c2へ残すのは、Running中のbounded read-only preflight、stop/join、mapping/desired適用、fresh SDK解決、再開を一つのsupervisorで調整する機能。H5c1では自動apply、設定配布、永続Runningフラグ、multigroup、queue、製品認証/transportを追加しない。

## native API

```rust
pub struct ManagedRecorderStart {
    pub activation_id: String,
    pub expected_applied_revision: u64,
    pub expected_mapping_revision: u64,
    pub expected_retention_applied_revision: u64,
}

Recorder::start_managed(
    store: &mut SqliteStore,
    config: RecorderConfig,
    binding: ManagedRecorderStart,
    clock: &mut impl RecorderClock,
    control: &QueryControl,
) -> Result<(Recorder, RecordingActivationReceipt), RecorderStartError>;
```

bindingはID/版の純粋validateを提供する。H1 ID制約、版1..MAX_SAFEを使う。sessionIdはconfig.session、PlanRefはconfig.plan、UTC/clockEpochは開始時clock readingから取り、二重指定しない。period/slot_count/skew検証は既存RecorderConfigのhelperを共有する。

RecorderStartErrorへAlreadyActivated、ManagedBindingMismatch、ActivationUnconfirmed(StoreError)を追加する。前二者は固定の安全な診断文字列とし、DB本文をwatchへ載せない。既存manual startのエラー分類は維持する。

## 開始順序と新規性

全期間、同じ`&mut SqliteStore`と排他的writer ownershipを保持する。各処理の間にcallback、writer返却、別writerへの引渡しを挟まない。

1. config/bindingを純粋検証し、membersを既存の正規順にする。
2. recording_activation(activation_id, control)で既存IDを確認する。Someなら内容/terminal状態を問わずAlreadyActivated。破損をNoneへ変換しない。
3. recording_plan_state(control)を読む。enabled/current applied/mappingが期待版と一致し、適用時保持版がbindingと一致すること、保存PlanRefとconfig.planが一致することを確認する。resolutionの全IdentityDescriptorとconfig.session.membersを正規順で完全比較する。series/nameだけの一致では不十分。現在保持policy版の権威検査はactivation transactionが行う。
4. clock.readを一度呼び、既存valid reading/horizon overflow規則を適用する。このreadingをmonotonic anchor、UTC開始、clockEpochの共通根拠とする。
5. readingとbinding/config.session.session_idからActivateRecordingPlanRequestを作り、activate_recording_planを呼ぶ。現在applied/mapping/保持版、active job/session、fence、新session/epoch、容量はH5b2 transactionが最終判定する。
6. 成功receiptと同じconfig/anchorでRecorderを構築する。通常Recorder::start、clock.read、begin_timed_sessionを再度呼ばない。Recorderとreceiptを一緒に返す。

事前照会は認可tokenではない。新規性の根拠は既存IDを拒否した後も同じ排他的writerを保持することである。別processの正規writerも既存lockにより入れない。サポート外の直接SQLite書込との競合は保証しない。

metadata/PlanRef不一致はactivation前に拒否し、session/commitを作らない。SDK planとconfigは同じSessionSpecから作る。SDK generation/run_id/catalog pinはこの比較の代替identityではない。

## 時計と予定slot

anchorはactivation前の実clock readingで固定する。SQLite処理時間をanchorへ加算しない。初回stepが遅れれば既存slot計算で未観測slotを欠測として扱い、過去予定時刻へ最新値を配らない。sampleTimeはcapture直後の実UTCを維持する。

保存start UTCはsession開始境界であり、初回sampleやcommit時刻ではない。activationが長引いてもanchor+n×periodを維持する。commit後の時計逆行・epoch変更・skew超過は既存stepが停止し、値やgapを捏造しない。

正常な各slot内の処理で1秒周期・半開1時間の予定3600slot/3600commitを仮想時計で確認する。任意UTCの1時間にOSが必ず3600点を保存する保証とは区別する。

## 取消・曖昧な失敗・再起動

元QueryControlのdeadline/limits/tokenを全開始DB操作へ渡す。deadlineをworker起動時や各照会時に更新しない。

| 境界                            | 結果                                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| worker開始前の取消              | SDKをshutdownし、DB activationを行わない                                                 |
| preflight/config/clock失敗      | source.capture/appendを開始せず、start_errorを保持                                       |
| activation呼出のErr             | ActivationUnconfirmed。新Recorderを返さず、保存成否を推測しない                          |
| activation成功後の取消          | receiptを保持してRecorderを返す。最初のstepが取消を見て既存close/interrupt cleanupを行う |
| commit後の応答喪失/process終了  | 再openとactivation照会でreceipt/session状態を回収。新workerへ流用しない                  |
| SDK shutdown/SQLite cleanup失敗 | 詳細completionに残し、clean pause扱いにしない                                            |

ActivationUnconfirmedは未commitの可能性も含む保守的分類であり、commit済みとの断定ではない。失敗直後に自動再送・新IDで再試行・sessionの推測closeを行わない。NeedsReopenを維持する。joinしてstoreを回収した後、必要ならdrop/reopenし、H5b2照会で判断する。activeでも新workerへ再装着しない。明示interruptまたは再openによるinterrupted確定後、新activation/session/epochで開始する。

成功後の終了/障害は既存Recorderのclose/interrupt処理を使う。管理開始だけの特殊なgapを追加せず、新domain間の不明期間はunknownCoverageを維持する。

## RecordingHost接続

```rust
RecordingHost::start_managed(
    plan: SdkRecorderPlan,
    options: RecordingOptions,
    binding: ManagedRecorderStart,
    control: QueryControl,
    client: RestClient,
) -> Result<RecordingRun, RecordingHostError>;
```

共有内部起動処理にmanual/managed開始戦略を渡す。DB検査はblocking workerで行う。sync入口ではconfig/binding/clockの純粋検証と既存owner gateを行ってからSDK sourceを作る。SDKが先に接続を始めてもDB判定失敗ならshutdownまで行い、記録は開始しない。

Busy、finished-unjoined、Faulted、NoStore、UncleanPause、SessionReuse、ClockEpochReuse、retention job_pending/rearm_requiredのgateを共有し、managedだけで迂回しない。acceptedはactivation済み/Runningを意味しない。

SDK pinはcallerがcoherent generationから明示構築し、sourceは既存run/catalog/source identity gateを維持する。H5c1は実Hub/catalogを再取得してfreshnessを証明しない。既存caller-confirmed pin契約を越えず、fresh解決の調整はH5c2へ残す。保存したgenerationを永続identityの証明として再利用しない。

managed workerの取消tokenにはcontrol.cancellationと同じtokenを使い、request_stopもそれをcancelする。deadlineは開始操作専用で、稼働中timerへ転用しない。callerがtokenをcancelすると正常開始後も停止要求になる。

RecordingCompletionへactivation_receipt: Option<RecordingActivationReceipt>を追加する。manual/開始前取消/開始失敗はNone、managed開始成功後はterminalやlate cancelにかかわらずSomeを維持する。詳細receiptはjoin結果に置き、watchは既存の有限診断と安全なerror文字列を維持する。ActivationUnconfirmedのNoneはDB未commitの証明ではない。

borrowed join await、取消中の再join、Drop時cancelのみ、SDK shutdown、cleanupまでwriter保持、panic時Faultedを変更しない。開始失敗後は既存clean-pause gateが再開を止める。自動rearmは追加しない。正常停止後だけ明示的新session/epochで再開する。

## 有限仕事量

管理DB呼出は最大3回。各呼出は既存管理上限256 decoded rows、128KiB文書、8MiB入力、元QueryControlのVM/output予算を維持する。counterはAPI単位なので累積上限は3回分。絶対deadline/tokenは共通で、3回分の新しい10秒を与えない。SQL I/Oのhard期限は保証しない。

32 origins/異保持版と8member検証を再利用し、既定予算で成功することを確認する。新read connection/lease枠/無制限request・report queueを作らない。

## 受入と次工程

- native: fresh appliedから開始し、receipt/start UTC/clockEpoch/spec/PlanRef/初回tickが一致。manual経路も維持する。
- native: 同IDのactive/closed/interrupted receiptをstartへ渡してもAlreadyActivated。H5b2照会/再送自体は従来どおり成功。別ID＋旧session/epochも開始不可。
- native: unit/source/incarnation/segment/period/PlanRef差、disabled、mapping/保持版進行、active job/fence、容量で停止し、captureは0回。
- native: 仮想1h3600slot、activation初回遅延、horizon越え、clock異常、commit前取消/actual FULL/commit後応答喪失、成功後取消。曖昧失敗後にtickを出さずreceipt/cleanup情報を失わない。
- runtime: mockHub→managed RecordingHost→一時SQLite→raw/minmax。全descriptor一致、SourceEpoch、有限終了、SDK executor生存、join取消/Busy/Drop lock。
- runtime: 開始失敗時shutdown、latch/clean-pause gate、正常終了後の新activation/session/epoch、manual managed-store gate。
- restart: 応答喪失後の最新activation照会/interrupted、新domainへの明示再開。自動復旧とは扱わない。

H5c1の完了は適用済み固定計画からworkerへ安全に接続できること。H5c2ではrunning中のread-only管理snapshot/既存2lease上限、停止前拒否、stop/join後のCAS再照合、apply成功とactivation失敗の分離、fresh SDK解決と明示resumeをsupervisorへまとめる。desiredのProject保存・配布UI、実Hub接続・認証・製品transportは別工程である。

## 実装と受入（2026-11-03）

`recorder/managed.rs`が新規性・全descriptor照合・一度のclock readingと専用activationを担当する。manual/managedは`from_anchor`と有限horizon検証を共有し、既存step/close/interruptと位相固定の周期計算を維持する。Hostは開始戦略だけを切り替え、同じworker・source shutdown・join経路を使う。activation receiptはcompletionに保存し、watchへDB本文を追加しない。

native13件、runtime unit2件・integration6件の計21件を追加した。仮想1時間3600slot/commit、activation遅延、既存active/closed/interrupted拒否、全metadata/PlanRef差、disabled/mapping/保持版進行、clock/horizon/予算、commit後応答喪失・取消、owned writerの実FULL/needs_reopenを検証する。32 origins/異保持版の既存回帰にも8memberのmanaged開始を加えた。

mockHub→SDK source→managed Host→一時SQLite→raw/minmaxで実値42/sourceTimeを受け入れ、SDK executorを塞がないこと、join待ち取消/Busy、新session/epochでの明示再開、開始失敗shutdown、共有run token、Dropとreader leaseまでを検証した。Drop後のテストはTokio executorを動かしながらwriter解放を待ち、SDK shutdown完了前に所有を失わないことを確認する。

Rust workspace458件、Clippy／rustfmt、既存H1/desiredのChromium8件が成功した。Astraのread-only最終レビューに必須修正はない。全体Prettier・文書リンクとwork向けReady for Review PRのCIを確認する。DB7・H1・Project0.36・固定SDK/Banto・依存は変更していない。H5c2の事前確認/設定変更supervisorと製品transportは未実装である。
