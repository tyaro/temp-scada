# 型付き読取slotの初回実装

状態: **表示用adapterのplan・共通投影・SDK統合テストを実装。Equipmentの保存・編集UIは未実装。** 2026-10-20。Projectは0.22.0のまま。[統合設計](scada-integrated-design.md)§5、上流§7／§8のEquipment contextへ進む前段とする。[機器作成の追加検討](equipment-authoring-detail-proposal.md)全体の採用完了ではない。

## 今回の範囲

`crates/scada-runtime`へbool／numberの読取slotを追加した。機器の登録情報や配置とは別に、Host内部で一回の投影に使う検証済みplanを持つ。planや現在値はProject JSON・Undo・clipboardへ保存しない。Rust／TS／schemaのProject契約と依存SDKのrevは変更しない。

既存Textの数値投影と新slotは、metadata照合と値の変換を`projection.rs`で共用する。既存の`BindingPlan`／`project_view`／`NumericReading`の公開契約は維持する。UIの状態ランプ・動的Symbolを今回追加したものではない。

## planと識別

| API                                                 | 役割                                                                    |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| `ReadSlotKey { equipment_id, slot_name }`           | 機器と役割を構造化したキー。区切り文字連結や表示名で同一性を判断しない  |
| `ReadSlotRequest`                                   | キー・期待型・任意の`external_name`。未割付は`None`のみ                 |
| `ReadSlotPlan::new(project_id, revision, requests)` | 重複キー・空のProject／機器／slot／外部名を拒否してplanを生成           |
| `ReadSlotPlan::requests()`                          | 同じ外部名を一度だけSDKへ要求。全て未割付なら空配列                     |
| `read_slot_view(plan, state, catalog)`              | SDKのstateと対応metadataから表示結果を生成。ネットワークI/O・書込みなし |

空白だけの名前は拒否するが、自動trimや大文字小文字の変換はしない。同じ外部名を複数機器・用途で参照できる。slotキーは別なので一方の型不一致が他方を無効化しない。存在しないキーを未割付へ変換しない。機能未採用のslotはplanに含めず、必須slotの宣言不足や機器種別適合は後続の定義検証へ分離する。

このAPIの`equipment_id`は呼出元で確定した安定IDを想定するが、UUID・登録台帳の存在は今回のadapterでは検証しない。Equipmentを永続化するときにProjectの参照検証へ追加する。表示配置ごとのタグ割付コピーを新しい機器の生成とみなさない。

## 状態と型

`ReadSlotView`はProject ID／revision、SDK接続状態と安定エラー分類、`metadataReady`とslot結果の配列を持つ。配列の各要素に構造化keyを残し、JSON object keyへ無理に連結しない。

| state                         | 条件と表示側の意味                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| `unassigned`                  | planに宣言済みだが未割付。接続状態にかかわらず未設定                               |
| `disconnected`                | 割付済みでSDKがLive以外。以前の値とprovenanceを含めない                            |
| `unresolved`                  | 整合したcatalogに指定外部名がない。停止・0へ置換しない                             |
| `invalid { reason }`          | metadata欠如・世代不一致・型不一致・無効タグ・値欠落など。安定した理由コードを返す |
| `resolved { quality, value }` | Goodだけ型付き値を持つ。Bad／Staleはqualityとprovenanceを保ち、valueはnull         |

`bool`はHubの`bit`のみで、搬送された有限数の0／1だけをfalse／trueへ変換する。2・負数・小数・null・非有限数をtruthy扱いしない。信号の極性や「停止」「故障」の意味はここで推測しない。

`number`は`i16/u16/i32/u32/f32/i64/u64/f64`の有限数。bitを数値slotへ許可しない。整数の再丸め・工学値の再スケーリング・単位換算をしない。64bit整数のf64搬送による精度制約は維持する。読取専用なので`writable:false`は読取拒否の理由にならない。

