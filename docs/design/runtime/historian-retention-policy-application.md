# Historian H2c10: 保持policyの原子適用と実applied比較

2026-11-01。状態: **Astra 主設計の採用契約、Rust library実装・ローカル受入済み**。[P5のdesired／applied](historian-trend-contract.md)、[影響preview](historian-retention-preview.md)、[elapsed duration](historian-retention-duration.md)、[coordinator](historian-retention-coordinator.md)を具体化する。

## 実装・受入結果

`retention/application.rs`と`application/read.rs`に実装した。保存済みpreviewの意味検証と集約builderは`preview.rs`で共有し、read transactionとapply transactionはそれぞれ単一Budgetで呼ぶ。policy／preview／recovery等の保存DTOに型付きDeserializeを追加し、GuardStateのDeserializeは追加していない。

Rust workspace314件（新規application15単体・coordinator race1単体、child worker含む）・Clippy `-D warnings`／rustfmt・関連Chromium6件が成功。実applied比較・両CAS、immutable定義・同policy再適用・復旧と安定再送、記録中適用・job中拒否、後日のraw削除／別policy後の元receipt、coordinator判定後のapply競合を確認した。実SQLite FULL、予算・取消・panic・SQLfailure／rollback poison、COMMIT前後5境界のprocess終了、format4の非変更拒否も検証した。

Astraレビューにより、保存apply receiptでは本来存在し得ないactive jobを明示拒否した。整合する偽job DTOの混入を再現して修正した。jobの適用世代は列だけでなく内部StoredJobRequestにも保存・照合し、NULL化／別世代改変を拒否する。current headは索引先頭のscalarで照合し、前世代はmetadataだけを読み、receiptを再帰decodeしない。最終レビューに必須修正はない。全体CIはPRで確認する。

H1 JSON v1・依存・SDK・Project・Banto・TS／通常Appは維持する。ブラウザでは既存H1／SQLite投影契約を回帰した。上流・S7・実環境には接続していない。

## 今回閉じる境界

H2c9の比較policyはcallerの指定だった。今回は実appliedを永続化し、その設定を比較基準にしたpreview、期待revisionとpreview snapshotの競合検査、原子的な適用、再起動後の復元、新しい保持jobとの結合までをRust libraryで閉じる。

設定の保存・適用・掃除は別操作である。このAPIはapplied保持policyを変更するだけで、raw削除、job開始、fence更新、session停止、clock guardのrearmを行わない。Project desired配布、製品認証／transport、管理画面、人手approval、scheduler、信頼時計adapterは追加しない。保持日数やtimezoneのdefaultを発明せず、今回の永続適用は明示Elapsed policyだけを受け付ける。ExplicitCandidateの純粋guardと直接job APIは明示保守用途として残す。

内部DBはformat 5へ更新する。format 4以前を黙って移行せずUnsupportedStoreとして拒否する。H1公開JSON、SDK／Project／Banto／依存は変更しない。上流・通常App・実環境には接続しない。

## 型と入口

最終の綴りは実装に従う。policyはRetentionClockPolicy全文で、cutoff_rule、clockの各制限、initial ceilingも含む。

```rust
struct AppliedRetentionPolicy {
    applied_revision: u64,
    commit_version: u64,
    request_id: String,
    policy: RetentionClockPolicy,
}
struct PolicyPreparationRequest {
    proposed_policy: RetentionClockPolicy,
    reference_wall_ms: i64,
}
struct PolicyPreparation {
    expected_applied_revision: Option<u64>,
    snapshot_commit: u64,
    preview: RetentionPreview,
}
struct PolicyApplyRequest {
    request_id: String,
    expected_applied_revision: Option<u64>,
    expected_preview_snapshot_commit: u64,
    proposed_policy: RetentionClockPolicy,
    reference_wall_ms: i64,
}
struct PolicyApplyReceipt {
    request_id: String,
    applied_revision: u64,
    commit_version: u64,
    policy_id: String,
    policy_revision: u64,
    preview: RetentionPreview,
}
```

`preview_retention_policy_application(&mut self, request, control)`はPolicyPreparation、`apply_retention_policy(&mut self, request, control)`はPolicyApplyReceiptを返す。ともに既存StoreResult／QueryControlを用いる。

StoreRecoveryStateに`applied_retention_policy: Option<AppliedRetentionPolicy>`を追加し、同snapshotの状態照会とrestart復元に使う。専用の二重状態照会APIは不要。初期値はNoneでありdefault policyを生成しない。

applied_revisionはこのstoreの適用世代であり、policy.revisionとは別物である。初回1、以後1ずつ増加し、safe整数上限で拒否する。policy IDを変更しても世代はリセットしない。global commitは既存内部commitの範囲を維持し、safe整数へ不当に丸めない。

