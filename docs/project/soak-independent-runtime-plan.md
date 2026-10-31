# S7 SOAK中のSCADA読取開発計画

2026-11-01（日本時間）。状態: **採用・P1マージ済み、P2実装・ローカル検証済み**。ユーザー指示により、IndustrialのS7 SOAK中は上流を変更せず、固定SDKとloopbackのモックHubで開発する。文書作成は実装完了を意味しない。

## 前提と責務

- Industrial基準: [`v0.3.0-alpha.1`](https://github.com/tyaro/banto-industrial/tree/v0.3.0-alpha.1)、commit `33410f6d25d36559c5ce81375e243eb6f3e85038`。Cargoはタグの移動に影響されない完全なrevへ固定する。
- #682の部分Binding解決・`snapshot()`・`Unbound`を使う。接続・再解決・再接続・Stale判定をSCADAに複製しない。
- S7のHub・PLC・DB・設定・資格情報へアクセスしない。上流へのpush、Issue変更、共有crateの切出し、SOAK中のサービス再起動を行わない。
- Project0.35.0とBanto v6.9.0を維持。認証・運用移行・設備操作の接続は従来どおり保留する。
- 2026-11-01の責務整理: Hubは現在値配信と書込み。SCADAサーバは警報評価・ACK・常時Actionと警報／操作イベント。Historianは時系列記録・保持・検索・History API。画面はAPIを介して表示する。
- Historianは論理的に分離する。初期はSCADAサーバと同一プロセスへの同梱を許し、独立サービス化できる境界にする。時系列と警報／操作イベントの記録は別の契約とし、二重記録しない。
- ChronoGazerの`banto-tstore`／`banto-tsquery`とTrend資産を共通利用する。SOAK中は資産の複製やアプリ全体の取込みをしない。既存History APIの1時間制限と未実装のヒストリカル画面を、長期間トレンド完成と扱わない。

既存の[統合設計](../design/scada-integrated-design.md)の提供段階を維持する。Historianの責務分離は同設計§6の「History APIはSCADA server側」を詳細化する差分であり、HubへHistory APIを追加する変更ではない。`docs/upstream/industrial`は参照スナップショットのまま変更しない。

## 工程と完了条件

各工程は詳細契約→実装→受入→保存の順に進める。P1から順に着手し、後続の未実装を提供済みと記載しない。

| 工程                | 内容                                                     | 完了条件                                                                                                      | 状態                   |
| ------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------- |
| P1 固定SDKと投影    | rev更新、同一世代snapshot、部分解決、Unbound、値側source | Rust契約試験、共通DTO fixture、ブラウザのUnbound受入と旧値消去が成功                                          | 完了・PR #10マージ済み |
| P2 読取Host         | Projectごとにhandle1つ。Textと機器slotの要求を集約       | 開始／停止、要求集合変更、接続先変更、旧task通知拒否、空要求の非接続をモックで確認                            | 実装・ローカル検証済み |
| P3 表示受入         | 数値Text・Symbol・機器小窓への読取更新                   | 正常／部分未解決／タグ待ち／Bad・Stale／切断／SIMを同一mountで確認。実Hostと画面のtransportは明示設計後に接続 | 未着手                 |
| P4 Tag Browser      | catalog表示DTOと既存選択UIの接続準備                     | 検索・型絞込み・明示確定・古い結果の拒否。Projectにcatalog全件・資格情報を保存しない                          | 未着手                 |
| P5 Historian／Trend | 共通利用とAPI境界の設計                                  | 下記の未決とSOAK後の上流作業を文書化。共有部品の切出しや履歴サービスの実装完了とはしない                      | 未着手                 |

## P1の実装契約

1. `project_view(plan, state)`と`read_slot_view(plan, state)`は、同じ`state.snapshot()`からcatalog・resolution・値を取得する。Hostが別fetchのcatalogを組み合わせる引数を廃止する。
2. `Live`では正常参照を投影し、SDKが未解決とした参照だけを`unresolved`とする。型不適合・無効タグ・未知source／Quality・非有限値の表示拒否は局所化する。
3. `Unbound`は接続済みのタグ待ち。割付済み参照は`unresolved`、未割付slotは`unassigned`、値・Quality・provenanceは持たない。`metadataReady`はcatalogとresolutionの確認済みを表し、値の存在を意味しない。
4. その他の状態では旧値とprovenanceを消す。Bad／Staleも数値やboolを残さずQualityだけを保持する。
5. `ValueEntry.value_source`を正とし、catalog側の表示ラベルとの不一致を理由に正常値を捨てない。値側の未知sourceを実機値に変換しない。
6. SDKの要求に含まれない名前を「未作成」と誤診しない。projectionのplanと公開resolutionの対応を検査する。複数planの要求を同じhandleへ集約できるよう、projectionは自分の要求が含まれることを確認する。
7. `Unbound`のDTOをRust／JSON Schema／TypeScriptで揃える。非Liveの値保持を拒否する既存契約は維持し、Unboundに限って無値の未解決診断を許す。

P1の試験: 正常＋未作成の混在、全件未解決→追加→Live→削除→Unbound、rename先への非自動割当、config変更／run_id変更時の世代整合、認証拒否／切断／停止時の消去、値側source優先、boolのfalse・数値0。実SDKをモックへ接続する試験と、Rust→ブラウザの共通fixtureを使い分ける。

## P2〜P4で維持する契約

- HostはSDKのライフサイクルを呼ぶ薄い所有者とする。要求集合を変えるときは`shutdown()`→`start(new_requests)`。`restart`が旧要求を引き継ぐ点に注意する。
- Textとslotに同じ外部名があれば1要求へ集約し、個々の使用先へ投影する。要求0件ではSDKの`start()`を呼ばない。
- Project読込、接続先変更、停止は先に表示を無効化する。同じprojectId／revisionの別ファイルもあるため、Hostのローカルsession tokenで旧taskを拒否する。SDK generationはProject sessionの代わりにしない。
- P3は既存のDTO fixture経路でも表示を検証する。fixtureでの成功と製品の端から端までの接続成功を区別する。Tauri／HTTP transport・認証を推測で新設しない。
- P4のcatalog取得はHost所有。選択中にProject・対象slot・catalog世代が変われば古い候補を適用しない。接続できない場合は現在の入力を保持し、タグを自動作成・renameしない。

## P5で確定する内容

- 記録設定の所有者と配布: Projectの設定とHistorianへの配布／更新の関係。画面で表示していないタグも記録を継続する。
- タグidentity: Hubの名前、Historian内の系列ID、rename・同名再作成・複数Hubの区別。過去系列を無断で接続しない。
- History API: UTC時刻、期間、タグ数、点数、min/max包絡、timeout、欠測・Quality・SIM、保持期限、未記録・サービス停止の応答。
- ライブと履歴の境界: 初期履歴窓とライブ追記の重複／欠測、flush遅延、Hub再起動と世代変更。
- 共通化: ChronoGazerの保存・検索・描画の依存を調べ、共通crate／packageとSCADA固有widget・Project属性を分ける。DBやデータファイルを画面から直接読まない。
- 障害分離: 履歴検索・保存失敗でライブ表示・警報評価を止めない。容量・保持・サービス監視はHistorianの責務にする。

## 検証と保存

`source scripts/cloud-env.sh`後に、Rust変更は`cargo fmt --all --check`、`cargo clippy --workspace --locked --all-targets -- -D warnings`、`cargo test --workspace --locked`を実行する。TS／DTO変更は`pnpm check`、`pnpm test`、`pnpm build`、関連Playwrightと整形を実行する。保存形式を変える場合だけProject schema・TS／Rust・サンプル・保存往復を追加検証する。

各工程の実行結果・未検証・Git状態・次工程を記録し、日本語Conventional Commitで保存する。PRのCI結果は実際に確認してから記載する。上流変更が必要になった項目は根拠を記録して保留し、独立して進められる項目を継続する。

## 着手時の確認

- SCADA基準: `work`の`1d2e51c8d494694622cc09f61136b4fe211e0372`。取得直後はdirty差分なし。
- I1〜I4・I6〜I8は提供済み。性能のI5i〜I5n等の候補は効果不足で不採用。読取経路の前提として再試作しない。
- 現行の認証延期とローカル編集を維持する。S7終了後の実Hub・Windows・本番運用の検証は別に記録する。

## P1の実施結果（2026-11-01）

固定revとlockfileを更新し、両投影APIからcatalog引数を撤去した。同一snapshotのresolution照合、Unboundの無値診断、値側source優先を実装した。Rust／Schema／TS／共通fixtureを揃え、ブラウザでタグ待ち→Live復帰を既存の同一mountへ接続した。SDKのTLS対応に伴う推移依存の追加をlockfileへ反映した。Project保存版は変更していない。

- `cargo test --workspace --locked`: 55件成功（model35、runtime単体17、実SDK＋モック3）。
- `cargo clippy --workspace --locked --all-targets -- -D warnings`、`cargo fmt --all --check`: 成功。
- `pnpm check`: 0エラー・0警告。`pnpm test`: 111ファイル・1,220件成功。
- `pnpm build`、`pnpm format:check`: 成功。buildの500kB超chunk警告は残る。
- `pnpm exec playwright test e2e/read-slot-session.spec.ts --workers=1`: 両テーマ2件成功。メイン・埋込・小窓・機器詳細の同一mountで旧値・由来の消去と復帰を確認。
- 初回の認証拒否試験はSDKがshutdownにも終端エラーを返す契約を成功と誤期待して失敗した。拒否の保持を確認する期待へ修正した。ブラウザ試験は追加したUnboundの期待状態を既存disconnectedからunresolvedへ修正し、再実行で成功。アプリの拒否条件・timeout・retryは緩和していない。
- S7環境・実PLC・実Hub・Windows・正式Hostの検証はしていない。独立レビューのエージェントは使用していない。全体CIはPRの最終HEADで確認する。

P1は[全体CI 41225435243](https://github.com/tyaro/temp-scada/actions/runs/41225435243)の全7job成功後、[PR #10](https://github.com/tyaro/temp-scada/pull/10)でマージされた（`b8c2a98ad220ebcbcb86be549293eb5cbf677007`）。P2は下記。P3以降は未実装。

## P2の実施結果（2026-11-01）

[読取Hostの契約](../design/runtime/read-host.md)に従い、`ReadHost`をRustライブラリへ追加した。Textと機器slotの要求を集約し、1つのSDK handleとwatch投影taskを所有する。token照合とresetは同じwatch slotで直列化する。置換／停止の最初のawait前に無値を公開し、取消・dropでも旧通知を新sessionへ流さない。SDKの再接続・再解決は複製していない。

- Rust workspace 68件成功（model35、runtime単体18、Host統合12、SDK投影3）。Clippy `-D warnings`、rustfmt成功。
- Host統合試験は共通名の重複排除と別名の合算、複数context、空要求、同ID／revision、要求集合／接続先の置換、旧socketの終了、取消2段階、catalog待機中のdrop、Quality／切断／Unbound／認証拒否、shutdownエラー保持を含む。
- Tokioは既存workspace依存をdevから通常依存へ移した。新規crate・依存version・SDK rev・Project形式は追加／変更していない。
- TS／画面・正式transportを変更していないため、ローカルのブラウザHost接続試験は実施していない。全体CIの確定結果はP2のPRを参照する。
- Industrial・S7環境へ接続／変更していない。実Hub・実PLC・Windows運用と通常Designerの実データ表示は未検証。

次はP3。Host session変更とフロントsessionのresetの対応、Text／slot両DTOの配布、必要なtransportの責務を明示設計してから接続する。認証延期とローカル編集は維持する。
