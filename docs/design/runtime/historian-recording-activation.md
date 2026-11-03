# Historian H5b2: activationとtimed sessionの原子的結合

2026-11-03（日本時間）。**Astra主設計の採用詳細。H5b1の後続であり、DB7/APIは実装・ローカル受入済み。** [記録計画](historian-recording-plan.md)と[台帳](historian-recording-plan-ledger.md)を前提に、単一groupのnative保存コアだけを拡張する。supervisor、SDK接続、worker開始、Project/UI、認証・製品transportは追加しない。試験は隔離SQLiteのみで、実Hub/S7/実環境へ接続しない。

## 決定点

新しいactivationは、現在適用済み計画から固定SessionSpecを生成し、永久metadata、session、timed evidence、activation receiptを**同一SQLite transaction/commit**で作る。成功は「記録用sessionの開始を永続化した」であり、SDKのLive、初回sample、RecordingHostのRunningを保証しない。

H5b1のappliedを更新する操作ではない。同じappliedに対し、旧sessionの正常終了後に別activation/session/clockで再開できる。disabled計画は開始不可。mappingまたは保持policyがappliedに束縛された版から進んだ場合、先に明示再applyが必要である。

## 公開型とAPI

store::recording_plan配下へ次を追加する。IDはH1 ID、期待版は1..MAX_SAFEのu64、startは既存ClockStampのsafe UTC ms/clockEpochを使う。未知fieldを拒否する保存型とする。

```rust
struct ActivateRecordingPlanRequest {
    activation_id: String,
    expected_applied_revision: u64,
    expected_mapping_revision: u64,
    expected_retention_applied_revision: u64,
    session_id: String,
    start: ClockStamp,
}
struct RecordingActivationReceipt {
    activation_id: String,
    sequence: u64,
    applied_revision: u64,
    mapping_revision: u64,
    retention_applied_revision: u64,
    commit_version: u64,
    plan: PlanRef,
    resolved_config_hash: String,
    spec: SessionSpec,
    start: ClockStamp,
}
struct RecordingActivation {
    receipt: RecordingActivationReceipt,
    session: SessionStatus,
}
struct RecordingActivationState {
    snapshot_commit: u64,
    latest: Option<RecordingActivation>,
}
```

- `activate_recording_plan(&request, &QueryControl) -> StoreResult<RecordingActivationReceipt>`
- `recording_activation(activation_id, &QueryControl) -> StoreResult<Option<RecordingActivation>>`
- `recording_activation_state(&QueryControl) -> StoreResult<RecordingActivationState>`

すべてidle側SqliteStoreの同期管理API。receiptはimmutable、session statusは同read snapshot時点の可変状態であり分離する。state.latestは最新commitのactivationを返し、activeとは限らない。再起動後interruptedの最新sessionを発見できる。未知IDはNone、破損行をNoneへ変換しない。

`RecordingPlanState.activation_supported=true`はnative atomic binding対応を意味する。SDK/製品接続/自動起動の対応フラグではない。receipt自身に`running=true`を置かない。

callerはdescriptor/PlanRefを入力しない。spec.membersは期待appliedの保存resolutionから取得し、seriesId順に固定する。spec.sessionIdだけを要求から使い、PlanRefはledgerPlanId/appliedRevisionをstoreで構成する。start.atMsはcallerが観測した開始UTCで、現在時刻に書換えたり予約時刻へ丸めたりしない。このlibraryだけで時計信頼を証明したとはしない。

## 新規開始と再送の順序

