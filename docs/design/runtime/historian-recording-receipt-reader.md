# 元apply要求に対するreceiptの独立読取

状態: **H5d4c1のnative読取実装済み・owner接続は後続**。2026-11-03（日本時間）。主設計はユーザー指定のAstra。[明示操作契約](historian-recording-operations.md)のnative接続に必要な最初の読取境界を定める。 c2の[共有native owner](historian-recording-native-owner.md)はRust実装済みで、[c3の同owner read統合](historian-recording-owner-reconciliation.md)は詳細設計済み・未実装である。

## 工程と責務

| 工程   | 内容                                                                   | 今回の範囲                          |
| ------ | ---------------------------------------------------------------------- | ----------------------------------- |
| H5d4c1 | 既存HistoryReaderで元apply全文と保存receiptを同snapshot照合する有限API | 実装・隔離SQLiteで受入              |
| H5d4c2 | 単一共有native owner、受理前registry、三段階操作と共通DTOへの投影      | Rust実装済み・UI接続は後続          |
| H5d4c3 | 同ownerからの明示reconciliation、物理完了根拠との統合                  | 後続。c1のDB証拠を使い、latchを維持 |

既存`SqliteStore::recording_plan_receipt`はwriterへの可変参照とrequest IDを取る。supervisorから`take_store`して読む方法ではowner移管やwriter回復のgateを伴う。c1では既存の独立read leaseを使い、稼働中やwriterのNeedsReopen時もreader自身の健康状態と保存証拠に従って照会する。既存writer APIの意味は変えない。

## 公開API

```rust
HistoryReader::recording_plan_receipt_for_request(
    &mut self,
    request: &ApplyRecordingPlanRequest,
    control: &QueryControl,
) -> StoreResult<RecordingPlanReceiptSnapshot>

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingPlanReceiptSnapshot {
    pub snapshot_commit: u64,
    pub receipt: Option<RecordingPlanReceipt>,
}
```

型は`scada_historian::store::recording_plan`から公開する。これはnative管理読取の型であり、新しいbrowser DTO／HTTP endpointではない。d4aのschema、Project0.37.0、DB7、H1、SDK・依存版は変えない。

## 同snapshotの検証

入力は既存の`canonical::validate_apply`と`encode`で検証・正規化する。`HistoryReader::store_snapshot`のBEGIN DEFERRED内でheadを読んでsnapshotを固定し、同request IDのapplicationを探す。あれば既存`read::application`で保存request・receipt・desired定義・mapping・保持版・resolution hash・first-useと予約証拠を検証し、保存requestと入力のcanonical全文一致を要求する。

未登録は`receipt: None`、同IDの異なるcanonical本文は`StoreError::Conflict`、保存証拠の不整合は`CorruptData`とする。入力不正・SQL障害・予算切れ・reader異常は既存のtyped errorで返し、Noneへ変換しない。headや証拠の破損では、不在を断定しない。

現在headの期待版CAS、記録中session、保持jobなどの適用条件は再評価しない。古い要求のreceiptを新しいhead・mapping・保持版の後も取得できる。未登録の要求に対しても期待版が現在headと違うだけでConflictにはしない。MAX_SAFE期待版は要求として有効で、未登録ならNoneとなる。

native台帳のcanonical同値はmember順と整数表記差を無視する。d4aのJS/native要求echoは表示順まで一致させる別契約である。c2/c3では受理時の元owned要求を保持し、保存したcanonical本文からUI要求を再構築しない。

## 結果が示す範囲

Someはそのsnapshotに元要求と一致するcommit証拠があることだけを示す。現在applied、Running、worker／writerのquiescence、正常cleanup、回復不要の証明にはならない。Noneもsnapshot以後のcommitや実行中workerを否定せず、未送信・非commit確定・再適用許可にはならない。

このAPIはnativeのrecovery latchを受け取らず、解除・再開・再送を行わない。将来のownerはDB証拠と物理完了根拠を別々に統合し、元completion不変、既知receipt保持、quiescence単調更新とrecoveryのORを守る。

## 予算と寿命

callerの`QueryControl`を検証してから、既存の`bounded(control)`でdecoded rowsを最大256に制限し、callerのより小さい上限を優先する。要求128KiB・node8192とnested H5a検証、保存text128KiB・合計input8MiB、caller出力byte／VM／絶対期限／取消の規則を再利用する。入力正規化やblocking poolで使った時間のためにdeadlineを延長しない。

既存の二reader lease制限とread-only connectionを再利用し、新しいconnectionやleaseは発行しない。同じreaderの可変参照によってreadは直列となる。panic・取消・失敗でもprogress handlerを外してrollbackする。cleanupに失敗したreaderは以降ReaderUnusableとし、writerの状態を正常化しない。writerをDropした場合もreaderのleaseが所有lockを保持する。

## 受入

隔離SQLiteでFound／None／Conflictを確認し、古いreceiptと現在head、native canonical同値と元要求の区別を検証する。headでsnapshot固定後にwriterがcommitしても、そのreadは旧snapshotの結果とcommit番号を返し、次のreadで新receiptを確認する。

実SQLite FULLによるrollback後のNone、commit後の応答喪失からのFound、保存証拠破損の拒否、複数first-useを含む最大8member／32originsで既存256行予算を確認する。read-only authorizer、取消・期限・row／byte／VM上限、panicとcleanup失敗、reader leaseとwriter所有も検証する。

c1はRustの読取APIだけを追加する。通常Appのservice・UI・Project保存、supervisorのmutable操作・native owner、実Hub／S7／本番DB、認証・製品transportは接続しない。

Rust workspace560件（新規16）と既存共通Chromium3件、Clippy `-D warnings`／rustfmtが成功。Astraの設計・実装レビューに必須修正はない。browser検証は共通契約とProject保存不変の継続確認であり、新native readのbrowser配送の受入ではない。
