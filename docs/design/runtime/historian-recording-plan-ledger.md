# Historian H5b1: 記録計画台帳・mapping登録・原子的apply

2026-11-03（日本時間）。**Astra主設計の採用詳細。H5aはPR #43でマージ済み、H5b1 API/DB6は実装・ローカル受入の対象。** [H5全体](historian-recording-plan.md)を具体化する。今回の実装対象は隔離SQLite上の保存コアであり、activation/session binding、supervisor、Project編集UI、実Hub/SDK接続は追加しない。

## 最初の実装単位と依存

H5b1では明示mappingの登録・CAS・再送、desired計画の原子的apply、descriptor予約、管理状態照会、managed storeの低レベル新session禁止を閉じる。mappingもappliedも無いstoreでは既存手動session APIを維持する。最初のappliedができたstoreはdisabled計画であってもmanagedであり、H5b1では新sessionを開始できない。H5b2/H5cの原子activation bindingを導入するまで「記録開始可能」と表示しない。

`scada-historian`から`scada-model`へのpath依存を採用し、H5a validatorを再利用する。modelはHistorian Schemaをincludeしているがhistorian crateには依存しておらず、crate循環はない。SDK/runtime依存をmodel/historianへ逆流させない。

SHA-256は`sha2 = "=0.10.9"`を新規固定依存として追加し、Cargo.lockとRust 1.98.1で検証する。digest自作やhashだけの同一性判定はしない。Project0.36/H1/固定SDK/Bantoは維持する。

## 型と管理API

store内の新moduleを`recording_plan`とする。以下はRustの採用shapeで、JSON transportではない。公開structのserialized fieldはcamelCase、Deserializeする保存structは未知fieldを拒否する。

```rust
struct RecordingMappingMember {
    member_id: String,
    identity: IdentityDescriptor,
}
struct RecordingMapping {
    hub_ref: String,
    hub_instance_id: String,
    members: Vec<RecordingMappingMember>,
}
struct RegisterMappingRequest {
    request_id: String,
    expected_mapping_revision: Option<u64>,
    mapping: RecordingMapping,
}
struct MappingReceipt {
    request_id: String,
    mapping_revision: u64,
    commit_version: u64,
    mapping_hash: String,
}
struct ApplyRecordingPlanRequest {
    request_id: String,
    expected_applied_revision: Option<u64>,
    desired: serde_json::Value,
    expected_mapping_revision: Option<u64>,
    expected_retention_applied_revision: Option<u64>,
}
struct RecordingPlanReceipt {
    request_id: String,
    applied_revision: u64,
    commit_version: u64,
    plan: PlanRef,
    desired_plan_id: String,
    desired_revision: u64,
    desired_hash: String,
    resolved_config_hash: String,
    mapping_revision: Option<u64>,
    retention_applied_revision: Option<u64>,
    enabled: bool,
}
```

SqliteStoreへ次を追加する。すべて同期・有限処理で、`&mut self`と元の`&QueryControl`を受ける。

- `register_recording_mapping(&RegisterMappingRequest, control) -> StoreResult<MappingReceipt>`
- `apply_recording_plan(&ApplyRecordingPlanRequest, control) -> StoreResult<RecordingPlanReceipt>`
- `recording_plan_state(control) -> StoreResult<RecordingPlanState>`
- `recording_mapping_receipt(request_id, control) -> StoreResult<Option<MappingReceipt>>`
- `recording_plan_receipt(request_id, control) -> StoreResult<Option<RecordingPlanReceipt>>`

RecordingPlanStateはsnapshotCommit、ledgerPlanId、現在mapping（revision/commit/request/hashとowned mapping）、現在applied（receipt/desired/resolved mapping snapshot）、`activationSupported=false`を返す。現在mappingと現在appliedが参照する過去mappingが異なる場合も区別する。上限付き結果であり、全履歴一覧は返さない。既存StoreRecoveryStateの保持revisionを記録revisionへ読み替えず、必要なtransaction内部readを共有する。

H5b1の管理readはidle側のstoreから実行する。Running中の停止前preflightに使う別管理reader/最大2 lease共用はH5cの追加であり、現在workerが所有するconnectionへ同時アクセスしない。この実装で「稼働中に事前確認済み」と主張しない。

## 入力検証とcanonical比較

requestId/hubRef/memberIdはH1 ID。期待revisionのSomeは1..MAX_SAFE、初期headはNoneだけで表す。mapping/applyのrequestId poolは別tableで独立とする。同一pool内の同IDは永久に同じ要求を指す。