## 実applied preview

read transactionを一度開始し、既存recovery::read_snapshotでsnapshotを固定する。現在applied全文をcomparisonとし、proposedと同じreference_wall_msでH2c9のpreviewを生成する。初回はcomparison=None。callerが任意の比較policyを差し込む余地を作らない。汎用のpreview_retention_changeは引き続きcaller比較用である。

expected_applied_revisionとsnapshot_commitはそのsnapshotの値。短縮・延長・同duration、実在rawのcounts、半開区間、fenceをclampしない規則、whole tick構造検査、全成功または全エラーの意味はH2c9と同じ。active session／job中もpreviewは可能で、その状態を結果へ添える。

このpreviewは予約、認可token、署名、閲覧証明ではない。callerは明示実行の責任を持つ。適用時には同じproposed／referenceと期待世代・snapshotを送り、storeが内部でfresh previewを再計算する。追加の人手確認段階を要求しない。

## 適用の順序と原子性

1. requestのID、policy、reference、期待値を検証し、型付きcanonical payloadを作る。
2. 同request_idの保存済みoperationを調べる。同じ論理payloadなら検証済みreceiptを返す。異なるpayloadはConflict。再送は現在applied／active job／snapshotが変わっていても過去の結果を返し、設定を戻さない。
3. 新規要求はBEGIN IMMEDIATE内でrecoveryとappliedを読み、expected_applied_revisionおよびexpected_preview_snapshot_commitを現在値と照合する。どちらか不一致ならConflict。active jobがある新規適用はBusyとして拒否する。active recording sessionは設定metadataの適用を妨げない。
4. 同transactionで実appliedを比較基準にfresh previewを完全計算する。別transactionの公開previewをnested呼出しせず、H2c9の内部集約helperを共有する。
5. immutable policy definitionを照合／追加し、新applied世代とcommitを採番する。operation、receipt、current pointerを同transactionで保存してCOMMITする。

previewに含むsnapshot／recoveryは適用直前の状態であり、receiptのcommit_versionはその後の適用commitである。preview snapshotはrequestの期待値と等しく、apply commitより小さい。

別request_idで同じpolicyを再適用する場合もfresh CASを要求し、新しい適用世代とcommitを記録する。過去definitionへの明示的な戻しは許すが、rawは復元されずfenceも戻らない。同policy_id／policy.revisionで内容を変更することはConflictとする。汎用previewが同IDの異内容比較を許すこととは区別する。

取消、仕事量超過、Conflict、FULL、SQL失敗がCOMMIT前に起きれば旧appliedとrawを維持する。成功COMMIT後の遅延取消で成功receiptを取り消さない。応答喪失時は同requestを再送する。SQL／I/O障害のNeedsReopenとrollback guardは既存write failure契約を継承する。

## format 5の永続情報

| table／列                              | 意味と制約                                                                                                                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| retention_policy_definitions           | `(policy_id,policy_revision)`複合PK、全文payload_json、created_commit。IDとpolicy revisionを検証し、内容immutable。created_commitは初登場operationのcommitで、再適用時は維持 |
| retention_policy_applications          | request_id PK、canonical request payload_json、applied_revision UNIQUE、commit_version UNIQUE、expected_applied_revision、policy_id／policy_revision、receipt_json           |
| retention_policy_state                 | singleton=1、nullable applied_revision FK。NULLは初期未適用のみ                                                                                                              |
| retention_jobs.policy_applied_revision | nullable FK→applications.applied_revision。coordinator起点jobは世代を記録し、直接手動jobはNULL                                                                               |

applicationsのpolicy複合FKはdefinitionsへ、expected_applied_revisionは直前applicationへ参照する。初回だけNULL、以後は新世代−1。世代は1以上safe整数、commitは既存SQLite内部範囲の正整数。current pointerをMAX(applied_revision)／最新commitと照合し、欠落や巻戻しをCorruptDataにする。singleton欠落も初期Noneと解釈しない。

definitionの全文とoperation header／requestを型付きで比較する。field順に依存せず、未知field、unsafe値、不正enum等を拒否する。serde Deserializeは保存policy／receiptを構成するDTOへ限定して追加できる。GuardStateをdeserialize可能な再開tokenにはしない。

AppliedRetentionPolicyはmetadataとpolicyだけを持つ。前世代のreceipt全文を埋め込まず、receipt→preview→recovery→applied→過去receiptという再帰的膨張を避ける。

## 保存receiptの検証範囲

同ID再送で保存receipt_jsonを無検証に返さない。少なくとも次を照合する。