1. 型/ID/整数/JSON予算を検査し、H5b1と同じcanonical requestを作る。
2. BEGIN IMMEDIATE、同snapshotのstore/台帳/activation headを検査する。activationId既存なら元canonical requestと完全一致を確認し、健全性を検証した元receiptを返す。同ID別内容はConflict。
3. 新規だけ、現在applied headが要求版と一致しenabledであること、保存resolutionがあることを確認する。
4. current mappingとcurrent保持policyの版が要求と一致し、applied receiptのmapping/retention参照版とも一致することを検査する。登録版の存在だけでは不十分。H5b1の型付き本文/hash/予約検証を再利用する。
5. active session/active保持jobが無いことを確認する。sessionIdが過去sessionまたは別activationで使用済みならConflict。新clockEpochも既存session_evidence/activationで使用済みならConflict。
6. 開始UTCがretention fenceのcutoff以上であることを確認する。cutoff未設定ならこの制限はない。cutoff直前はConflict相当で停止し、時刻をclampしない。これは保持済み領域への新記録を避ける条件であり、時計の正しさの証明ではない。
7. activation容量と全metadataを確認してcommitを一度採番し、以下の保存処理を行う。出力/取消予算をcommit前に検査し、成功後はreceiptを返す。

旧activationの再送は最新applied、保持job、retention fence、sessionのactive/closed/interrupted状態にかかわらず**元receiptの照会**である。現在版を再applyしたり新sessionを作ったりしない。元sessionが閉じた後に再送してもactiveへ戻らない。別activationIdで同sessionIdを送った場合は、内容が同じでも新要求としてConflictにする。

新activationは新clockEpochを要求する。managed activationだけでなく既存manual timed sessionにも同epochがあれば拒否する。epoch文字列は時計の同一性の証明ではないが、管理再開のdomainを明示的に分離する。UTC開始が過去session終了より前でも、fence以上かつ新epochであることだけをcoreで検査する。壁時計逆行を前時刻へ補正せず、H5cのtrust/clock検証は別に必要である。

## 保存内容と共有helper

同じcommitVersionで以下を保存する。

- series/segments: applied予約と完全一致する永久descriptor。既存行を更新せず、未存在だけ挿入する。
- sessions: 新session、state=active、lastSequence=0、beginCommit=activation commit、endCommit=null。
- session_members: 全固定member。途中memberだけ成功は不可。
- recording_plans: ledgerPlanId/appliedRevisionの固定members。既存なら型付き等値とfirst-created根拠を照合する。
- session_evidence: PlanRef、clockEpoch、start.atMs、frontier=start.atMs、end=null。
- recording_activations: canonical request、保存receipt、applied/各参照版/session/epoch/commitの索引列。
- activation singleton/head: 新activationの順序と件数。

tickは作らない。開始だけではsequenceや記録件数を増やさない。予約が初めてquery用series/segmentsへ現れる時点には、同transactionでsessionも存在するため「known seriesだがsessionなし」を作らない。

既存begin_timed_sessionを呼んでからactivation行を追加する方法は禁止する。既存beginが独自transactionをcommitするため原子性が失われる。既存`evidence::save_start`をconnection/任意Budgetを受ける内部helperへ一般化し、両入口で共有する。activation側は適用済み予約と恒久metadataの照合後、同じtransaction内で未存在のmetadataと全member/sessionを挿入する。既存manual入口の再送判定/managed gateと検証順は維持し、activation専用の条件照合はその外側で行う。

内部helperはconnection/transaction、検証済spec/start、採番済commitと必要なBudgetを受け、独自BEGIN/COMMITやnext_commitを呼ばない。既存save_start(&Transaction)の一般化は可能だが、全SQL/row/JSONの課金をactivation側から追えることを条件とする。原子性を保てる小さい内部分離を優先し、manual経路の挙動は回帰で固定する。

H5b1のledgerPlanId衝突検査は初回ledger発行時だけに適用する。既存managed ledgerのrecording_plans行は正常なactivation証拠なので、二度目以降のapplyを衝突として拒否しない。`activate→close→再apply→新activation`を必須受入にする。

## DB7と索引

application_idは維持し、user_version/store_meta.format_versionを7へ更新する。DB6と未知版は明示拒否、自動migrationは行わない。既存H1/Project/SDK/Bantoには変更しない。

新tableの採用論理形:

| table                      | 内容                                                                                                                                                                                                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| recording_activations      | sequence INTEGER PK 1..4096、activation_id UNIQUE、session_id UNIQUE FK sessions、applied_revision FK applications、mapping_revision FK mappings、retention_revision FK retention applications、clock_epoch UNIQUE、commit_version UNIQUE、request_json、request_hash、receipt_json |
| recording_activation_state | singleton=1 PK、last_sequence nullable FK、activation_count。初期NULL/0                                                                                                                                                                                                             |

