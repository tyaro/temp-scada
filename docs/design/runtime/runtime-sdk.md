# Runtime の SDK 投影境界

状態: **P1検証成功・PR #10マージ済み、P2読取Host追加**（2026-11-01、日本時間）。[S7 SOAK中の実行計画](../../project/soak-independent-runtime-plan.md)に従う。製品Host・実Hub接続・正式Runtimeは後続であり、通常Designerは未接続のまま。

## 依存と公開API

`banto-tagclient`はIndustrialの`v0.3.0-alpha.1`に対応する`33410f6d25d36559c5ce81375e243eb6f3e85038`へ`git + rev`と`Cargo.lock`で固定する。#682の部分解決・`Unbound`・同一世代snapshotを利用する。共有SDKの接続・再試行・再解決・Stale判定・式評価を複製しない。

- `BindingPlan::new(project)`は数値Textの同じ外部名を集約し、使用先を保持する。
- `ReadSlotPlan::from_project(project)`は採用済み機器slotの構造化key、bool／number型、未割付を保持する。同じ外部名を複数contextへ配るがSDK要求は重複させない。
- `project_view(plan, state)`／`read_slot_view(plan, state)`は、同じ`state.snapshot()`のcatalog・resolution・値から表示DTOを生成する。別fetchのcatalogを受け取る引数は廃止した。
- planの各要求についてSDK resolution内のbinding keyと外部名を照合する。要求外の名前を未作成と誤診せず、plan不一致は`invalidCatalog`とする。Textとslotを合わせた購読の一部分を投影することは許す。

値・Quality・provenanceはProjectとUndo履歴に保存しない。秘密鍵・接続先・任意のSDKエラー文字列を表示DTOへ含めない。snapshot全件をfrontendへ渡さない。

## 接続状態と表示

| SDK状態 | 表示DTO                                                                                                                |
| ------- | ---------------------------------------------------------------------------------------------------------------------- |
| Live    | metadata確認後、解決済み参照を投影。未解決参照はその名前だけunresolved                                                 |
| Unbound | catalog／resolution確認済みでmetadataReady=true。割付済みはunresolved、未割付はunassigned。値・Quality・provenanceなし |
| その他  | metadataReady=false。割付済みはdisconnected、未割付はunassigned。旧値とprovenanceを消す                                |

`metadataReady`は対応するmetadataの確認を意味し、値の存在を意味しない。未知collection_modeやplan不一致を正常なタグ待ちに変換しない。不正なUnbound DTOもブラウザで拒否して値を消す。

SDKはcatalog・resolution・currentの同一世代を保証する。adapterもrevision／run_id／collection_mode・重複行を検査し、未知modeや不整合を正常表示にしない。旧SDKの「未解決1件で全購読停止」という制限は解消済みで、その再現テストを新契約の回帰へ置き換えた。

## 型・Quality・値の由来

| 条件                                  | 投影                                                    |
| ------------------------------------- | ------------------------------------------------------- |
| 名前がcatalogにない                   | unresolved                                              |
| 無効タグ・期待型と不一致              | その参照だけinvalid                                     |
| 値側sourceが未知、値欠落、未知Quality | その参照だけinvalid                                     |
| Goodの有限値                          | numberは数値、bitは0／1だけboolへ変換                   |
| Bad／Stale                            | Qualityを保持し、valueはnull                            |
| catalogと値のsourceラベルの不一致     | 値側を正として投影。catalogの情報ラベルで値を抑止しない |

数値型は`i16/u16/i32/u32/f32/i64/u64/f64`。f64搬送のため2^53を超える整数精度の制約は維持する。boolは`bit`だけを受け、任意の数値を真偽に丸めない。未解決・Bad／Staleをfalseや0にしない。

`ValueEntry.value_source`を正とする（#682 R7）。未知sourceをRealへ昇格させない。provenanceはcatalog revision・run_id・collection_mode・値側source・source timestampを保持し、simulation／derived_simulationを画面で識別する。既存DTOの`sourceMismatch`理由は語彙として残すが、catalogと値の情報ラベルの違いでは生成しない。

## Hostとの境界

投影APIは引き続き純粋で、ネットワークI/Oを行わない。P2でProjectごとに1つのSDK handleを所有する[読取Host](read-host.md)を追加した。Textとslotの要求を集約し、0件ではSDKを開始しない。要求変更は`shutdown()`→`start(new_requests)`とし、`restart()`が要求を引き継ぐ点に注意する。

Project・接続先の置換と停止では先に表示を無効化する。Hostのローカルsession tokenで旧task通知を拒否し、同ID／revisionの別Projectも区別する。SDK generationだけでProject sessionを識別しない。認証・ユーザー管理・正式transportは今回接続しない。

## 検証

`tests/sdk_projection.rs`は実SDKとloopbackモックHubを使い、部分成功・Unbound・追加／削除／rename・run_id変更・再解決中の旧値消去・認証拒否・Quality変更・切断・停止を確認する。世代境界でモックのcatalog応答を保留し、watchが中間状態を取りこぼしても無効化を観測できるようにする。

`examples/read-slot-view-cases.json`はRust投影→JSON Schema→TS受入の共通fixture。Unboundと値側source優先を含む。ブラウザは同一mountのメイン・埋込・小窓・機器詳細へ更新を渡し、タグ待ちで値と由来が消え、Liveで復帰することを両テーマで確認する。

実行結果は[実行計画](../../project/soak-independent-runtime-plan.md)に記録する。実設備・S7環境・Windows運用の検証ではない。
