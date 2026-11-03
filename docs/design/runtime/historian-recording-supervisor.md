# Historian H5c2: 記録計画のpreflightと明示的な置換

状態: 採用設計（Astra主設計）。2026-11-03（日本時間）。H5b2はworkへ統合済み、H5c1 managed Recorderは[PR #47](https://github.com/tyaro/temp-scada/pull/47)で実装・CI成功、本文作成時点では未merge。本書の後続設計はsupervisor実装済みを意味しない。

[記録計画](historian-recording-plan.md)、[台帳](historian-recording-plan-ledger.md)、[activation](historian-recording-activation.md)、[所有者](historian-recording-host.md)、[保持協調](historian-recording-retention.md)を継承する。DB7、H1、Project 0.36.0、SDK/Banto/依存を維持する。実Hub/S7/設定/資格情報/本番DBへ接続しない。

## 採用するPR分割

| 工程                      | 閉じる境界                                                                                                | 含めないもの                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| H5c2a（今回の最初の実装） | 既存HistoryReader leaseで、Running中にも使えるnative read-only mapping/apply preflight。writeと検証を共有 | Host停止、mapping/apply書込、SDK再解決、async supervisor     |
| H5c2b                     | Hostの正常pause後、所有を失わず明示mapping登録または計画applyを1回実行。結果receiptと曖昧失敗を保持       | 複数commitを一括原子適用とする保証、自動resume               |
| H5c2c                     | 単一supervisorでpreflight worker/stop/join/各管理turn/fresh解決結果/明示managed resumeを調整              | multigroup、永続task queue、自動接続設定、製品transport/auth |

c2aはworkのH5b2にだけ依存するため、PR47未mergeでもworkから独立実装・受入できる。c2b/cはH5c1統合後に進める。設計だけのPRを挟むことは必須ではない。

## H5c2aの公開API

```rust
HistoryReader::preflight_recording_mapping(
    &mut self,
    request: &RegisterMappingRequest,
    control: &QueryControl,
) -> StoreResult<RecordingMappingPreflight>;

HistoryReader::preflight_recording_plan(
    &mut self,
    request: &ApplyRecordingPlanRequest,
    control: &QueryControl,
) -> StoreResult<RecordingPlanPreflight>;

pub struct RecordingMappingPreflight {
    pub snapshot_commit: u64,
    pub outcome: MappingPreflightOutcome,
}
pub enum MappingPreflightOutcome {
    Replay(MappingReceipt),
    Candidate { active_session_id: Option<String> },
}
pub struct RecordingPlanPreflight {
    pub snapshot_commit: u64,
    pub outcome: PlanPreflightOutcome,
}
pub enum PlanPreflightOutcome {
    Replay(RecordingPlanReceipt),
    Candidate { active_session_id: Option<String> },
}
```

報告型はClone/Debug/Serializeを提供できる。requestの期待版をreportに再保存しない。停止の必要性はactive_session_id.is_some()から導出し、重複boolを持たない。IDは同snapshotで検証したsessionのIDであり、現在のRecordingRun tokenやworkerが依然存在する証明ではない。

新APIはHistoryのH1 query/resultを変更しない。管理DTOはnative in-process専用。HTTP/TS transportは追加しない。invalid/Conflict/RecordingPlanCapacity/Busy/CorruptData/Control/SQL failureは既存StoreErrorで全要求errorとして返す。

## 結果の意味と判定順

要求は既存canonical helperで128KiB/depth/node制限と純粋検証を行う。BEGIN DEFERRED後、最初のlast_commit読取でsnapshotをpinする。全参照を同connection/transactionから読む。

1. 既存requestIdを探す。元要求がcanonical等値なら健全性を検証したReplay。別内容ならConflict。最新applied、現在job、現在CAS、容量によって元receiptを新要求へ変換しない。
2. 新規mappingはexpected mapping revision/current head、現在mapping本文、予約/永久metadata衝突、容量を検査する。
3. 新規applyはexpected applied/current head、現在applied本文、desired同ID/revisionのimmutable内容、定義/app容量を検査する。enabledの場合は現在mapping/保持版、固定member解決、永久metadataと予約のfirst-use証拠を検査する。disabledも既存完全形・None参照規則を維持する。
4. 同snapshotのrecovery証拠を読む。active保持jobがあれば新規候補はBusy。active sessionは破損検査を省略せず、正常ならそのID付きCandidateとして許容する。active sessionが無ければCandidateのIDはNone。
5. 出力予算と取消/期限を確認し、snapshotを閉じて返す。検査途中のcountsや片側だけの候補を返さない。

Candidateは「このsnapshotで、active session以外の検査済み事前条件が合う」を意味する。予約、承認token、future commitの保証ではない。UUID採番時のledger ID衝突、実SQL書込、FULL、close中の時計異常、将来のSDK解決成功は保証しない。初回ledger IDはwriteだけで発行し、preflightでは生成しない。

Replayは元操作の結果であり、現在applied/Runningの証明ではない。supervisorはReplayを理由に現workerを停止したり旧計画へ戻したりしない。必要な新設定は新requestIdと現在の期待版で明示する。

## mapping変更とapplyは別操作

c2aのapply preflightは**保存済みmapping**だけを参照する。未登録mappingの架空revisionや、未commitのmappingを注入してapply成功と見なさない。mapping登録のpreflightとapplyのpreflightを別snapshotで呼んでも一つの原子的previewにはならない。

mapping変更を伴う置換では、停止前にdesired純粋検証とmapping preflightを行えるが、登録後の新mappingに対する保存済みapply全検査は登録commit後となる。c2bはこの制限をreportで明示する。停止前の完全な複合previewが製品上必要になった場合は、仮想resolutionを扱う別契約を追加設計し、現Candidateを拡張解釈しない。

新mapping登録後にapplyが失敗しても旧appliedは変わらないがcurrent mappingは進んでいる。旧appliedでのmanaged再開はH5b2のcurrent mapping gateで停止する。自動的にmappingを巻き戻さず、保存receiptと現在状態を示し、再applyなどの明示的な回復を要求する。

## write検証の共有

recording_plan/write.rsからread-onlyのprepare_register/prepare_apply相当を抽出する。入力はconnection、同operation Budget、canonical request。結果はReplayまたは検証済みprepared candidate。preparedには必要なhead/resolution/definition等を保持できるが、public tokenにはしない。

共通helperはSQL書込、BEGIN/COMMIT、commit採番、UUID発行を行わない。writeはBEGIN IMMEDIATE内で同helperを使い、**新規候補のactive session/job拒否を必ず維持**してから保存する。preflightだけがactive sessionを許容する。mode差はprivate helperの引数または結果判定で表現し、publicなidle-check bypassを作らない。

receipt先行、first-use operation-wide cache、JOINによる本文取得、全canonical/hash/参照検査は維持する。preflightのためにreservation/body検査を複製しない。未参照の全過去receiptを再帰検証しない。

## reader所有・snapshot・取消

SqliteStore::reader()で発行済みHistoryReaderを使う。Historyと管理preflightの合計で既存2leaseまで。supervisor用に作るならwriterをRecordingHostへ移す前に1leaseを確保し、その間History用に残るのは1leaseである。既に2枠使用中ならBusy。第三connectionを直接開いて回避しない。

1readerは1操作ずつ実行し、History queryとpreflightを同時実行しない。idle readerもwriter lockのArcを保持する。writer drop後でもreader/実行中workerが残る間は他ownerをBusyにする。preflight完了後はtransactionを閉じるため、idle leaseがWAL snapshotをpinし続けることはない。

HistoryReader内部にprivateなrun_store_snapshot相当を設け、既存Snapshot guardのhandler解除→ROLLBACK→connection破棄を共有する。管理APIのStoreErrorを保持し、SQLite OperationInterruptedだけをtoken/deadline/work由来のControlへ変換する。一般SQL失敗をCancelledへ上書きしない。cleanup失敗はconnectionを破棄し、Control(ReaderUnusable)を返して再利用を拒否する。writerのneeds_reopen状態をreaderの障害から変更しない。

QueryControlのabsolute deadline/tokenはそのまま用いる。c2aは1API=1Budget、rowsは管理上限256、文書128KiB、合計入力8MiB、caller出力/VM予算を維持。SQLは通常課金する。panicでもguardを実行し、snapshotを残さない。実SQLite I/Oのhard停止は保証しない。

c2aに新async hostは必須ではない。統合試験ではowned readerをspawn_blockingへ移して実録画と並行できる。c2cでは専用の1request/1worker、borrowed join、exact process-local request tokenを持つownerを用意する。取消はrequestであって完了ではなく、旧workerがsettle/joinするまで新要求やlease返却を許さない。無制限queueやlatest-only結果配送は使わない。

## H5c2b/cの全体状態遷移

| 状態/明示操作                   | 次の状態と条件                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| Running → preflight             | writerはworkerに残る。候補の成功/失敗だけでは録画を止めない                         |
| preflight Replay                | 元receiptを返す。Running/appliedは変更しない                                        |
| Candidate → 明示replace要求     | 対象RecordingRunを照合しrequest_stop。期限/取消で未joinならStoppingを保持           |
| Stopping → join                 | SDK shutdownとRecorder cleanupを確認。正常Closed/許可terminalのみPausedClean        |
| cleanup/source/start障害        | RecoveryRequired。管理applyや自動resumeへ進まない                                   |
| PausedClean → mapping turn      | 最大1register。成功receiptを保持。次applyは別の明示turn                             |
| PausedClean → apply turn        | fresh preflight/期待版再照合後、最大1apply。保存成功はAppliedPaused                 |
| apply Err/応答喪失              | 自動再試行せずRecoveryRequired。mapping成功receipt等は失わない                      |
| AppliedPaused → 解決提示        | callerが新しいSDK generationから固定planを構築。適用specと全descriptorを照合        |
| 解決提示 → 明示resume           | 保持job/rearm/clean pause gateを満たし、新activation/session/epochでH5c1開始        |
| Starting → activation成功後失敗 | receiptとcleanupを保持。旧appliedへ自動rollbackしない                               |
| restart                         | 台帳/activation/保持復旧状態を照会。保存pinやactive receiptをworker再装着へ使わない |

supervisorはstop前のrun token、候補request、期待applied/mapping/保持版を束縛する。tickでsnapshot_commitが増えること自体をCAS不一致にしない。書込直前には実revision/immutable要求を再検査する。古いpreflight応答を別Project/別run/別候補へ適用しない。

台帳commit、SDK shutdown、source解決、worker稼働を一つのtransactionとは扱わない。mapping/apply/activationのreceiptはそれぞれ別で、途中成功分を消さない。stop/joinの外側timeoutも物理writer枠を解放しない。正常pauseとretention job_pending/rearm latchはH3dを維持し、計画変更で勝手にclearしない。

H5c2bのpaused管理turnはHostがstoreを一時的にblocking workerへ移す専用APIとし、任意callbackやtake_store→新Host再作成によるgate消去を通常経路にしない。結果には成功receipt、失敗分類、元run/要求tokenを保持する。停止前/管理turn中のcancelとcommit後latecancelを区別し、commit成功後のreceiptを取消で覆さない。

## H5c2a受入

- RecordingHost相当のwriterがtickを追加中、別readonly readerからmapping/apply Candidateを取得。snapshotを跨いだ混合結果を返さず、writerのsession/counterを変更しない。
- 全write authorizer拒否で両API成功。BEGIN/ROLLBACK以外の管理変更やcommit採番、予約挿入、UUID永続化がない。
- 既存同ID同内容Replayはhead進行/active job/容量到達後も元receipt。同ID別内容Conflict。Replayを新候補扱いしない。
- active sessionはCandidateにIDを返すが、同条件で既存writeを呼ぶとBusy。active保持jobの新規候補はBusy。idleならID None。
- desired immutable差、期待版差、別Hub/incarnation/series衝突、disabled完全形、未知mapping、破損metadata/first-use/保持receiptで全error。
- 32 origins・別保持revision・8member切替を既定256rowsで評価。予算超過は部分候補なし。
- 最初のsnapshot読取後に別writer commitを進めても旧snapshotで一貫する。次操作は新状態を返す。
- 低VM/bytes/期限切れ/取消、SQL失敗と取消併発、cleanup拒否、panicを検証。正常取消後はreader再利用可、cleanup失敗後はReaderUnusable。
- Historyとpreflightで合計2lease、3個目Busy、writer drop後もreader終了までlock維持。既存raw/minmaxを回帰する。

c2a完了で保証するのは、録画を止めずに保存済みDB条件に基づく候補検査を行えること。停止から適用/再開までの製品操作、fresh接続設定の証明、自動復旧はc2b/c以降であり、今回のAPIだけで実装済みと記録しない。

## H5c2aの実装と受入（2026-11-03）

HistoryReaderの2つのpreflight API、共有prepare、管理snapshot runnerを実装した。writeはBEGIN IMMEDIATE内でactive session/jobを拒否し、preflightは同じ判定からactive sessionだけを許容する。readerのhealthy状態を保持し、panic時のcleanup失敗も次のHistory/管理操作へ引き継ぐ。

新規native14件を含むRust workspace451件、Clippy／rustfmt、既存H1／desired契約のChromium8件と全体Prettier・文書リンクが成功した。記録中の同snapshot、replay／競合／容量、32 origins／別保持版／8memberの256行予算、取消／SQL失敗／panic／cleanup拒否、2leaseとwriter lockを確認し、Astraの最終レビューに必須修正はない。全体CIはwork向けReady for Review PRで確認する。

H5c1とはworkベースの独立差分であり、同PRの実装や検証件数を本工程に混ぜない。c2b/cのHost管理turn・停止／再開supervisorとfresh SDK解決の調整は未実装である。