- canonical requestと今回要求の型付き等値、operation headerとrequest／receiptのID・世代・commit・policy参照の一致。
- proposed全文、reference、derive_cutoff結果、preview snapshotと期待snapshot、snapshot < apply commit。
- comparisonの有無と全文がexpected applied世代のdefinitionに一致すること。初回は比較なし。以前のreceiptを再帰decodeする必要はない。
- TargetCountsの非負・0件とextremaの対応・tick／observation／seriesの範囲、対象半開区間、duration分類と差分範囲、tick／observationのchecked partition、同durationの結果一致。
- preview recoveryのapplied metadataと前世代参照の整合。snapshotに対する各commitの時間順序と、既存recovery DTOの型／意味上の制限。

過去rawを再集計してreceiptを作り直さない。rawが後日削除されてもreceiptは当時の結果を保つ。この検査は保存内容の論理整合検査であり、暗号学的改ざん検知や全DB監査ではない。

## 新しいjobへの接続

coordinatorのBeginは、まず従来どおりactionがProposeかを確認する。それ以外はNotProposed。ProposeでもappliedがなければPolicyNotApplied、入力policy全文が異なればAppliedPolicyMismatchとしてNoWriteにする。その後にrequest cutoff／expected fenceを照合する。

recovery時の一致だけでは十分でない。coordinator専用のbegin内部入口はBEGIN IMMEDIATE内でも期待applied世代と全文を再照合し、jobにpolicy_applied_revisionを保存する。preview／assessment後に別applyが入った場合、新しい設定を旧guardで実行しない。active job中の新apply拒否と合わせて、job開始とpolicy適用の競合を閉じる。

JobStatusにpolicy_applied_revisionを返し、復旧時にも固定した出典を説明する。ContinueExistingと保存済みstep／begin receiptの再送は現在policyへの再承認を求めず、既存の固定job契約を維持する。直接job／trim APIは明示手動保守として残り、自動適用経路と偽称しない。

設定適用はclock guard stateを自動更新しない。full policy snapshotによるPolicyChangedやsticky Suspendedを維持し、hostが明示rearmするまで新policyによる自動jobを始めない。reference_wall_msはpreview計算の参考時刻であり、時計信頼や今後のcutoff許可ではない。

## 有限予算・寿命・障害分離

previewとapplyは各々一つのoperation／transaction内で共通Budgetを消費する。SQLごとのVM先払い、callback、decode行数、deadline、取消、出力byte、入力JSONの64KiB単体／8MiB累積制限を継承する。保存receiptも有限な構造を読み、巨大JSONを先に無制限decodeしない。完全previewが予算に入らなければ適用せず全エラーとする。

handler解除→rollbackのOperation Drop、cleanup失敗時のconnection poison、writer／reader leaseを維持する。BEGIN IMMEDIATE中の集約はwriterを占有するため、長い適用を無制限に許さない。OS I/Oのhard deadline保証、全媒体障害からの自動回復、物理容量縮小は主張しない。

policy適用失敗はHistorian保守経路へ返し、Hub現在値・SCADA警報評価を止める仕様にはしない。実hostの分離／運用通知は後続である。

## 受入と次工程

- 未適用preview／初回apply／restart復元。実appliedが比較基準となり、caller指定の旧policyを使わない。
- 同ID同内容の安定receipt、同ID別内容Conflict、同policy ID／revision異内容Conflict。別ID同内容はfresh CAS後に新世代。
- expected revision不一致、preview後append／gap／apply等によるsnapshot変化をConflictにし、raw件数が変化した古いpreviewで適用しない。
- active session中の適用可、active job中新規適用不可、同ID再送は過去receiptを維持。適用でraw／fence／session／jobを変更しない。
- SQL失敗／実SQLite FULL／取消／低予算／panic／process終了の各transaction境界で旧appliedまたは新applied一式だけが見える。COMMIT後応答喪失は同要求で復旧する。
- current pointer巻戻し、definition不一致、receipt counts／range／snapshot／前世代改変をCorruptDataとする。後日のraw削除によって正常receiptを拒否しない。
- coordinator未適用／policy mismatchはNoWrite、正しいelapsed適用後だけ新jobを開始する。assessment後の設定変更をtransaction内再検査で拒否し、既存job継続・再送を壊さない。
- format 4拒否、format 5再open、H1履歴query・既存preview・clock guardの回帰。

この工程でapplied保存と新jobへの接続を完成対象とする。desired設定配布／権限、trusted clockの取得、scheduler、recorderとの停止・再開、暦日timezone、receipt GC、容量運用は引き続き別工程である。製品の自動保持完成とは扱わない。