mappingは1..8 memberで、memberId/seriesId/externalNameはそれぞれ一意。全descriptorがheaderのhubInstanceIdと一致し、同じperiodMs 100..3,600,000msを持つ。IdentityDescriptorのID/type/source/unit/nameのH1制約、hub+incarnation一意性を既存SessionSpec::validate相当で再利用する。検証用SessionSpecを組む場合は固定の内部検証IDを使うだけで、sessionを保存しない。

applyのdesiredはH5a validatorをそのまま通す。enabled=trueはmapping/retention期待版が両Some必須、disabledは両None必須。enabledではcurrent mappingのhubRefがdesired.group.hubRefと一致し、memberId集合が完全一致、各externalName/valueType/periodが対応descriptorと一致することを要求する。部分適用や不足memberの除外はない。groupIdはdesired側の論理group識別であり、SDK/永久series identityではない。

全body/requestはowned入力として検証し、実行中にcaller参照を保持しない。canonical化は以下に固定する。

1. H5a/H1の型・Unicode・整数範囲を検証する。
2. object keyは辞書順、desired.group.membersとmapping.membersはmemberId順にする。
3. safe整数の1.0/1e0を整数表記へ正規化する。name/unit等の文字列はtrim/Unicode正規化しない。
4. compact UTF-8 JSONを生成し、SHA-256 lowercase64hexを計算する。

順序だけ変えたmembersは同一要求とする。元desiredの列挙順はH5a parserでは保持されるが、台帳の比較/返却はcanonical順でよい。descriptor側に不透明u64 SDK counterは存在しないため、counterをf64へ落とす正規化を導入しない。将来追加時は専用表現を設計する。

mappingHashはcanonical mapping、desiredHashはcanonical desired、resolvedConfigHashはcanonical `{desired, mapping}`（disabledはmapping=null）のdigestとする。requestId/expected revision/retention期待版はcanonical requestの比較には含めるがconfig hashへは混入させない。hashは診断用で、同ID再送・immutable版・descriptor一致は本文も比較する。

## format6の最小DDL契約

application_idは維持し、user_version/store_meta.format_versionを6へ揃える。format5を含む非対応版を明示拒否し、自動migrationしない。新store作成時の同一transactionでledger singletonを作成する。後からsingletonが無ければCorruptDataであり「まだmanagedでない」とみなさない。

管理commitは既存`next_commit`によるstore_meta.last_commit採番を使う。**既存commits表は(session,sequence,payload)のtick専用であり、管理行からcommitsへのFKを張らない。** 管理commit>0、snapshot.last_commit以下、直前管理版より大きいことを照合する。

| table                          | 必須キー/列と制約                                                                                                                                                                                                                                           |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| recording_mapping_state        | singleton=1 PK、mapping_revision nullable FK、revision_count。初期head=null/count0                                                                                                                                                                          |
| recording_mapping_revisions    | mapping_revision PK (1..4096)、request_id UNIQUE、expected_revision nullable FK、commit_version UNIQUE、canonical request、mapping_hash、receipt_json                                                                                                       |
| recording_plan_state           | singleton=1 PK、ledger_plan_id、applied_revision nullable FK、application_count、definition_count。初期head=null/count0                                                                                                                                     |
| recording_desired_definitions  | (plan_id,revision) PK、desired_json、desired_hash、created_commit                                                                                                                                                                                           |
| recording_plan_applications    | applied_revision PK (1..4096)、request_id UNIQUE、expected_revision nullable FK、commit_version UNIQUE、plan_id/desired_revision FK、mapping_revision nullable FK、retention_revision nullable FK、request_json、resolved_json、resolved_hash、receipt_json |
| recording_series_reservations  | series_id PK、hub_id/incarnation_id UNIQUE、first_revision FK                                                                                                                                                                                               |
| recording_segment_reservations | (series_id,segment_id) PK、series_id FK、descriptor_json、descriptor_hash、first_revision FK                                                                                                                                                                |
| recording_application_members  | (applied_revision,series_id,segment_id) PK、applicationと予約segmentへのFK、first-use用のseries/segment/revision索引                                                                                                                                        |

全tableはSTRICT。revision/commitは正整数、期待revisionはNULLまたは正整数。hashは64文字hexをSQL/型の両方で検査する。expected_revisionは初回NULL、以降revision-1であり、headは最大revisionと一致する。nullable複合参照やheadの参照循環はSQLiteのdeferred FKまたはtransaction内の挿入順で整合させる。receiptのJSONが列値の代わりの権威にならない。