activationの(applied_revision,commit_version)と、session_evidenceの(clock_epoch)/(plan_id,plan_revision,session_id)に検索indexを追加し、既存manual sessionとのepoch重複検査で全sessionを走査しない。sessions.begin_commitとactivation.commitの一致、plan/evidenceとの対応は型付き読取でも確認する。管理commitはtick専用commits表を参照せず、store_meta.last_commitに対して検証する。

head/count/MAX/COUNTとmanaged session/evidence/activationの索引付き関係検査をH5b1のbounded headsへ統合し、必須singleton欠落を「未開始」にしない。件数/連続番号は最大4096。新規開始だけを容量errorとし、既存receipt照会・close/interrupt・queryは引き続き可能。

## 旧入口とmanaged gate

managed storeのpublic begin_session/begin_timed_sessionは引き続き新sessionを拒否する。ledgerPlanIdと正しいapplied版をcallerが手入力しても開始できない。activation専用の内部入口だけが、条件照合とbinding保存を同transactionに入れた上でgateを通る。非managed storeでactivationを呼んだ場合はNotApplied相当の明示errorを返す。

既存sessionのspec/start完全一致再送は旧入口でも従来どおり照会として返す。これはそのsessionを使う新workerを開始してよいという認可ではない。新activationに別のworkerが対応することの管理はH5cのownerが担う。

新tick/明示gap/close/interruptは既存の同session/domain/sequence/fence制約を使う。H5b2で独自の記録周期や値の補間を導入しない。managed sessionが作られても、SDKからのsampleを勝手に生成しない。

## 照会と破損検証

receipt/stateは一つのread snapshotで、最初にlast_commitをpinする。参照するactivationについて次を有限に検査する。

- activationのrequest/receipt型、canonical本文、列値、期待版、plan/hash、commitの一致。commit>applied/mapping/retentionの各commitかつ<=snapshot。
- 保存appliedのenabled/resolutionとspecの全memberが完全一致。現在headとの一致は新規開始だけで要求し、過去照会では旧適用行を使う。
- sessionsの存在、spec等値、beginCommit=activation commit、lastSequenceのsafe範囲、state/endCommitの整合。session_membersの個数と全(series,segment)対応。
- permanent series/segmentが予約/descriptorに一致し、session_evidenceのplan/clock/start/frontier/endがsessionと整合すること。
- recording_plansのmembersが固定specと一致し、そのcreatedCommitが最初の対応session beginCommitに一致すること。複数sessionで同じappliedを使ってもfirst-createdを更新しない。
- activeはendCommit=null、closed/interruptedはendCommit>beginCommitかつ<=snapshot。interruptedにUTC endを捏造しない。closedは既存timed closeの境界規則を満たす。

過去全sampleの再decodeや全receipt本文の再帰検証はしない。直近sequence/commitの整合は既存のsession/recovery検証を再利用し、未記録sessionはlastSequence=0として正常である。active managed sessionの証拠が欠けている場合はCorruptDataとし、手動sessionへ降格して解釈しない。

要求された過去activationを読む際、現在appliedが別版でも元receiptを返す。可変statusだけを同snapshotから添える。latest照会も同じ検証helperを使う。過去のheadやsessionを参照する偽receiptを「再送成功」としない。

## restart・取消・FULL

再openは既存store規則どおりactive sessionをinterruptedへ確定する。activation receipt/spec/start/commitは不変であり、recording_activation_stateでlatestを発見できる。interruptedへの確定は記録の再開ではない。新activationには新ID/session/epochを要求し、fresh SDK pin/時計の検証はH5cで行う。