`metadataReady`はcatalog/currentの構造と世代の整合を表す。全slotの型・値・割付が正常である保証ではない。revision／run_id／collection_modeの不一致、未知mode、SDKが拒否するcatalog、同名current行の重複は全ての割付済みslotをinvalidにする。未割付はそのまま残す。個々の型・source・enabled・値の不成立はそのslotへ局所化する。

既知sourceの一致、Goodの有限値、未知Qualityの拒否は既存Textと共通。Staleの時刻判定やsimulation生成、接続・再試行・式評価は共有SDKに委ねる。provenanceにrevision・run_id・collection_mode・value_source・source timestampを残す。この表示DTOはStale値を含めないため、上流§9.5の式評価入力をこのDTOだけへ固定しない。

## Hostと後続工程

[industrial #682](https://github.com/tyaro/banto-industrial/issues/682)は2026-10-20確認時もOPEN。固定SDKでは未解決名が混ざると購読全体が停止し、catalogとcurrentの同一更新公開も未整備。adapterの部分成功は、現SDKの一つの購読でその入力に到達できる保証ではない。[SDK境界の記録](runtime-sdk.md)を維持する。今回は重複Issueを作成しない。

Project ID／revisionだけでは同名同revisionの別ファイルを識別できない。Hostは別途session世代を持ち、旧task通知を破棄する必要がある。今回のadapterは渡された同一世代metadataの照合を行うだけで、sessionの所有や対象切替の制御を実装しない。

次は次の順に進める。

1. EquipmentType／Instance、採用するread slot、未割付の保存・番号の一意性・参照制約を具体化し、Rust／TS／schemaへ揃える。
2. 機器台帳・明示的なslot割付と使用先確認を既存draft guard・Undoへ接続する。
3. 同じ機器contextの読取表示をSymbol等で共有する。模擬値と実値を区別する。
4. SDK #682の更新済み契約を確認してHost・実Tag Browserへ進む。Faceplate・書込み・認証は各独立工程。

## 検証

Rust全40件（model23・runtime単体14・SDK統合3）が成功。新単体8件は構造化key・外部名集約・局所的な型不一致・未割付・厳密BOOL・品質とsimulation由来・世代・重複・sourceを確認する。既存数値の共通fixtureとAPIの回帰も成功した。

新SDK統合1件はloopbackのモックHubへ実SDKを接続し、同じbitタグの購読要求が一つであること、2機器へのtrue／false、同じタグのnumber slotだけの拒否、catalog未取得、Bad／Stale、切断・停止時の値とprovenance消去を確認する。実設備・実Hub・正式Hostは検証していない。

統合テストの初回コンパイルでは、shutdownがhandleを消費するSDK契約に対して停止後のhandleを参照していた。既存watch receiverから停止状態を読むように修正し、全体を実行した。初回Clippyの冗長field名2件も修正済み。テストの無効化やassert緩和はしていない。

Astraの静的レビューでは必須修正や既存数値の回帰は見つからず、提案された別外部名の正常slot併存を単体テストへ補強した。補強後もRust40件・Clippy（警告をエラー扱い）・Rust fmtが成功。TS全676件、全体Prettierも成功した。UIとProject契約は未変更で、この区切りのローカル全ブラウザ再実行・画面再撮影はしていない。最終差分の全体CIはPush後に確認する。

## 後続のEquipment保存接続

0.23.0で[機器の保存と初期台帳](equipment-register-design.md)を追加した。`ReadSlotPlan::from_project()`は検証済みProjectの採用read slotを機器contextへ変換し、`Result`を返す。slot plan自体や現在値は保存しない。先行実装時の0.22.0・UI未変更という記録は当時の範囲であり、現在の保存形式は実装状況を参照する。

## 後続の表示DTO受入

Project0.25.0の共有Symbolに続き、[TSの受入境界・session世代とGood／Quality表示](read-slot-presentation.md)を実装した。Rust実投影からの共通fixtureとブラウザの同一mount更新を検証する。初回実装時の記録は維持し、実Host・実Hub接続が未完了であることと区別する。