ledgerPlanIdはstore生成の新H1 IDで一度保存し、不変。H5b1にはactivation table/実行APIは作らない。将来PlanRefはledgerPlanId/recording appliedRevisionとなる。初回apply前に既存recording evidenceでそのplanIdが使われていないことを検査する。衝突は再生成で隠さずCorruptData/Conflictとして扱い、既存手動PlanRefと混ぜない。

必要な索引はrequestId UNIQUE、revision PK、desired FK列、予約hub/incarnation UNIQUE、(seriesId,segmentId) PK、first_applied_revision。過去receipt検証のためcreated_commitに対応する最初のapplicationを索引で取得できるようにする。全receiptを再帰decodeしない。

## mapping登録のtransaction

1. 入力をcanonical化し、予算内か確認する。
2. run_maintenance/BEGIN IMMEDIATE。requestId既存なら保存requestとcanonical完全一致を検査し、検証済み元receiptを返す。現head/稼働/容量による新規適用判定をしない。
3. singleton/head/直前版の整合とCASを確認する。新登録はactive sessionまたはactive retention jobがあればBusyとする。registrationはworker運転設定を変える操作ではないが、H5b1では明確なidle管理窓へ限定する。
4. 各descriptorを既存series/segmentsと予約表に照合する。不変identity/同segment別本文はConflict。DB列/本文の自己矛盾はCorruptData。登録だけで予約表やquery表へ書かない。
5. mapping件数上限を確認し、revision=head+1、commitを採番。mapping/request/receiptを挿入しhead更新。COMMIT成功後だけreceiptを返す。

同bodyでも新requestIdはCASを満たす新mapping版。current mappingが進んでも既存appliedの固定resolutionを更新しない。後のapplyは最新mapping版とのCASを要求する。

## 計画applyのtransaction

1. 構造・条件・予算を検査しcanonical requestを確保する。
2. BEGIN IMMEDIATE、既存requestIdを最初に読む。同内容なら元receipt、別内容ならConflict。新要求として再実行しない。
3. 台帳head/CAS、active session/jobなし、容量を確認する。enabledなら現在mapping版と現在保持policy applied版に一致することを確認する。保持台帳は既存の型付きread検証を再利用し、単に整数columnがあるだけで有効policyとしない。
4. desired(planId,revision)が既存ならcanonical本文一致、未登録なら新定義として候補化する。immutable版の別本文はConflict。matching mappingから全memberを解決する。disabledはresolution=nullで保持/接続確認を要求しない。
5. 現行series/segmentsと予約series/segmentsの双方を再照合。旧mapping登録後に手動sessionが作ったmetadataとの競合もここで拒否する。
6. commit/appliedRevisionを採番し、desired新規行、application/receipt、descriptor予約、singleton headを一括保存する。first_applied_revisionは最初の予約を維持する。全member処理後にCOMMITする。

reservationは履歴検索のseries/segmentsへ挿入しない。未記録の予約seriesは現行History APIでunknownSeriesのままであり、「既知seriesなのにsessionなし」のCorruptDataを起こさない。予約にexisting seriesが対応していれば、その履歴は従来どおり検索可能である。

予約済みseriesIdに別hub/incarnation、同hub/incarnationに別seriesId、同(seriesId,segmentId)に別metadataを永久に割り当てない。新segmentの登録は許すが、旧descriptorを更新しない。予約を削除するGCや適用取消はH5b1に作らない。

## read/replayの健全性検査

state/receipt読取は同じBEGIN DEFERRED snapshotで最初にstore_meta.last_commitを読む。SELECT、scalar、decode、JSON bytesをすべて課金し、handler解除→ROLLBACKを既存Operation guardで実施する。stateは設定情報だけでRunning/停止成功を推測しない。

読取で参照する行について次を検証する。

- singletonが一件、ledger IDが合法、headと独立に取得したMAX(revision)が一致。NULLなのに履歴行がある/宣言head巻戻し/欠落headをCorruptDataとする。
- revision/count上限、first expected=NULL／以降expected=revision-1、その直前版の存在とcommit順序。過去全版のreceipt本文へ再帰しない。
- 保存requestの再検証/canonical一致、requestId/版/commitの列一致、receiptの全fieldと再計算hash一致。
- desired本文がH5aに適合し、key/hash/最初の利用commitと一致。過去desiredに再適用した場合も新commitをfirstとしない。
- applicationのmappingがその期待版と一致し、enabled時のmember/type/name/period/hub対応が完全。disabledはmapping/retentionがNULL、resolved mappingもnull。
- 参照する保持policy applicationは過去版として構造/commitを検証し、現在headとの一致は**新規apply時だけ**要求する。過去previewのrawを再走査しない。
- applicationが予約したseries/segmentが存在し、descriptor/本文/hashが一致。`recording_application_members`の索引から最初の利用revisionを検査し、そのapplicationのrequest・desired定義・参照mapping・保持版・commit順序とenabledな解決内容を非再帰で確認する。同じfirst revisionは同一apply transactionの書込み前でcacheを共有し、過去receipt本文や過去予約へ再帰しない。後の同予約再利用を許す。