| 中断点                           | 結果                                                               |
| -------------------------------- | ------------------------------------------------------------------ |
| session/metadata挿入前または途中 | rollbackで予約だけの状態へ戻る。activation/sessionの片側を残さない |
| evidence/activation/head更新途中 | 全rollback。永久metadataの新規挿入も戻す                           |
| COMMIT後応答喪失                 | 同activationId再送で元receipt。新sessionを作らない                 |
| COMMIT後process crash            | 再openでsessionはinterrupted、receiptは不変                        |
| close後/再apply後の旧再送        | 元receipt＋照会時のterminal session。再実行なし                    |

run_maintenanceと既存Operation guardを利用し、progress handler解除→rollback、cleanup拒否/SQL failureのneeds_reopenを維持する。FULLを取消へ上書きしない。commit前取消はrollback、commit成功後late cancelはreceiptを取り消さない。

要求/receipt各128KiB、depth32/node8192、管理read/writeのdecoded rows最大256、入力合計8MiB、caller出力予算、VM/deadlineはH5b1と同じ。BEGIN/採番/INSERT/COMMITすべて課金する。8member・既存metadata・複数sessionで既定予算が足りることを試験し、不要な同一applied/first-useの再検証はoperation内cacheで共有する。上限超過は部分成功ではなく全error。実SQLite I/Oのhard停止は保証しない。

## H5cへの接続境界

このAPIでsessionを先に作り、その後に既存Recorder::startを同specで呼ぶだけでは、開始clock/schedule anchorとreceipt再送の意味を取り違える恐れがある。H5cではrecorderが実clockを読んだ開始点で、既存manual beginの代わりに専用activationを呼ぶ開始戦略を導入する。applied/spec/epoch/activationIdとworker ownerを一つに束縛し、保存済みactivationの再送を新worker開始として扱わない。

SDK task起動やshutdownとの分散transactionは今回も約束しない。開始commit後にsource失敗した場合は実sessionを既存cleanup規則で終了し、appliedを旧版へ戻さない。History UI寿命はrecording ownerと無関係である。

## 必須受入

- 初回activation、同appliedのclose後再開、再apply後再開、8member、number/bool、保存spec/plan/clock原子一致。
- disabled/未適用、current/applied mapping不一致、保持版不一致、active session/job、過去session/epoch再利用、fence直前/同値、unsafe timestampを拒否。
- 未記録予約はunknownSeries、activation後はsession付きの既知系列となり、raw/minmaxが空点＋unknownCoverageを返す。tick記録後は既存raw/minmax/coverage契約を維持。
- 同ID同内容再送はactive/closed/interrupted/新headの全状態で元receipt。同ID別内容・別ID同sessionはConflict。
- manual新beginはmanaged gateで拒否、旧begin/tick照会は維持。managed新sessionは専用入口だけで作れる。
- request/receipt列、head/count、session spec/member、永久descriptor、timed evidence、recording_plans first-created破損を検知。照会を理由に全履歴を再走査しない。
- private fault hook/process終了でmetadata/session/evidence/activation/head/COMMIT各境界、actual FULL、取消とFULL併発、低予算、rollback拒否、panic、成功後応答喪失を確認。
- restartでlatest発見とinterrupted、新activationの新domain、旧receipt不変。DB6/未知format拒否、旧manual/保持/queryの回帰。

H5b2完了は保存コアでの原子的な開始証拠までである。常時supervisor・実SDK運転・起動時自動再開・製品設定配布が完成したとはしない。

## 実装検証結果（2026-11-03）

native20件（process worker含む）を追加し、Rust workspace437件・Clippy／rustfmtが成功した。H5b1の追加レビュー修正（32 originsの取得最適化）も取り込んで再検証した。既存H1／desired契約のChromium8件、全体Prettierと文書リンクを確認する。

Astra実装レビューの永久metadata欠落指摘を修正した。session memberの有限JOINで存在を必須にし、headの関係検査でも既存activationのmetadata欠落を拒否する。照会・再送・新activationでCorruptDataを返し、再生成による隠蔽を防ぐ。最終read-onlyレビューに追加の必須修正はない。

全体CIはReady for Reviewの後続PRで確認する。H5b1のPR #44が未マージの場合は同branchをbaseとし、activation/session bindingの差分だけをレビューできる形へ分ける。H5cのsupervisor/SDK運転を提供したとはしない。
