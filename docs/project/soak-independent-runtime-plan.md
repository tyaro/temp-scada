# S7 SOAK中のSCADA読取開発計画

2026-11-01（日本時間）。状態: **採用・P1／P2／P3a／P4マージ済み、P5マージ済み、H1マージ済み、H2aマージ済み、H2b1マージ済み、H2b2マージ済み、H2b3マージ済み、H2b4マージ済み、H2c1マージ済み、H2c2マージ済み、H2c3マージ済み、H2c4マージ済み、H2c5復旧状態照会・ローカル検証済み**。ユーザー指示により、IndustrialのS7 SOAK中は上流を変更せず、固定SDKとloopbackのモックHubで開発する。文書作成は実装完了を意味しない。

## 前提と責務

- Industrial基準: [`v0.3.0-alpha.1`](https://github.com/tyaro/banto-industrial/tree/v0.3.0-alpha.1)、commit `33410f6d25d36559c5ce81375e243eb6f3e85038`。Cargoはタグの移動に影響されない完全なrevへ固定する。
- #682の部分Binding解決・`snapshot()`・`Unbound`を使う。接続・再解決・再接続・Stale判定をSCADAに複製しない。
- S7のHub・PLC・DB・設定・資格情報へアクセスしない。上流へのpush、Issue変更、共有crateの切出し、SOAK中のサービス再起動を行わない。
- Project0.35.0とBanto v6.9.0を維持。認証・運用移行・設備操作の接続は従来どおり保留する。
- 2026-11-01の責務整理: Hubは現在値配信と書込み。SCADAサーバは警報評価・ACK・常時Actionと警報／操作イベント。Historianは時系列記録・保持・検索・History API。画面はAPIを介して表示する。
- Historianは論理的に分離する。初期はSCADAサーバと同一プロセスへの同梱を許し、独立サービス化できる境界にする。時系列と警報／操作イベントの記録は別の契約とし、二重記録しない。
- ChronoGazerの`banto-tstore`／`banto-tsquery`とTrend資産は、SCADAの要件に適合する部分を共通利用する。2026-11-01の追加指示により、不足機能へ無理に合わせず新しく設計し、後でChronoGazerへ還元できる境界にする。SOAK中は既存資産の複製やアプリ全体の取込み、上流変更をしない。既存History APIの1時間制限と未実装のヒストリカル画面を、長期間トレンド完成と扱わない。

既存の[統合設計](../design/scada-integrated-design.md)の提供段階を維持する。Historianの責務分離は同設計§6の「History APIはSCADA server側」を詳細化する差分であり、HubへHistory APIを追加する変更ではない。`docs/upstream/industrial`は参照スナップショットのまま変更しない。

## 工程と完了条件

各工程は詳細契約→実装→受入→保存の順に進める。P1から順に着手し、後続の未実装を提供済みと記載しない。

| 工程                  | 内容                                                              | 完了条件                                                                                 | 状態                         |
| --------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------- |
| P1 固定SDKと投影      | rev更新、同一世代snapshot、部分解決、Unbound、値側source          | Rust契約試験、共通DTO fixture、ブラウザのUnbound受入と旧値消去が成功                     | 完了・PR #10マージ済み       |
| P2 読取Host           | Projectごとにhandle1つ。Textと機器slotの要求を集約                | 開始／停止、要求集合変更、接続先変更、旧task通知拒否、空要求の非接続をモックで確認       | 完了・PR #11マージ済み       |
| P3a 表示DTO・session  | 数値Text・Symbol・機器小窓への一括更新                            | 正常／部分未解決／タグ待ち／Bad・Stale／切断／SIMと旧通知拒否を通常Appの同一mountで確認  | 完了・PR #12マージ済み       |
| P3b 製品transport     | Hostと画面の配送経路・接続設定                                    | transportと認証境界を明示設計し、Host sessionと画面deliveryを対応付けて実接続を検証      | 境界設計済み・製品実装は保留 |
| P4 Tag Browser        | catalog表示DTOと既存選択UIの接続準備                              | 検索・型絞込み・明示確定・古い結果の拒否。Projectにcatalog全件・資格情報を保存しない     | 完了・PR #13マージ済み       |
| P5 Historian／Trend   | 共通利用とAPI境界の設計                                           | 下記の未決とSOAK後の上流作業を文書化。共有部品の切出しや履歴サービスの実装完了とはしない | 設計完了・PR #14マージ済み   |
| H1 純粋契約・保存設計 | 版付きSchema／共通fixture／Rust・TS validator、保存方式と復旧契約 | 110 fixtureがRust／TS／ブラウザで一致。DBや永続化保証は追加しない                        | 完了・PR #15マージ済み       |
| H2 保存・検索層       | 新SQLite層を隔離一時DBで実装し障害注入                            | 原子commit・冪等性・snapshot・保持とcoverage・復旧を検証。上流と実環境は変更しない       | H2c10実装済み・運用受入残り  |
| H3a 位相固定recorder  | 単一groupをabsolute deadlineで周期保存                            | 仮想1時間3600枠と実SQLite commit、欠測・停止を検証                                       | PR #31マージ・全体CI成功     |
| H3b 専用SDK入力       | UIと独立した固定SDK ownerから同世代snapshotを取り込む             | mock Hub→SDK→recorder→実SQLite、無値・再接続・identity変更停止を検証                     | PR #32マージ・全体CI成功     |
| H3c 単一group Host    | 一つのwriterと専用SDK入力をblocking workerで実行                  | 開始・停止・取消安全join、差替え、writer所有・Drop／panicを検証                          | PR #33マージ・全体CI成功     |
| H3d 記録と保持の協調  | clean pause後に最大一回の保持操作、明示new-session再開            | guard／job状態・writer所有を保持し、異常時再開を拒否                                     | PR #34マージ・全体CI成功     |
| H4a History読取Host   | 一要求ごとに既存readerでraw／minmax検索                           | 取消安全join、exact token、reader leaseと記録／保持独立を検証                            | PR #35マージ・全体CI成功     |
| H4b1 History表示基盤  | TS要求配送・純粋Trend model・共通renderer                         | raw点／包絡／無値・coverage、取消／旧応答と両テーマをfixture検証                         | ローカル実装・受入済み       |

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
- 共通化と還元: ChronoGazerの保存・検索・描画の依存を調べ、適合部分の共通利用、不足する保存・検索・描画契約の新設と後日還元、SCADA固有widget・Project属性を分ける。既存実装の制限をSCADAの必要要件として固定しない。DBやデータファイルを画面から直接読まない。
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

P1は[全体CI 41225435243](https://github.com/tyaro/temp-scada/actions/runs/41225435243)の全7job成功後、[PR #10](https://github.com/tyaro/temp-scada/pull/10)でマージされた（`b8c2a98ad220ebcbcb86be549293eb5cbf677007`）。P2・P3a・P4は下記。P3bの製品transportとP5の履歴サービスは未実装。

## P2の実施結果（2026-11-01）

[読取Hostの契約](../design/runtime/read-host.md)に従い、`ReadHost`をRustライブラリへ追加した。Textと機器slotの要求を集約し、1つのSDK handleとwatch投影taskを所有する。token照合とresetは同じwatch slotで直列化する。置換／停止の最初のawait前に無値を公開し、取消・dropでも旧通知を新sessionへ流さない。SDKの再接続・再解決は複製していない。

- Rust workspace 68件成功（model35、runtime単体18、Host統合12、SDK投影3）。Clippy `-D warnings`、rustfmt成功。
- Host統合試験は共通名の重複排除と別名の合算、複数context、空要求、同ID／revision、要求集合／接続先の置換、旧socketの終了、取消2段階、catalog待機中のdrop、Quality／切断／Unbound／認証拒否、shutdownエラー保持を含む。
- Tokioは既存workspace依存をdevから通常依存へ移した。新規crate・依存version・SDK rev・Project形式は追加／変更していない。
- TS／画面・正式transportを変更していないため、ローカルのブラウザHost接続試験は実施していない。[全体CI 41229716292](https://github.com/tyaro/temp-scada/actions/runs/41229716292)の全7jobが成功し、[PR #11](https://github.com/tyaro/temp-scada/pull/11)でマージ済み（`19bc275ec48af6c365666813d27f3d5187edb21a`）。
- Industrial・S7環境へ接続／変更していない。実Hub・実PLC・Windows運用と通常Designerの実データ表示は未検証。

次のP3は[表示・配送契約](../design/runtime/read-presentation.md)でP3aとP3bに分ける。認証延期とローカル編集は維持する。

## P3aの実施結果（2026-11-01）

`ReadDisplayStream`が同じHost sessionのText／slotを一つの連番付きDTOへ直列化する。Rust／JSON Schema／TSと共通fixtureを揃え、フロントは両側の整合を検証してから公開する。同名数値タグの状態・値・Quality・由来の不一致、片側破損、世代逆行を拒否する。新しい不正更新は両側の旧値を消し、旧sequenceや旧tokenの通知は無視する。

通常Appに任意の`ReadSource`を渡せるようにし、controllerがProjectとsourceの購読寿命を所有する。主画面・Symbol・埋込・画面小窓・機器詳細・ミニマップへ同じcontextを配る。数値TextにもSIM／由来を表示し、Project保存には入れない。通常entrypointはsourceを渡さず、引き続き未接続で起動する。テストだけでentry moduleへfixture sourceを差し込む。

- Rust workspace71件、Clippy `-D warnings`、rustfmt成功。
- TS単体1,253件、型検査0エラー・0警告、build成功。500kB超chunkの既知警告は残る。
- 通常Appの両テーマでGood／部分未解決／Unbound／Bad／Stale／切断／SIM、同一DOMの継続、Project再読込、source切替・終了・例外、旧通知拒否、保存往復を確認。関連ブラウザ5spec・13件成功。全体CIはPRを参照する。
- [表示・配送契約と実画面](../design/runtime/read-presentation.md)へ受入範囲を記録。SDK rev・Project形式・依存versionは変更していない。
- P3bの製品transport・Hub接続設定・資格情報／認証の受渡しは未実装。実Hub／PLC／S7環境・Windows運用は未検証。P3全体の完了ではない。

P3aは[全体CI 41239680237](https://github.com/tyaro/temp-scada/actions/runs/41239680237)の全7job成功後、[PR #12](https://github.com/tyaro/temp-scada/pull/12)でマージ済み（`389212f91a5baf656a942d4142f1f5dc0b4fc356`）。P3bは[transport・接続設定の境界と再開条件](../design/runtime/transport-boundary.md)を採用し、製品hostの選択・認証・実接続を保留する。P4のcatalog取得・選択準備を独立して進める。

## P4の実施結果（2026-11-01）

[Host catalogとタグ選択](../design/equipment/catalog-selection.md)に従い、`CatalogHost`を追加した。固定SDKのREST取得を明示要求ごとに1回行い、値購読や表示タグの存在を前提にしない。Project・接続先の置換、停止、後続要求で旧結果を拒否する。SDKの重複名検査と表示DTOへの最小化を行い、アドレス・式・値・資格情報を公開しない。

Appの任意`CatalogSource`からsessionに束縛した結果を受け入れ、既存TagPickerを数値Textと機器のnumber／bool slotへ接続した。型不適合・無効タグ・未知型を確定できず、候補変更・切断・対象変更で取消す。入力とProjectへ自動適用せず、明示的に選んだexternalNameだけを未適用入力へ返す。sourceがある場合は取得失敗からサンプルへ切り替えない。通常起動の明示サンプルは維持する。

P4は製品transportを含まない。catalogの取得時点の型確認と現在値の接続成功を区別する。Rustの実SDK＋loopback試験、Rust／Schema／TS共通fixture、両テーマの通常App注入と保存往復で検証する。実Hub・S7・PLC・Windows運用と認証は引き続き保留する。Rust workspace75件、Clippy／fmt、TS1,267件、型検査0エラー・0警告、buildが成功した。関連ブラウザ6spec・21件と、候補上限追加後のTagPicker／catalog10件が成功した。全体CIはPRを参照する。

P4は[全体CI 41241713088](https://github.com/tyaro/temp-scada/actions/runs/41241713088)の全7job成功後、[PR #13](https://github.com/tyaro/temp-scada/pull/13)でマージ済み（`a955b1d06115ba07991d24f65114c64e2ced67f2`）。次はP5のHistorian／Trend共通利用とAPI境界の設計。ユーザー指示によりAstraが主設計を担当する。上流への共有crate／packageの切出し・製品接続はSOAK後の作業として分け、SCADA内で独立する契約fixtureと新設計は先に進められる。

## P5の実施結果（2026-11-01）

ユーザー指定によりAstraが[Historian／Trend契約](../design/runtime/historian-trend-contract.md)と[ChronoGazer共通利用調査](../reviews/chronogazer-historian-reuse.md)を主設計した。固定sourceの機能と不足を照合し、記録設定のdesired／applied、系列identity、周期snapshot記録の保証、時刻とrecordId、Quality／値側source／SIM、半開区間History API、coverage／commit watermark、長期検索、ライブとの接続、障害・保持の分離を具体化した。

既存ChronoGazerにSCADAの必要要件を合わせて削らず、不足する保存・検索層と包絡描画は新設を含めて設計し、後日還元する。既存1時間制限は最初のライブ初期窓の予算であり、長期Historianの最終上限ではない。HubのHistory API追加案や既存NULLからQuality・SIMを復元する方式は採用しない。

- P5は契約設計の完了。アプリ・Rust crate・Project形式・SDK・依存versionを変更していない。履歴サービスと長期Trendの提供完了ではない。
- 固定ソースの静的照合、文書整形、参照リンク、現行実装との境界を確認した。全体Prettier、相対リンク558件、固定sourceの参照先24ファイルと明示anchorの検査が成功した。新しいサービス試験・実Hub／PLC／DB・本番負荷・Windows・停電耐性の試験は行っていない。PRの全体CI結果は確認後にPR本文へ記録する。
- 上流Issue #725／#726への責務整理と共通層の還元はSOAK後の作業へ記録した。今回はread-onlyで、IssueやIndustrialを変更していない。

次は契約のH1（共通fixtureと保存方式の比較・transaction／recovery設計）。SCADA内の純粋な契約とモックを進め、製品transport・認証・実機接続を保留する。H2以降は既存crate拡張と新しい層の両方を比較し、ChronoGazerへの還元を後続工程とする。

## H1の実装（2026-11-01）

P5は[全体CI 41250024135](https://github.com/tyaro/temp-scada/actions/runs/41250024135)の全7job成功後、[PR #14](https://github.com/tyaro/temp-scada/pull/14)でマージ済み（`b49349424365462c21e399fc2fbfd1afa611eb57`）。ユーザーのAstra設計指示を継続し、[版付き契約と共通fixture](../design/runtime/historian-contract-fixtures.md)と[保存方式・復旧契約](../design/runtime/historian-storage-decision.md)をAstraが具体化した。

`scada-historian`の純粋validatorとTSのhistory-contract moduleを追加し、同じcanonical Schemaと110件のfixtureでschema／semantic／acceptedの判定を揃える。query、sampleBatch、raw／minmax結果、coverage、identity、時刻・record ID、commit位置を対象にする。検証はdocument内の整合であり、実commit、真の系列継続、min/maxの元データ一致や全変化記録を保証しない。

保存は新SQLite層・単一DB／writerをH2の暫定案とし、同時刻の非破壊保存、同IDの冪等性、値・metadata・coverage・commit位置の原子性、保持／snapshot／crash回復を設計した。H1はDB接続・保存・recorder・service・UIを追加しない。Project形式・SDK・Banto・既存依存versionを維持する。

次はH2の隔離一時DBによる保存・検索契約の実装と障害注入。上流の共有crate切出し、ChronoGazer移行、製品transport・認証・S7環境への接続は別工程とする。

H1の最終ローカル検証: Rust workspace77件（H1は2 test関数で110 fixtureとJSON整数表記を確認）、Clippy `-D warnings`／rustfmt、TS114ファイル・1,379件、型検査0エラー・0警告、build、Chromiumで共通110 fixtureを確認するPlaywright1件が成功。buildの既知chunkサイズ警告は残る。全体CIはPRで確認し、H2のDB試験と読み替えない。

## H2aの実装と残り（2026-11-01）

H1は[全体CI 41255744026](https://github.com/tyaro/temp-scada/actions/runs/41255744026)の全7job成功後、[PR #15](https://github.com/tyaro/temp-scada/pull/15)でマージ済み（`3ae2675e2054928f93911b833ebd64f7dc06f5e3`）。Astraが[H2aの詳細契約](../design/runtime/historian-atomic-store.md)を主設計し、H2を次の区切りへ具体化した。

| 区切り               | 内容と受入                                                                                                                                                                       | 状態                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| H2a 原子append       | 同周期の固定session全memberを1tickで保存。identity・source世代・型付き値・receipt・sequenceの原子性、冪等再送、プロセス排他、終了後の再送、途中終了後のinterruptedを一時DBで確認 | 完了・PR #16マージ済み   |
| H2b 検索snapshot     | 同一snapshotからmetadata・raw／minmax・coverage・watermarkを投影しH1へ適合。未記録／中断の説明、検索の仕事量・取消・資源寿命を検証                                               | H2c5実装済み・後続未着手 |
| H2c 保持・容量・復旧 | expired根拠と削除の原子性、再送での復活防止、異常時刻、容量・WAL・checkpoint、障害回復の残りを検証                                                                               | H2c5実装済み・後続未着手 |

H2aは専用directoryへ固定DBとwriter lockを作る同期ライブラリで、通常Appからは呼ばない。既存directoryを初期化せず、既存format／store・deployment IDを照合する。query・retention・常時recorderや製品transportへ同時接続しない。全memberの観測（無値理由も含む）が揃った連続tickだけをcommitし、入力watermarkは受け取らない。未終了sessionは再openでinterruptedにするが、失われた時刻・件数やcoverageを捏造しない。

検証: Rust workspace96件（H2a19 test関数、child worker含む）、Clippy `-D warnings`、rustfmt成功。SQLiteの途中4境界で子プロセスを終了すると未commit tick全体が消え、COMMIT直後の終了では同payload再送が同じreceiptを返す。SQL失敗後は再openまで追加writeを拒否する。source世代u64の2^53境界・最大値、型付き0／false、同時刻別record、時計逆行、同Hub世代混在拒否、別Hub世代差、symlink拒否・2プロセス排他も確認。H1の110 fixtureを維持した。画面変更がないため新しいブラウザ試験は追加しない。全体CIはPRで確認する。

SQLite依存追加は別commitで確認し、rusqlite 0.41.1のbundled build（既定feature無効、libsqlite3-sys 0.39.1）を固定した。既存crate version・固定SDK・Project0.35.0・Banto6.9.0を維持し、上流・S7・実DB／設定へアクセスしていない。媒体故障・電源断・Windows実機、queryとの競合やretentionはH2aのprocess終了試験では未検証。

## H2b1の実装と残り（2026-11-01）

H2aは[PR #16](https://github.com/tyaro/temp-scada/pull/16)でマージ済み（`45105ab0c95d6d0482f7f99c738b46e49eab89cc`）、[全体CI 41264959997](https://github.com/tyaro/temp-scada/actions/runs/41264959997)全7job成功。Astraが[H2b1](../design/runtime/historian-query-snapshot.md)を主設計し、保存コアと別のREAD_ONLY接続でraw検索を実装した。最初のstore_meta読取でsnapshotを固定し、全系列のdescriptor・raw・watermarkを同じtransactionから返す。

H2aには時刻付き計画、停止／保持削除や未commitキューの永続根拠がないため、要求全域をunknownCoverageとする。保存点や無値理由はそのまま返すが、unrecorded／expired／pendingFlush／recorderStopped等の区間を推測で作らない。minmaxは空binのsegment根拠も必要になるためH2b2に分離し、UnsupportedModeと明示する。

| 区切り               | 内容と受入                                                                                                                                  | 状態                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| H2b1 raw検索         | snapshot内で型・metadata・安定順・直近commitを維持。2reader上限、VM／decode／bytes／期限と取消・終了までの資源所有。SQLite出力の共有fixture | 完了・PR #17マージ済み       |
| H2b2 minmax          | 共通grid、count・包絡、型／source／clockEpoch混在、空binに適用できるmetadataの根拠を設計・試験                                              | 完了・PR #18マージ済み       |
| 確定coverage         | 時刻付き計画と停止・中断・未commit等の根拠を永続化し、raw／binと矛盾しないcoverageを生成。現unknownCoverageからの移行を明示                 | H2b3証拠保存済み・投影未着手 |
| H2c 保持・容量・復旧 | expired根拠と削除の原子性、復活防止、異常時刻、容量・WAL・checkpoint、障害回復の残り                                                        | H2c5実装済み・後続未着手     |

ローカル検証: Rust workspace112件、Clippy `-D warnings`／rustfmt、TS114ファイル・1,383件、型検査0エラー・0警告、build、関連Chromium2件が成功。新しい15単体試験でsnapshot中のappend／session切替、未commit非公開、同時刻・時計逆行、metadataと点数上限、VM／行／bytes、取消・deadline、cleanup失敗とpanic、2readerとwriter lock寿命を確認した。実SQLite出力4ケースをRustの1統合test関数とTS／ブラウザで共有し、H1の110 fixtureも維持する。buildの既知chunkサイズ警告は残る。全体CIはPRで確認する。

rusqliteは既存0.41.1へhooksを追加し、snapshot ID用に既存lockのuuid 1.28.0をv4で直接利用する。新しいpackage／依存versionは追加せず、固定SDK・DB format 1・H1 JSON v1・Project0.35.0・Banto6.9.0を維持。上流・実環境・通常Appへの接続はない。VM予算は保守的な計上であり、OS I/Oの厳密な時間制限や実運用規模の性能・容量を保証するものではない。

## H2b2の実装と残り（2026-11-01）

H2b1は[PR #17](https://github.com/tyaro/temp-scada/pull/17)でマージ済み（`3113b51c8a8a49da018f1a18de00b182ae5a10aa`）、[全体CI 41267109291](https://github.com/tyaro/temp-scada/actions/runs/41267109291)全7job成功。Astraが[H2b2の共通grid・集約契約](../design/runtime/historian-minmax-query.md)を主設計し、SQL側でminmaxを実装した。H2b1のsnapshot・metadata・watermark・取消・有限予算・cleanupを共有する。

bin数はmin（要求点数、期間ms）、境界はfrom＋floor（index×期間／bin数）とし、SQLも同じ整数境界へ割り当てる。number・boolの有効値と正しい無値recordを数え、破損はCorruptDataとして拒否する。segment・session＋clockEpoch・非null source世代が混ざったbinは包絡を返さない。空binは唯一のdescriptorだけを使え、複数descriptorならMetadataAmbiguousで全要求を失敗させる。保存点から連続性を証明せず、全域unknownCoverage／partial／gap／mixedSegmentを返す。

検証: Rust workspace126件、Clippy `-D warnings`／rustfmt、TS114ファイル・1,389件、型検査0エラー・0警告、build、関連Chromium3件が成功。単体13件を追加し、9,001tickのSQL集約をdecode上限20行で確認。負のUTC・safe整数端点・非整数割のgrid・同timestamp・短い山・bool両状態・無値・世代混在・metadata曖昧・破損・集約SQL処理中の取消を試験した。H1 accepted sampleBatchの各sampleも保存・集約し、SQLの理由規則と一致を確認した。

`examples/history-minmax-cases.json`の6成功result＋1失敗を実SQLiteで照合し、成功resultはTS／実ブラウザでも同じH1契約として受理した。H1の110 fixture、raw出力4ケースを維持する。Astraレビューで見つかったSQLiteのNUL文字検査の落とし穴を回帰試験で再現し、修正後の拒否を確認。既知build chunk警告は残る。全体CIの確定結果はPRへ記録する。

依存・SDK・DB format 1・H1 JSON v1・Project0.35.0・Banto6.9.0は変更していない。通常App・描画・History API・上流・実環境は未接続。次は時刻付き計画と停止／中断等の根拠を保存し、unknownCoverageを確定coverageへ置き換えられる契約を具体化する。H2cの保持・容量・WAL／checkpoint・復旧、常時recorderは後続であり、H2全体の完了ではない。

## H2b3の実装と残り（2026-11-01）

H2b2は[PR #18](https://github.com/tyaro/temp-scada/pull/18)でマージ済み（`bd24c5d29db74c2eb59b8c8af24bf1634ab3026b`）、[全体CI 41270705728](https://github.com/tyaro/temp-scada/actions/runs/41270705728)全7job成功。Astraが[時刻付き記録計画・欠測証拠](../design/runtime/historian-recording-evidence.md)を主設計し、H2b3は証拠保存までとした。公開queryのunknownCoverageを証拠なしに取り除かない。

- 同じplan ID／revisionへ固定memberのcanonical snapshotを一度だけ保存し、異なる内容への再利用を拒否する。sessionと開始根拠は同transactionへ保存する。
- timed sessionは単一clockEpochに束縛し、tick・gap・closeの観測frontierを後退させない。同timestampのtickは許す。逆行やepoch変更では旧sessionを時刻なしinterruptとし、新sessionを始める。
- gapはactiveなtimed sessionの全memberを対象とする半開区間で、samplingMissed／storageLossのみ。既存Good／無値record、別gapとの重複を拒否し、再送は同ID同payloadのみ同receipt。gapでsequence／committedThroughを進めない。
- 正常closeのexclusive境界は最後のtickより後で、frontier以後に限る。interrupt／再openで終了時刻を推測しない。時刻根拠なしAPIからの後付けや根拠省略を拒否する。

DB format 2へ明示更新し、format 1をsilent migrationしない。新規一時DBだけを作り、旧版・版不一致は非変更で拒否する。依存・SDK・H1 JSON v1・Project0.35.0・Banto6.9.0は維持する。通常App、上流・S7・実環境DB／設定への接続・変更はない。

ローカル検証: Rust workspace140件、Clippy `-D warnings`／rustfmt、関連Chromium3件が成功。新規14 test関数（child worker含む）でplan不変性、再送と終了後照会、時刻逆行／epoch、gapとrecordの双方向矛盾防止、隣接・半開端点、別domainの同UTC、safe整数端点、SQL失敗の全rollback／NeedsReopen、COMMIT前後7箇所のprocess終了、旧DB非変更を確認。既存H1／raw／minmax fixtureを維持した。画面・TS実装は変更していない。全体CIはPRで確認する。

次はcoverage投影。保存した局所gapをseries全域の欠測へ直結せず、全session／clock domain・raw／bin・計画と同じsnapshotで照合し、根拠のない部分はunknownCoverageとして残す。その後H2cでexpiredと削除の原子性・復活防止・異常時刻・容量／WAL／checkpoint・復旧を進める。H2全体・常時recorder・製品History API・UI接続は未完了。

## H2b4の実装と残り（2026-11-01）

H2b3は[PR #19](https://github.com/tyaro/temp-scada/pull/19)でマージ済み（`b804257ac4f655aeab25bb50a1f0233245ca3af8`）、[全体CI 41272492900](https://github.com/tyaro/temp-scada/actions/runs/41272492900)全7job成功。Astra主設計の[coverage投影](../design/runtime/historian-coverage-projection.md)を実装した。以下が今回の採用範囲である。

- raw／minmaxと同一snapshotでsession・plan・gapを検証し、他domainが記録し得る期間を除外して明示samplingMissed／storageLossを公開する。終了不明sessionをfrontierで切らず、untimedがあれば全域unknownCoverageとする。
- session最大256／候補gap1024と最終coverage256の超過をtyped errorで拒否する。参照欠落・plan／永久descriptor不一致・残存欠測内のGood／無値recordを破損として拒否する。
- Rust155件、TS1,395件、型検査・build・Clippy／rustfmt、関連Chromium4件が成功。6共有fixture、snapshot競合、safe整数端点、上限、破損・取消とcleanupを確認し、Astraの再レビューを完了した。全体CIはPRで確認する。

DB format 2・H1 JSON v1・依存・SDK・Project・Bantoは維持。停止・expired・pendingFlushや全変化記録を推測しない。通常App・上流・S7・実環境への接続はない。次はH2cの保持削除とexpired根拠の原子性・再送による復活防止・異常時刻・容量／WAL／checkpoint・障害復旧を詳細設計する。H2全体、常時recorder、製品History APIとTrend画面は未完了。

## H2c1の実装と残り（2026-11-01）

H2b4は[PR #20](https://github.com/tyaro/temp-scada/pull/20)でマージ済み（`b7ee2a078357ca00000188f8845417d4e90c4754`）、[全体CI 41277217468](https://github.com/tyaro/temp-scada/actions/runs/41277217468)全7job成功。Astra主設計の[保持・容量の段階契約](../design/runtime/historian-retention.md)に従い、H2c1は記録session停止中の明示UTC cutoffによる原子trimとqueryのexpiredまでを実装した。

- CAS付き単調cutoff、最大1024 tickの全member除去、実削除ledger、安定receiptとcounterを同transactionへ保存する。対象上限超過は無変更、cutoff上のrecordは残す。
- 元receiptを優先し、古いtickの再送で復活させない。未保存の期限前tickは拒否し、sequence／frontier・欠測証拠を偽装しない。
- raw／minmaxへ実削除timestampの`[t,t+1)`だけを同snapshotからexpiredとして投影する。既存のsamplingMissed／storageLoss／unknownを最終overlayし、最終256区間で制限する。
- format 3へ明示更新し、旧format 1／2は自動migrationしない。依存・SDK・H1 JSON v1・Project・Bantoは維持。通常App・上流・S7・実環境には接続しない。

ローカル検証はRust174件・TS1,401件・型検査・build・Clippy／rustfmt・関連Chromium5件が成功。6共有fixture、snapshot競合、境界・上限、同時刻／無値、破損、予算・取消・panic cleanup、COMMIT前後5境界のprocess終了と再送を確認した。Astra最終レビューに必須修正はない。全体CIはPRで確認する。

再送比較用のcommits本文に値は残り、今回のtrimは物理消去・容量危機の解決ではない。次は自動保持と信頼できる時刻／前進量の検査、active recorderとの協調、大量削除の進行管理、receipt／metadata GC、容量・WAL／checkpoint・disk-full・復旧を段階設計する。H2c全体・常時recorder・製品History API・Trend画面は未完了。

## H2c2の実装と残り（2026-11-01）

H2c1は[PR #21](https://github.com/tyaro/temp-scada/pull/21)でマージ済み（`5fe91b593d44e725b4749063c105041844a8eb37`）、[全体CI 41282390503](https://github.com/tyaro/temp-scada/actions/runs/41282390503)全7job成功。Astra主設計の[容量診断と明示PASSIVE checkpoint](../design/runtime/historian-maintenance.md)をRust libraryへ追加した。製品の保持日数・timezone・信頼時計を仮定せず、容量を観測しreader snapshotとの共存を検証する区切りとした。

- SQL snapshotのpage数と空きpage、実DB/WAL file長の別sample、idleを含むlease数を返す。volumeの空き容量とは区別する。
- 明示PASSIVEは1回だけで、busy=0のIncompleteも保持する。WAL物理長64 MiB超ではSQL前に拒否し、診断は可能。内部I/O時間の硬上限や物理縮小は保証しない。
- shared cleanup guardはretentionと共用し、取消解除→rollback、cleanup失敗時のpanic中の直接poisonを維持する。DB format 3・H1・依存・SDK・Project・Bantoは変更しない。

Rust190件、Clippy／rustfmt、関連Chromium5件が成功。reader pin中の旧query保持と解放後Complete、trim後のfree page、64 MiB境界、SQL/FS測定の差、main/WAL参照、取消・SQL failure・panic、checkpoint前後のprocess終了後のreceipt／raw／expiredを確認した。Astra最終レビューに必須修正はない。全体CIはPRで確認する。TS・通常App・実環境は未変更。

自動保持と時刻異常検査、active recorderとの協調、大量削除の進行、receipt／metadata GC、空き容量・disk-full・物理保守の運用は後続。H2c2はH2全体、常時recorder、History APIやTrend画面の完成ではない。

## H2c3の実装と残り（2026-11-01）

H2c2は[PR #22](https://github.com/tyaro/temp-scada/pull/22)でマージ済み（`1295c7c0bcdb2e4d97d43cd449cbb91ac1165411`）、[全体CI 41284638650](https://github.com/tyaro/temp-scada/actions/runs/41284638650)全7job成功。Astra主設計の[SQLite容量不足と原子的復旧](../design/runtime/historian-write-failure-recovery.md)を隔離DBだけで検証した。

- max_page_countによる実FULLで、通常append・全member／epoch・timed begin／plan・gap・close・trim各段階を検証する。TEMP triggerの圧力注入と通常appendの自然増大は区別する。
- FULLと取消が併発した際のControlへの誤変換を修正し、primary OperationInterruptedだけをControlへ変換する。FULLの元原因とNeedsReopenを維持する。
- 容量回復後の再openは旧activeをinterruptedにする。既commit receiptは再取得でき、未保存tick／gapを旧sessionで再開しない。未commit begin／trimは既存の同ID契約で再試行する。

Rust199件、Clippy／rustfmt、関連Chromium5件が成功。reader raw／minmax、counter／frontier／epoch／expired／fenceの一貫性を確認し、Astra最終レビューを完了した。全体CIはPRで確認する。DB format 3・H1・依存・SDK・Project・Banto・TS／通常Appは変更しない。

実filesystemのENOSPC・WAL／checkpoint容量・I/O・媒体／電源断は未検証。自動保持の設定・信頼時刻・active recorder協調・大量削除進行・receipt GC・物理保守とともに後続へ残す。H2c全体／recorder／History API・Trend画面の完成とはしない。

## H2c4の実装と残り（2026-11-01）

H2c3は[PR #23](https://github.com/tyaro/temp-scada/pull/23)でマージ済み（`9fb2baa14c703f95fe36170348c386097b049ebe`）、[全体CI 41285704832](https://github.com/tyaro/temp-scada/actions/runs/41285704832)全7job成功。Astra主設計の[永続保持job](../design/runtime/historian-retention-jobs.md)を実装し、単発trimでは進められない同timestamp1025 tick超の削除を、小さいstepと再open後の継続で扱う。

- job開始／連番step／状態照会と安定receiptを永続化する。max_ticksは1〜1024で、VM／行数／bytesが先に尽きる場合は小さく指定する。
- job中は新規記録と単発trimを止め、既存receipt／query／診断を許す。今回触れたseries／timestampだけをstagingし、rawが残る間はexpiredを公開しない。
- stepの原子commit、対象とpendingの消滅を条件とする完了fence、同step再送と故障後再openを検証する。job途中をcancelで解放するAPIは追加しない。
- queryは両sourceの参照・件数をSQLで検証し連続timestampをisland化する。1024入力点制限をSQL集約に置き換え、最大256 expired islandと最終coverage256区間／有限SQL仕事量を維持する。

format 4へ明示更新、旧format 1／2／3は非変更拒否。H1・依存・SDK・Project・Bantoは維持。Rust219件・TS1,407件・型検査・build・Clippy／rustfmt・関連Chromium6件が成功。6共有fixture、1025集中／連続、部分公開、FULL・process5境界・予算／取消／panic、snapshot競合と破損参照を確認し、Astra最終レビューを完了した。全体CIはPRで確認する。

自動保持の設定・timezone・信頼時刻、active recorderの停止／再開調停、receipt／metadata GC、実媒体の容量／I/Oと物理縮小は後続。H2全体・常時recorder・History API／Trend画面の完成とはしない。

## H2c5の実装と残り（2026-11-01）

H2c4は[PR #24](https://github.com/tyaro/temp-scada/pull/24)でマージ済み（`4bd75d08d22880d8e30eace537df7fd84bcb3677`）、[全体CI 41289139590](https://github.com/tyaro/temp-scada/actions/runs/41289139590)全7job成功。Astra主設計の[復旧状態照会](../design/runtime/historian-recovery-state.md)で、job IDを失った再起動後も未完了jobと再送情報を発見できるようにした。

- recovery_stateは最初のlast_commit readでsnapshotを固定し、fenceの出典・active session・active job・直近request／receiptを副作用なく返す。
- 出典と最新step、宣言headと実MAX step、active session sequenceとreceiptを検証し、欠落・同率重複・記録と保持の併存を拒否する。未検証のNoneへ落とさない。
- 返却値で新jobや削除を自動開始せず、既存APIの明示再送と次stepへ使う。返却後の変更には従来のCAS／連番／canonical照合が働く。

Rust234件・Clippy／rustfmt・関連Chromium6件が成功。process begin／partial／complete後の発見、元request再送とstale値、同snapshot、読取専用性、破損・予算／取消・SQL failure・panic cleanupを確認し、Astra最終レビューを完了した。全体CIはPRで確認する。DB format 4・H1・依存・SDK・Project・Banto・TS／通常Appは維持する。

自動保持設定・timezone・信頼時計・recorder調停・receipt GC・実媒体容量／I/O・物理縮小は後続。H2全体・常時recorder・History API／Trend画面は未完了である。

## H2c6の実装と残り（2026-11-01）

H2c5は[PR #25](https://github.com/tyaro/temp-scada/pull/25)でマージ済み（`34bf723b2f24697b3b51da438397abe3fbaf2145`）、[全体CI 41290868079](https://github.com/tyaro/temp-scada/actions/runs/41290868079)成功。Astra主設計の[明示保持候補の時刻安全判定](../design/runtime/historian-retention-clock-guard.md)をRust libraryへ実装した。

- callerがpolicy・trusted clock sample・cutoff・recoveryを与える純粋関数で、初回warmup後の安定sampleから候補を判定する。
- 時計異常・policy変更・sample形式不正は明示rearmまで停止を保持する。未来候補、前進上限、初回ceilingを検査し、既存job／記録停止待ちを返す。
- proposalだけでは書き込まず、実行時には既存begin APIのCAS／Busy検査が働く。古い提案で新fence・記録・別jobを迂回しない。

Rust256件（新規22単体、うち隔離DB統合4件）・Clippy／rustfmt・関連Chromium6件が成功。Astra実装レビューの累積件数検査を補強し、最終レビューに必須修正はない。全体CIはPRで確認する。DB format 4・H1・依存・SDK・Project・Banto・TS／通常Appは維持する。

trustedの根拠となる時計adapter、timezone／保持日数と製品policy管理、実行host・recorder停止／再開、receipt GC・実媒体保守は後続。二つの安定sampleは絶対時刻の正しさを証明せず、proposalは実行権限やleaseではない。通常App・上流・S7・実環境へ接続していない。

## H2c7の実装と残り（2026-11-01）

H2c6は[PR #26](https://github.com/tyaro/temp-scada/pull/26)でマージ済み（`7a8b5ee8cb8bfa7948289707b85bea9dc0da2530`）、[全体CI 41292835540](https://github.com/tyaro/temp-scada/actions/runs/41292835540)成功。Astra主設計の[一回分の保持coordinator](../design/runtime/historian-retention-coordinator.md)で、復旧照会・時刻判定と明示操作を接続した。

- Observe／Begin／ContinueExistingを区別し、最大一操作だけを実行する。job ID・step番号・cutoffを自動生成・補正しない。
- DB実行が取消・競合・容量不足で失敗しても、評価済みの時計停止状態と復旧snapshotをreportへ残す。InvalidInputではrearm_requiredと操作停止を返す。
- 正確な部分step再送は追加削除せず、完了済みjobのreceipt取得は従来APIを使う。sessionを勝手に終了・再開しない。

Rust272件（新規16単体）・Clippy／rustfmt・関連Chromium6件が成功。Astra実装レビューに必須修正はない。全体CIはPRで確認する。DB format 4・H1・依存・SDK・Project・Banto・TS／通常Appは維持する。deadline／tokenは共通、各APIの予算カウンタは独立で最悪二回分に限定する。

製品policy・timezone／保持日数・信頼時計adapter、scheduler・recorder協調、receipt GC・実媒体保守は後続。H2全体や自動運転、常時recorder、製品History API／Trend画面の完成とはしない。上流・S7・実環境には接続していない。

## H2c8の実装と残り（2026-11-01）

H2c7は[PR #27](https://github.com/tyaro/temp-scada/pull/27)でマージ済み（`4fe56db877c3f43197d24df50c313a8225a907bc`）、[全体CI 41294166759](https://github.com/tyaro/temp-scada/actions/runs/41294166759)成功。Astra主設計の[明示duration policy](../design/runtime/historian-retention-duration.md)をguard／coordinatorへ接続した。

- 明示elapsed msから同呼出しsampleのUTC cutoffを計算する。24hを暦日保持へ読み替えず、暗黙default・丸め・clampを持たない。
- 必須CutoffRuleを全policy snapshotへ含め、同revisionのduration／mode変更も停止する。Explicit Some／Elapsed Noneを厳密検査する。
- malformed時計の停止理由を維持し、安定sampleからの導出不能はCutoffComputationFailedへ保持する。既存jobの固定cutoffと最大一操作を維持する。

Rust284件（新規12単体、DB統合5件）・Clippy／rustfmt・関連Chromium6件が成功。cutoff前だけを削除して同値／後を残し、実削除のexpiredを確認した。Astra実装レビューに必須修正はない。全体CIはPRで確認する。DB format 4・H1・依存・SDK・Project・Banto・TS／通常Appは維持、Rust policy／candidate入力のみ明示変更した。

ローカル暦日／timezone、製品policy適用／短縮プレビュー、信頼時計adapter、scheduler／recorder協調、receipt GC・実媒体保守は後続。H2全体・自動運転・常時recorder・製品History API／Trend画面は未完了。上流・S7・実環境には接続していない。

## H2c9の実装と残り（2026-11-01）

H2c8は[PR #28](https://github.com/tyaro/temp-scada/pull/28)でマージ済み（`89c46c75486f3601cc0fd5603d239d17f2cd3feb`）、[全体CI 41295809874](https://github.com/tyaro/temp-scada/actions/runs/41295809874)成功。Astra主設計の[保持変更の実データ影響preview](../design/runtime/historian-retention-preview.md)を実装した。

- 同referenceの提案／任意比較policyを計算し、同snapshotの残存tick／observation／seriesと追加／対象外化の半開区間・件数を返す。
- 固定member全体の構造・参照を検査し、SQL内で集約する。無値／同timestamp別tickを含み、deleted／pendingを再計上しない。
- active session／jobを同snapshotの復旧情報へ添える。previewはreadonlyで、比較policyを永続appliedや実行tokenとして扱わない。

Rust298件（新規14単体）・Clippy／rustfmt・関連Chromium6件が成功。snapshot競合・破損／NUL・1025tick・有限予算・取消／panic／cleanupを確認し、Astra最終レビューに必須修正はない。全体CIはPRで確認する。DB format 4・H1・依存・SDK・Project・Banto・TS／通常Appは維持する。

policy永続適用と期待revision、製品管理口、ローカル暦日／timezone、信頼時計、scheduler／recorder協調、receipt GC・実媒体保守は後続。previewは全JSON監査や後続削除の成功保証ではない。上流・S7・実環境には接続していない。

## H2c10の実装と残り（2026-11-01）

H2c9は[PR #29](https://github.com/tyaro/temp-scada/pull/29)でマージ済み（`d5e55fd6219b57fc11a6c64f47e35eaccd2b31d2`）、[全体CI 41297414808](https://github.com/tyaro/temp-scada/actions/runs/41297414808)成功。Astra主設計の[保持policy原子適用](../design/runtime/historian-retention-policy-application.md)を実装した。

- 実applied比較previewとrevision／snapshot CAS、同transactionのfresh previewから、immutable定義・安定receipt・current pointerを原子適用する。再送では後日のrawを再集計しない。
- 記録中のmetadata適用は許可し、active job中の新適用は拒否する。適用だけでは削除・job開始・fence変更・guard rearmを行わない。
- coordinator新Beginは実applied全文一致を必須とし、開始transactionで再照合する。jobの適用世代を列とcanonical payloadへ保存する。既存job継続／再送と直接保守APIは維持する。

DB format 5へ更新、旧1〜4は非変更拒否で自動移行しない。H1・依存・SDK・Project・Banto・TS／通常Appは維持する。Rust314件（新規16単体、child worker含む）・Clippy／rustfmt・関連Chromium6件が成功。CAS・raw削除後再送・race・実FULL・取消／panic・SQLpoison・process5境界・破損を確認し、Astra最終レビューに必須修正はない。全体CIはPRで確認する。

製品desired配布／管理認証、ローカル暦日／timezone、信頼時計adapter、scheduler／recorder、receipt GC・実媒体保守は後続。H2全体や自動運転・常時recorder・製品History API／Trend画面の完成とはしない。上流・S7・実環境には接続していない。

## H3aの実装と残り（2026-11-01）

H2c10は[PR #30](https://github.com/tyaro/temp-scada/pull/30)でマージ済み（`5c9fa8445c7d81877ad67247457beca53bfcc097`）、[全体CI 41300113647](https://github.com/tyaro/temp-scada/actions/runs/41300113647)成功。S7の周期誤差累積による時間当たり点数不足の経験を受け、Astra主設計の[位相固定recorder](../design/runtime/historian-periodic-recorder.md)を実装した。

- monotonic anchor＋n×periodの絶対deadlineを守り、mock latest sourceから実SQLiteへ周期保存する。capture後の実UTCと予定slot／sourceTimeを分離する。
- 過去slotを最新値で埋めず、missed件数と安全な観測間samplingMissedを残す。gapとtickは別commitで、その境界の失敗をreportへ保持する。
- 仮想1時間ではwake／capture／処理相当時間を加えても3600予定・3600観測・各系列3600点保存・missed0。相対sleepの対照モデルでは点数不足を再現する。

Rust330件（新規16単体）・Clippy／rustfmt・関連Chromium6件が成功。時計／source異常、horizon、取消、gap後実FULLとcleanup失敗を確認し、Astra最終レビューに必須修正はない。全体CIはPRで確認する。DB format 5・H1・依存・固定SDK・Project・Banto・TS／通常Appは維持する。

専用SDK購読、計画配布・複数group／queue、永続slot台帳、保持との停止再開、製品History／Trend・正式hostは後続。H2の媒体I/O運用受入も残る。仮想試験を実S7の精度測定や任意UTC正時の常時3600実測保証とは扱わず、上流・S7・実環境には接続していない。

## H3bの実装と残り（2026-11-01）

H3aは[PR #31](https://github.com/tyaro/temp-scada/pull/31)でマージ済み（`41d5a2872294cd168d35a2eb77e8af40bd885b42`）、[全体CI 41302448259](https://github.com/tyaro/temp-scada/actions/runs/41302448259)成功。Astra主設計の[専用SDK入力](../design/runtime/historian-sdk-source.md)を実装した。

- UIと別にSDK handleを所有し、capture時に一度取得した同世代snapshotだけをH3aへ渡す。表示DTOや画面の購読需要へ依存しない。
- 固定groupと選択時pinを検査し、一時切断はsourceUnavailable、未解決はunresolvedとする。catalog／run／identity／source変更はsticky停止し、旧値で継続しない。
- mock Hub→固定SDK→spawn_blocking上のrecorder→実SQLite→raw／minmaxを接続し、epochを含むexact replay、UI寿命の双方向独立と停止結果を検証した。

Rust347件（新規8単体・9統合）・Clippy／rustfmt・関連Chromium6件が成功。Astra最終レビューに必須修正はない。全体CIはPRで確認する。DB format 5・H1・外部依存・SDK・Project・Banto・通常Appを維持し、workspace依存だけをruntime→historianへ追加した。

次は記録計画の配布・複数group／queue、保持協調と時計domain再開、製品History／Trendへの接続。catalog変更時の安全な再承認・segment遷移、永続slot台帳、正式host、実媒体I/O・receipt GC・暦日timezoneも残る。SDKのlatest取得やREST由来sourceの限界を維持し、全通知・実S7で異なる実測3600件を保証しない。上流・S7・実環境への接続はない。

## H3cの実装と残り（2026-11-01）

H3bは[PR #32](https://github.com/tyaro/temp-scada/pull/32)でマージ済み（`7a7e45cb74de93f078a669f52189ad1ed0635969`）、[全体CI 41304864071](https://github.com/tyaro/temp-scada/actions/runs/41304864071)成功。Astra主設計の[単一group Host](../design/runtime/historian-recording-host.md)を実装した。

- SDK executorと同期記録workerを分離し、明示start／request_stop／join／take_storeで一つのwriterを管理する。周期計算はH3aへ委ね、反復末尾に相対sleepを追加しない。
- 未joinならBusyを維持し、join取消・timeoutでもhandle／writerを失わない。新sessionの開始は旧workerのjoin後だけにする。
- bounded latest statusと詳細completionを分ける。Dropは取消要求であり、workerが持つlockを即時解放・正常joinしたとは扱わない。panicはFaultedで外側の明示復旧へ返す。

Rust360件（新規6単体・7統合）・Clippy／rustfmt・関連Chromium6件が成功。共有mock Hub→Host→実SQLite・raw、SDK稼働、差替え・取消・開始失敗・終了失敗・Drop／panicを検証し、Astra最終レビューに必須修正はない。全体CIはPRで確認する。

次は保持との停止／再開協調と時計domain再確認、製品計画の配布・複数group／queue、History／共通Trendへの接続。単一active session制約、永続slot台帳、実媒体I/O／receipt GC・暦日timezoneは残る。DB format 5・H1・外部依存・固定SDK・Project・Banto・通常Appを維持し、上流・S7・実環境へ接続していない。

## H3dの実装と残り（2026-11-01）

H3cは[PR #33](https://github.com/tyaro/temp-scada/pull/33)でマージ済み（`12ba61ae67ae36f904504329a8266c00dcce8161`）、[全体CI 41307592962](https://github.com/tyaro/temp-scada/actions/runs/41307592962)成功。Astra主設計の[記録pauseと保持協調](../design/runtime/historian-recording-retention.md)を実装した。

- 正常ClosedとSDK shutdown／worker joinを確認後、Host内のwriterで最大一回の既存coordinatorを実行する。job ID・次step・保持cutoffを勝手に補正／採番しない。
- Hostがguardと停止状態を持ち、保持join取消でもnext_state／writerを失わない。Err／Suspendedは明示rearmまで残し、job未完了／不明は別に再開を拒否する。
- 実appliedのBegin、分割step／exact再送、非信頼時計での既存job完了、rearm／fresh Observe、新session・直前と異なるepochの再開を検証する。旧／新UTCの間に欠測を捏造しない。

Rust372件（新規7単体・5統合）・Clippy／rustfmt・関連Chromium6件が成功し、Astra最終レビューに必須修正はない。全体CIはPRで確認する。DB format 5・H1・外部依存・SDK・Project・Banto・通常Appは維持する。

製品計画配布・永続CAS、複数group／queue、History／共通Trend、保持schedulerと信頼時計adapter、実媒体I/O・receipt GC・暦日timezoneは残る。単一active sessionの制約や任意UTC正時の別実測3600点保証は変更せず、上流・S7・実環境へ接続していない。

## H4aの実装と残り（2026-11-02）

H3dは[PR #34](https://github.com/tyaro/temp-scada/pull/34)でマージ済み（`38551495fd67680a639f3e5b848d4921530ab6ea`）、[全体CI 41309473589](https://github.com/tyaro/temp-scada/actions/runs/41309473589)成功。Astra主設計の[非同期History読取Host](../design/runtime/historian-history-host.md)を実装した。

- 一つの発行済みHistoryReaderでraw／minmaxを一要求ずつ実行し、SQL処理をasync executorから分離する。最大2readerの既存上限と有限QueryControlを維持する。
- opaque token、取消安全join、未join Busy、ReaderUnusableの再利用拒否を設ける。新queryで旧要求を上書きせず、保存済み結果を取消で書き換えない。
- 記録中query→clean pause保持job→同readerでexpiredという経路と、過去結果の不変性・reader処分までのownershipを検証した。

Rust384件（新規7単体・5統合）・Clippy／rustfmt・関連Chromium6件が成功し、Astra最終レビューに必須修正はない。全体CIはPRで確認する。DB format 5・H1・依存バージョン・SDK・Project・Banto・通常Appは維持し、serde_jsonだけをruntime通常依存へ移した。

画面側の要求／応答配送と共通Trendを次に接続する。製品transport／認証、計画配布・永続CAS、複数group／queue、自動保持・信頼時計adapter、実媒体I/O／GC／timezoneは残る。上流・S7・実環境へ接続していない。

## H4b1の実装と残り（2026-11-02）

H4aは[PR #35](https://github.com/tyaro/temp-scada/pull/35)でマージ済み（`3d9db5e931dc73aeff3cec025c465de5114a8992`）、[全体CI 41327155603](https://github.com/tyaro/temp-scada/actions/runs/41327155603)成功。Astra主設計の[画面側History配送と共通Trend](../design/runtime/historian-history-presentation.md)を実装した。

- active1＋pendinglatest1、下位read終了確認待ち、全query照合、所有／凍結と有限JSON入力で要求差替え・取消・旧応答を扱う。自動real transportや補間を追加しない。
- raw点・segment別lane・minmax範囲・bool離散を使い、無値とcoverageを別に示す。unknownCoverageでも観測を消さず、混在binへ値を捏造しない。
- entry差替えの受入fixtureでライト／ダークと状態遷移を検証し、通常Appにsample hookを追加しない。

TS1,443件（新規36件）・型検査・build・関連Chromium12件が成功し、Astra最終レビューに必須修正はない。全体CIはPRで確認する。H1／Rust／DB／Project／SDK／Banto・外部依存は維持する。

次は通常App呼出し・正式Trend定義とHistorySource adapterの接続。製品transport／認証、計画配布・複数group、自動保持・媒体I/O等は保留／後続である。fixtureは実SQLite接続ではなく、上流・S7・実環境へ接続していない。