古いrequest receiptの読取では最新の設定が別でも元結果を返す。最新headを返したり、旧planを再適用したりしない。未知requestIdはNone。不正requestIdはInvalid。破損したreceiptをNoneへ変換しない。

これは参照行の有限な整合検査であり、全DB forensic監査ではない。任意の複数行を整合する別データへ改変された場合の暗号学的検出を約束しない。hashは署名ではない。

## managed session gate

既存begin_session/begin_timed_session共通入口は、保存済みsessionのspec/start完全一致再送を先に処理する。その後、**新しいsession**について台帳singleton/head整合を読み、applied_revisionがSomeならManagedRecordingRequired相当の明示errorで拒否する。PlanRefがledgerPlanIdに一致する場合も、手入力なら拒否する。H5b1には原子activation/session bindingがないためである。

Noneなら従来の手動session開始を許す。mappingだけの登録でmanagedにはしない。head欠落/巻戻しをNoneに落とさずCorruptDataにする。disabled apply後もmanagedであり、既存public APIで非managed運転を再開できない。台帳を消すAPIを追加しない。

既存session/tick receipt再送、履歴query、保持の読み取り/明示管理は新session開始とは別であり維持する。managedへ移行するapplyはactive sessionなしを要求するので、旧sessionへの新tickは従来のclosed/interrupted gateで拒否される。既存正常receiptを新しいmanaged制約で無効にしない。

## 予算・error・障害復旧

- desiredはH5aの64KiB/depth32/node4096。mapping/request/receiptは各128KiB、深さ32、node8192、有限scalar JSON。保存JSONの長さをdecode前にも確認する。
- 一管理operationのdecoded rowsは最大256（caller指定がより小さければその値）、入力JSON合計hard8MiB、出力はcaller max_output_bytesを守る。出力budgetと入力計数を混同しない。
- QueryControlのabsolute deadline、VM5M以下、進捗callback/statement先払い、取消とcleanupを引き継ぐ。BEGIN/COMMIT/next_commit内部SQLも課金する。元deadlineを作り直さない。
- mapping版、desired版、applicationは各4096件まで。mapping/applicationは連続revisionから件数を検査し、definition_countは独立COUNT（上限4097で検知可能）との整合を読む。予約は一application最大8で総32,768件以内。全予約行を毎回decodeせずキー参照する。
- 上限到達でも過去receipt/state/session receipt照会と停止は可能。新規登録/applyだけCapacityLimit相当で拒否する。上限を越えて旧receiptをGCしない。

Invalidは入力不正、ConflictはCAS/immutable/request再利用/identity競合、Busyはactive session/job、ManagedRecordingRequiredはbinding未対応開始、CorruptDataは保存行の自己矛盾として区別する。公開error variant追加または既存StoreErrorへの安全な有限分類追加は実装時に揃える。SQL/FULLは原エラーを維持し、既存needs_reopen規則を適用する。取消が同時に立ってもFULLをControlへ隠さない。

COMMIT前の取消/SQL failureは全rollback。COMMIT成功後応答喪失は再送で元receiptを得る。成功後の取消を未適用へ変換しない。rollback拒否/panic時にはOperationがconnection再利用不可を維持する。read-only管理readもcleanup失敗を黙って成功にしない。

H5b1は同期store APIで、async worker/joinを新設しない。呼出側のtimeoutやプロセス終了によるdurabilityは既存SQLite/WAL契約の範囲であり、物理媒体の停電保証やexactly-once SDK配送を約束しない。

## 必須受入と後続

