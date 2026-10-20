# Runtime の SDK 投影境界

文書の位置付け: **現行SDK投影境界の仕様と検証記録。ブラウザの実Hub接続・正式Runtimeは後続。** 現在の対応範囲と保存契約は[実装状況](implementation-status.md)を正とする。

2026-10-18。`crates/scada-runtime` は、共有 SDK の読み取り結果を SCADA の表示用データへ変換するライブラリ。Tauri・HTTP サーバー・接続設定 UI・正式な Runtime 起動 mode はまだ実装していない。ブラウザの表示プレビューは引き続き Hub 未接続のまま。

## 依存と公開 API

`banto-tagclient` は industrial の `c4a61bc08ddf6d03fa56974bf1fcad08d12cbb5a` を `git + rev` で固定参照し、`Cargo.lock` でも固定する。共有 SDK をコピーせず、接続・再試行・購読・再解決・Stale 判定を再実装しない。式評価と書込み経路も作らない。

- `scada_model::Project::text_bindings()` は、検証済み Project の画面 Text から画面 ID・配置 ID・外部名を返す。共有定義内の直接 Binding は既存の検証で拒否する。
- `BindingPlan::new()` は同じ外部名を集約し、全使用箇所を保持する。`requests()` は SDK が要求する一意な `BindingRequest` を返す。参照がなければ空配列となり、将来の Host は SDK の `start()` を呼ばない。
- `project_view(plan, state, catalog)` は SDK の `TagClientState` と対応 catalog を受け、`RuntimeView` を返す。ここでネットワーク I/O を行わない。

`RuntimeView` は Project ID / revision、SDK の接続状態と安定したエラー分類、metadata の整合状態、外部名ごとの `NumericReading`、値の由来を持つ。Project JSON や編集履歴には保存しない。秘密鍵・接続先・SDK エラーの任意文字列は出力しない。

## 型付き読取slot

2026-10-20、[型付き読取slotの初回実装](typed-read-slots-design.md)を追加した。`ReadSlotPlan`は機器ID／slot名とbool／numberの期待型を持ち、`read_slot_view`で未割付を保持して投影する。既存数値Textとmetadata・値の検証を`projection.rs`へ共通化し、`NumericReading`のJSON契約は維持した。EquipmentのProject保存・UIとHostは未実装。表示用DTOを式評価の唯一の入力としない。

## 表示へ値を渡す条件

SDK が Live 以外なら全参照を `disconnected` とし、現在値と provenance を消す。Live でも current または catalog が欠ける場合は数値表示せず `invalid` とする。

catalog と current の revision / run_id / collection_mode が一致し、既知の collection_mode である場合だけ metadata が整合したと扱う。catalog の重複は SDK の `resolve_bindings()` による検証を使う。snapshot に同名の値が重複する場合も任意の 1 件を選ばず全値を無効にする。

整合した metadata の各参照について、次を確認する。

| 状態                                       | 投影結果                               |
| ------------------------------------------ | -------------------------------------- |
| catalog に名前がない                       | その参照だけ `unresolved`              |
| 無効化されたタグ、bit / string / 未知の型  | `invalid`                              |
| source 不一致、未知の source、現在値の欠落 | `invalid`                              |
| Good の有限数                              | `resolved` / `good` / 数値             |
| Good の null / 非有限数、未知の Quality    | `invalid`                              |
| Stale / Bad                                | `resolved` と品質を保持し、数値は null |

数値型は `i16/u16/i32/u32/f32/i64/u64/f64`。Hub の数値搬送は f64 なので、i64 / u64 が 2^53 を超える場合の精度制約を解消するものではない。

provenance には catalog revision・run_id・collection_mode・value_source・source timestamp を保持する。simulation を実データと区別する情報を落とさない。将来 UI を接続するときは、simulation を画面でも識別できることを受入条件にする。現在はこの wire DTO を UI に渡す Host 自体がない。

## 共有 SDK の前提条件

Astra との設計レビューにより、次の共有契約を [industrial #682](https://github.com/tyaro/banto-industrial/issues/682) に起票した。

1. 未解決名が混在しても正常タグを購読し、未解決を個別診断として公開する。
2. 対応する catalog / Binding resolution / current を同じ SDK 世代の状態 snapshot として公開する。

固定 SDK の worker は、未解決が 1 件でもあると購読全体を `BindingUnresolved` / Rebinding にして current を公開しない。また public state は current の値 snapshot だけを持ち、対応 catalog を同じ更新として取得できない。調査時の main `55d9d75ff55f9b856d7e9d61f15ead0e77f59c69` まで対象 API の変更はなかった。

adapter の部分成功テストは表示変換の保証であり、現 SDK の一つの購読でその入力に到達できることを示すものではない。統合テストでは全体が停止する現状も再現し、仕様の差を明示する。SDK 更新後に、この制限の再現テストを新契約の回帰検証へ置き換える。

Host 側で存在する名前だけを先に選別する方法や、タグごとに handle を増やす方法は恒久策にしない。再発見・再購読・世代管理を SCADA 側へ重複させるためである。別 fetch で取得した catalog も、adapter の世代照合は可能だが、今回のテストでは単にモック Hub と同じ fixture を渡しており、製品 Host の取得手順を実装したものではない。

## 次の Host 実装

共有契約の更新・検証済みコミットを参照してから、Project ごとに一つの SDK handle を所有する薄い Host を作る。Host が接続・停止を所有し、同じ SDK 状態更新から adapter へ投影する。

Project または接続先の置換時には旧値を直ちに消し、旧 task からの通知を拒否するローカル session 世代を設ける。同じ projectId / revision を持つ別ファイルの読込があるため、それらだけを session の識別に使わない。新しい metadata と current が成立するまでは値を公開しない。

上流の Tauri / mode / capability の境界は維持する。認証・ユーザー管理は industrial 側で修正中のため延期し、今回独自のログイン機能や公開 API を追加していない。

## 検証

```sh
source scripts/cloud-env.sh
cargo test --workspace --locked
cargo clippy --workspace --locked --all-targets -- -D warnings
pnpm test
```

単体テストは要求の集約・使用箇所 ID・数値 / Quality・型 / source・世代不一致・重複を検証する。`examples/runtime-reading-cases.json` を Rust と TypeScript の表示テストで共用し、Rust が出す `numericValue` 等の JSON 契約と画面の表示文字列を揃える。

`tests/sdk_projection.rs` は実 SDK を loopback のモック Hub に接続し、REST / WebSocket の初回値・値更新・Bad 化・切断・停止と、未解決 1 件による全要求停止を検証する。使用するキーはテスト内だけの固定文字列で、外部の秘密情報は不要。実設備・実 Hub・本番の再接続や認証連携の検証ではない。