1. 初期state、mapping登録/CAS、同ID同本文（member順序/整数表記違いを含む）再送、同ID別内容、current mapping変更後の古いreceiptを確認する。
2. enabled applyで全member/Hub/型/周期/名前対応、保持版CAS、disabledのNone条件、same desired revision別本文、別desiredへの切替、古いrequest再送がheadを動かさないことを確認する。
3. 予約の3種類のidentity衝突、新segment追加、複数applyによる予約再利用、未記録予約のHistory unknownSeries、既存raw/minmax/coverage不変を確認する。
4. 非managed手動sessionは維持、mappingのみは開始可、apply後はtimed/untimed/偽PlanRefの新開始不可、旧begin/tick再送可。active session/job中の新規writeはBusy、既知receiptは再送可。
5. 必須singleton欠落/head巻戻し/MAX不一致、列/JSON/hash/desired/mapping/予約/保持参照破損を有限に検知する。全過去receiptの再帰decodeを要求しない試験も置く。
6. private hookで各insert/予約/head/COMMIT境界のrollback・process終了・応答喪失を試験する。実SQLite FULL、取消とFULL併発、低VM/rows/bytes/deadline、panic/cleanup失敗時のneeds_reopenを既存fixtureで検証する。
7. restartでstate/receiptを復元し、format5/未知formatを拒否する。SDK・UI・通常Appの稼働は変えない。

H5b2ではactivation/sessionの同transaction bindingを追加し、managed gateを専用入口だけで通せるようにする。H5cでは停止前read-only preflight、RecordingHostの所有/join、fresh SDK pin、新session/clockでの明示activationを接続する。H5b1のreceiptを「記録中」の証明として使わない。

## 実装検証結果（2026-11-03）

新規native 21件（process workerを含む）で、CAS・再送・immutable・8memberの既存metadata再適用、予約の非公開・系列衝突・新segment、active session/job、4096版上限、head/hash/first-use破損、cancel・panic・rollback失敗、実SQLite FULL、各COMMIT境界のprocess exitと再開を確認した。Astraのread-only実装レビューで指摘されたhead検査とfirst-use根拠を修正し、追加の必須修正はない。

Rust workspace414件、TS1778件／121ファイル、型検査0error／0warning、build、Clippy／rustfmt、関連Chromium27件が成功した。browserは既存H1／desired／通常App検索の回帰で、DB管理用UIや実adapterの試験ではない。全体Prettierと文書リンクも確認し、全体CIはReady for ReviewのPRで確認する。

## PR #44レビュー修正（2026-11-03）

[P2指摘](https://github.com/tyaro/temp-scada/pull/44#discussion_r4445238600)を再現した。既存永久metadataを持つ8memberの予約がそれぞれ異なる8applicationで作られた場合、旧appliedと新mappingの検証がfirst-use根拠を重複decodeし、同じ計画の再適用でも256行上限を超えていた。

`EvidenceCache`を一つのapply transactionのread区間で共有する。SQL／row／bytesは実際の初回読取で課金し、cache hit時にも参照commit上限・enabled・対象descriptorを照合する。予約列／hash／MIN first-useと恒久metadataの検証は維持し、256行上限を引き上げない。別operationへcacheを持ち越さず、台帳・予約への書込み後に使わない。

8つの独立した初回予約を作り、結合計画の適用→同設定の再適用→状態／receipt照会を受け入れる回帰を追加した。低予算では書込みなしでControlを返し、次のoperationで参照mappingを破損させるとCorruptDataを検出する。Astraのread-onlyレビューに必須修正はない。

修正後はRust workspace415件、Clippy／rustfmt、既存契約のChromium8件、全体Prettierを受け入れた。Rust以外の製品コード・DB形式・依存は変更していない。

## PR #44追加レビュー: 別8member群への切替（2026-11-03）

[追加P2](https://github.com/tyaro/temp-scada/pull/44#discussion_r4448754854)として、永久metadataを持つ別々の8member群を切り替えるとfirst-use cacheが共有できず、256行を超えるケースも再現した。さらに16seriesのseries予約とsegment予約が分かれる32 originsを作り、各originが異なる保持revisionを参照する構成まで受け入れる。

同一transactionで正方向のhub/incarnation一致を検証できた場合は、既存UNIQUE制約を根拠に逆検索を省き、取得したpairをdescriptor照合へ再利用する。未存在のseriesIdでは逆向きの衝突検索を維持する。applied・desired定義・mapping・直前commitを索引付きJOINで取得し、保持applicationも定義／first-created／previous commitと一緒に読む。純粋validatorを共用し、canonical本文・hash・列・receipt・commit順序・初利用と保持previewの検証は省略しない。

SQLの取得rowは減らすが、全JSON本文のbytes、SQL statement／VM課金と256行上限は維持する。低予算rollback、16 originsの往復切替、32 origins＋別保持版での切替／再送、過去保持receiptやJOIN参照先欠落の破損検出を回帰する。Astraのread-onlyレビューに追加の必須修正はない。

追加修正後はRust workspace417件（H5b1新規24）、Clippy／rustfmt、既存契約のChromium8件、全体Prettierが成功。DB6・H1・依存と通常Appは維持する。
