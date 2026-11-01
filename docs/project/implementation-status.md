# 現在の実装状況

状態: **現行実装の要約**。2026-10-22（日本時間）、Project 0.35.0。Banto基盤のローカル工程図エディタと読取表示確認を提供する。**Core v1全体・正式Runtime・SCADA serverは未完成**。

この文書を現在状況の入口とする。[統合設計](../design/scada-integrated-design.md)は目標仕様、[開発計画](development-plan.md)は今後の工程、[実装履歴](../history/implementation-history.md)は過去の仕様・検証。[リファクタリング計画](../engineering/maintenance-refactoring-plan.md)の構造整理は機能追加と分離して進める。

最新の区切り: I0〜I4の作図改善と[I6の参照名一括置換](../design/equipment/text-reference-replacement-design.md)は提供済み・全体CI成功。I5は現行版を再計測し、I5f候補を見送り、I5gで保持履歴の資産hash再抽出を限定削減した（全体CI成功）。大図面の読込・キー操作遅延は残る。[工程表と保留条件](upstream-independent-plan.md)を次の判断に使う。

I7は[Symbol内画像の段階設計](../design/images/symbol-image-design.md)に従い、I7aは全体CI成功。I7bのProject0.34.0の保存・読込・共通表示・Symbol配置の原本付きコピーも全体CI成功。I7cとして定義内への画像取込・貼付・差替え・crop／fitを完了・CI成功。

## 固定SDKへの追従（2026-11-01）

[S7 SOAK中の計画](soak-independent-runtime-plan.md)のP1をローカル検証した。Industrial `v0.3.0-alpha.1`の完全revを固定し、Rust投影はSDKの同一世代snapshotを使用する。部分未解決・Unbound・値側source優先をSchema／TSと揃え、共通fixtureと両テーマのブラウザで確認した。[全体CI](https://github.com/tyaro/temp-scada/actions/runs/41225435243)が成功し、PR #10でマージ済み。通常Designerの実Hub接続・認証・正式Runtimeの完成ではない。

## Rust読取Host（P2、2026-11-01）

[ReadHost](../design/runtime/read-host.md)をライブラリとして追加した。Textと機器slotを1つのSDK購読へ集約し、Project／接続先／要求の置換・停止で先に無値と新tokenを公開する。旧通知の拒否、取消・drop、SDK終端エラーをモックで確認し、Rust workspace68件とClippy／fmtが成功した。[全体CI](https://github.com/tyaro/temp-scada/actions/runs/41229716292)の全7job成功後、PR #11でマージ済み。通常Designerは引き続き実Hub未接続。

## 表示DTOと画面session（P3a、2026-11-01）

[表示・配送契約](../design/runtime/read-presentation.md)を追加した。同じHost frameのText／slotを連番付きDTOとして一括検証し、通常Appの任意の`ReadSource`から主画面・Symbol・埋込・小窓・機器詳細・ミニマップへ配る。SIM／Quality／由来を表示し、不正更新やsession終了時は旧値を消す。共通fixtureと両テーマで受け入れ、Rust71件・TS1,253件・型検査・buildが成功した。[全体CI](https://github.com/tyaro/temp-scada/actions/runs/41239680237)の全7job成功後、PR #12でマージ済み。製品transportと実接続はP3b。通常起動はsourceなしの未接続で、認証延期を維持する。

## Host catalogとタグ選択（P4、2026-11-01）

[CatalogHostと選択session](../design/equipment/catalog-selection.md)を実装・ローカル検証した。Rust75件・TS1,267件・型検査・build、関連ブラウザ21件が成功した。[全体CI](https://github.com/tyaro/temp-scada/actions/runs/41241713088)の全7job成功後、PR #13でマージ済み。SDK RESTで明示取得し、表示タグ0件でも使える。最小DTOと任意CatalogSourceを数値Text・機器のnumber／bool slotの既存選択画面へ配る。無効・未知型と古い結果の確定を拒否し、選択は未適用入力へ返す。通常起動は明示サンプル、製品transportは[P3bの境界](../design/runtime/transport-boundary.md)に従い未接続。

## Historian／Trend契約（P5、2026-11-01）

ユーザー指定によりAstraが[契約](../design/runtime/historian-trend-contract.md)と[固定版ChronoGazerの共通利用調査](../reviews/chronogazer-historian-reuse.md)を設計した。Historianの論理分離、記録設定と系列identity、周期記録・Quality／SIM・時刻、History APIと長期検索、ライブとの接続、保持・障害分離を具体化した。不足機能は新設して後日還元する経路を許容する。P5は設計のみで、履歴サービス・Trend widget・共有crateは未実装。[全体CI](https://github.com/tyaro/temp-scada/actions/runs/41250024135)の全7job成功後、PR #14でマージ済み。

## Historianの純粋契約（H1、2026-11-01）

Astra主設計の[版付きJSON契約](../design/runtime/historian-contract-fixtures.md)と[保存方式・復旧契約](../design/runtime/historian-storage-decision.md)を追加した。新crate `scada-historian`とTSの純粋validatorが同じSchema／110 fixtureを使い、query・sampleBatch・raw／minmax・coverage・identity・時刻の構造と意味を検査する。Rust workspace77件・TS1,379件・型検査・build・ブラウザ契約試験が成功した。H2は新SQLite層を暫定採用。H1にはDB・常時recorder・API・UI接続はなく、永続化や真のidentityの検証は後続。

## Historianの原子保存コア（H2a、2026-11-01）

H1は[PR #15](https://github.com/tyaro/temp-scada/pull/15)でマージ済み（`3ae2675e2054928f93911b833ebd64f7dc06f5e3`）。レビュー修正後の[全体CI](https://github.com/tyaro/temp-scada/actions/runs/41255744026)は全7job成功。Astraが[H2a](../design/runtime/historian-atomic-store.md)を主設計し、`scada_historian::store::SqliteStore`を追加した。固定同周期sessionの全memberを1tickで保存し、連続sequence・型付き値・source世代・receiptを同一transactionへ確定する。再送の冪等性、同時刻非破壊、時計逆行、プロセス排他、interrupted検出を一時DBで検証した。

SQLite driverはrusqlite 0.41.1（bundled、既定feature無効）、libsqlite3-sys 0.39.1をlockへ追加。既存依存version・SDK・Project・Bantoは維持。Rust workspace96件（保存コア19 test関数、child worker含む）、Clippy・rustfmt成功。子プロセスをCOMMIT前4境界／COMMIT直後に終了し、全rollback／receipt再取得を確認した。媒体I/O障害・停電・Windows運用を保証する試験ではない。通常App・実Hub・Industrialには未接続。検索snapshot・coverage生成・保持・容量・常時記録は未実装で、H2全体は継続中。

## Historianのraw snapshot検索（H2b1、2026-11-01）

H2aは[PR #16](https://github.com/tyaro/temp-scada/pull/16)でマージ済み（`45105ab0c95d6d0482f7f99c738b46e49eab89cc`）、[全体CI](https://github.com/tyaro/temp-scada/actions/runs/41264959997)は全7job成功。Astra主設計の[H2b1](../design/runtime/historian-query-snapshot.md)に従い、ownedな読取専用接続からrawを同一snapshotで検索する。半開区間・安定順・型・過去metadata・直近sessionのcommit位置を維持し、既知系列には要求全域のunknownCoverageを返す。記録・欠測の連続性は推測しない。reader最大2個、期限・VM・decode行数・出力bytesを制限し、上限超過や取消を途中のreadyへ変換しない。

Rust workspace112件（H2b1単体15件と共通検索fixture4ケースを確認する1関数を追加）、TS114ファイル・1,383件、型検査0エラー・0警告、build、Clippy・rustfmt、関連Chromium2件成功。保存中の未commitデータ非公開、append／session切替とのsnapshot競合、取消・SQL中断・cleanup失敗・panic後の接続終了／再利用、所有の保持を一時DBで確認した。共通fixtureはH1の110件に加え、実SQLite出力4ケースをRust／TS／ブラウザで照合する。minmax、時刻付き計画と確定coverage、保持・容量、常時recorder、公開Historyサービス／UI接続は後続で、H2全体は継続中。

## Historianのmin/max集約（H2b2、2026-11-01）

H2b1は[PR #17](https://github.com/tyaro/temp-scada/pull/17)でマージ済み（`3113b51c8a8a49da018f1a18de00b182ae5a10aa`）、[全体CI](https://github.com/tyaro/temp-scada/actions/runs/41267109291)全7job成功。Astra主設計の[H2b2](../design/runtime/historian-minmax-query.md)に従い、`HistoryReader::query_minmax`を追加した。共通gridを整数で作り、SQLで観測をbinへ集約する。number／boolのピークと件数を保持し、segment・session＋clockEpoch・取得元世代が混ざればnull包絡のmixedSegmentにする。空binで適用metadataが不明ならMetadataAmbiguousとして要求全体を拒否する。連続記録は未証明なので全域unknownCoverageを維持し、completeは生成しない。

Rust workspace126件（新規単体13件・共通minmax fixtureの統合1関数）、TS114ファイル・1,389件、型検査0エラー・0警告、build、Clippy・rustfmt、関連Chromium3件成功。9,001tickをdecode上限20行で集約し短い山を保持した。SQLが破損recordをinvalidCount／混在へ隠さないこと、H1の正常sample理由の一致、NUL入り時計ID拒否、集約SQL処理中の取消・writer継続を確認した。実SQLiteの6成功resultとmetadata曖昧1失敗を共通fixtureに追加し、正常resultはRust／TS／実ブラウザで照合した。時刻付き計画・確定coverage・保持・容量・常時recorder・公開Historyサービス／UI接続は後続で、H2全体は継続中。

## Historianの記録期間と欠測証拠（H2b3、2026-11-01）

H2b2は[PR #18](https://github.com/tyaro/temp-scada/pull/18)でマージ済み（`bd24c5d29db74c2eb59b8c8af24bf1634ab3026b`）、[全体CI](https://github.com/tyaro/temp-scada/actions/runs/41270705728)全7job成功。Astra主設計の[H2b3](../design/runtime/historian-recording-evidence.md)に従い、固定計画snapshot、sessionの開始・終了時刻、明示的なsamplingMissed／storageLoss区間を原子的に保存する。時計世代と観測frontierを照合し、時刻逆行はinterruptと新sessionで扱う。gapは保存tickのsequenceを進めず、Good／無値を含む既存観測との重複を拒否する。

DB format 2へ明示更新し、format 1や版不一致は自動変更せず拒否する。依存・SDK・H1 JSON v1・Project0.35.0・Banto6.9.0は維持。Rust workspace140件（新規14 test関数、child worker含む）、Clippy・rustfmt、関連Chromium3件が成功。COMMIT前後のprocess終了、再送、SQL障害時の全rollbackとNeedsReopen、旧DB非変更を確認した。公開queryは全域unknownCoverageを維持し、証拠のcoverage投影・保持・容量・recorder・Historyサービス／通常App接続は後続。H2全体は継続中。

## 保存契約と基盤

| 項目       | 現在の契約                                                                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| アプリ基盤 | Banto v6.9.0を固定。Svelte 5／TypeScript／Vite。認証統合は延期                                                                          |
| Project    | `schemaVersion`／`minRuntimeVersion`は**0.35.0**。TS／Rustで共通JSON Schemaと参照・幾何・予算の意味検証                                 |
| 保存       | 資産なしはJSON。PNG／JPEG原本付きは最小`.bantoscada` ZIP（`banto-scada.image-project` profile 1）。設計上の正式directory／ZIP全体は後続 |
| 旧形式     | 0.1.0のみ既存の検証付き読込経路で現行へ移行。0.2.0〜0.34.0や未知の形式は拒否。リリース前の互換性を保証しない                            |
| IDと変更   | lowercase UUID v7、有限座標、明示order。編集失敗は原子的拒否、同値はno-op、Undo／Redoでもrevisionは巻き戻さない                         |
| 所有者     | Projectは設定と参照。原本bytesはAssetStore。UI選択・倍率・draft・小窓位置はProject外。値・Qualityを保存やUndoへ入れない                 |
| 共有SDK    | industrialの固定revを使う読取投影とモックHub検証。PLC直接接続・SDKや式評価の複製はしない                                                |

Banto Menu #427／#430へ可用高・内部scroll・初回focusを移管し、PR #9で局所adapterを撤去済み。レビュー修正ではcontextKeyによる再生成をMenuGroup／項目だけへ狭め、Menu／popover／⋮ triggerを保持する。focus回帰試験を追加し、Chromium 156とChrome 155で関連13spec・76件が成功した。200px幅では左端−4pxの既知制約が残る。[責務と検証範囲](../design/editor/designer-menu-viewport.md)を参照する。

## 機能の対応範囲

| 領域           | 実装した範囲                                                                                                                                                                                                                                      | 主な残り                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Studio         | 薄いheader、6分類メニュー、共通toolbar、ライト／ダーク／OS連動                                                                                                                                                                                    | 5種類の開発画面全体、外観の仕上げ                                                      |
| 左ペイン・部品 | プロジェクト／レイヤー／部品、ツリー、検索、分類、アイコン／名称、右クリック、お気に入りと連続配置、機器台帳と任意種別編集、Symbolの機器関連付け                                                                                                  | 大規模機器一覧、グループ内部編集等                                                     |
| パネル         | 個別／一括表示と復帰、左右幅と下部高さの保存、固定標準配置の復元、左右パネルの固定／浮動・移動／resize・各専用配置の明示保存・前面化                                                                                                              | 下部の浮動・タブ個別分離・任意ドッキング、名前付き全体配置、draftのDOM分離             |
| 共通作図       | 選択・範囲選択、移動・サイズ・回転・整列・中心等間隔・幅／高さの一括指定、頂点、コピー／切取／貼付、Undo／Redo、幾何グループ、接続済みPolylineのSymbol追従、Inspectorでの端点接続・解除、Symbol使用先表示                                         | グループ任意拡縮・入れ子、図形演算、マウス吸着による接続作成・任意port／自動routing    |
| 配置・レイヤー | 名前、編集ロック、静的非表示、整理フォルダー、同階層の手動順変更、親と所属のドラッグ変更・兄弟内の位置指定ドラッグ                                                                                                                                | 継承表示、一時非表示                                                                   |
| 図形・文字     | 矩形／楕円の塗り・枠線、一括編集、実線／破線／点線、配置opacityとその一括編集、色αと矩形／楕円の塗り・枠線α一括編集、2色線形／放射gradient、斜線／交差線／点pattern、Textの書式と揃え・静的Textの明示改行・枠幅での自動折返し・Textだけの一括書式 | 多点stop・図上gradientハンドル、任意行間・縁取り、Text／線／Symbol等のα一括            |
| 画像           | Symbol内Imageの取込・編集・貼付・保存・共通表示・原本付きコピー、原本共有、背景fit、Imageのcontain／cover／stretch枠、比率復帰、原本付きclipboard、差し替え、配置・背景の非破壊cropと原本プレビュー上の範囲指定・移動・サイズ変更・縦横比固定     | 図面上の直接crop                                                                       |
| 画面再利用     | 同一Project・1段の読取埋込View、共有参照、参照先編集、使用中画面の削除保護、複製、依存画面と原本付きclipboard v4                                                                                                                                  | 機器context付き共通画面、独立テンプレート                                              |
| 表示確認       | 画面／機器の読取Popup合計4件、前面化・移動・resize・Esc、ブラウザ全画面と終了経路                                                                                                                                                                 | 正式Equipment Faceplate、設備操作、正式RuntimeのPopup、運用kiosk                       |
| viewport       | 画面別倍率・pan、ミニマップ、ルーラー、選択範囲表示、縦／横ホイールとCtrlズーム                                                                                                                                                                   | 実図面・画像／Symbol等の計測と必要な最適化                                             |
| 入力           | 数値Enter／blur、明示適用フォーム、IME、未適用入力保護、対象世代と非同期破棄                                                                                                                                                                      | 実catalog選択、draftのDOM分離                                                          |
| タグ・Runtime  | TextのexternalName、参照一覧と全画面の差分確認・一括置換、サンプル／任意catalog sourceの検索と型絞込、未接続表示、Rust SDK投影・読取Host、Text／slot表示DTOと任意sourceの画面配布                                                                 | 製品transport・実Hub接続、汎用状態条件、正式RuntimeとAction境界                        |
| server・監視   | 提供段階と共有層の設計                                                                                                                                                                                                                            | Core v1のS9b、その上のv1.1 Alarm／Event・Action／History・Trend、Camera、HTTP／Program |
| 認証・MES      | ログイン不要のローカル編集                                                                                                                                                                                                                        | industrialの修正後に認証再確認。ユーザー管理・運用移行・MESは未実装                    |

共有Symbolは定義と単色／定義色、独立コピー、機器関連付け、型付きslot宣言とText表示・bool状態別文字色に対応する。矩形／楕円の単色塗りとPolyline・矢印はbool Textの状態色追従に対応する。汎用状態条件・設備操作は未実装。整理フォルダーを幾何グループとして扱わない。読取プレビューから実機要求は送らない。

## 検証の範囲

最新のI5gはTS全1,214件・関連ブラウザ40件・型エラー／警告0・build・整形・リンクをローカル確認済み。3規模の保存原本・資源確認と、履歴資産集計の限定改善を[計測記録](../performance/mixed-editor-quality.md#history-asset-index)へ記録した。実装`01d5df0`は[全体CI39589758815](https://github.com/tyaro/temp-scada/actions/runs/39589758815)でFrontend・Rust・ブラウザ4分割・集約checkがすべて成功した。

I7c時点の`313b806`は[全体CI39570702994](https://github.com/tyaro/temp-scada/actions/runs/39570702994)でFrontend・Rust・ブラウザ4分割・集約checkがすべて成功。ローカルでは型（エラー・警告0）、単体1,142件、関連ブラウザ46ケース、本番build、整形と両テーマ実画面を確認した。全ブラウザ件数をローカル関連試験の件数と読み替えない。I8aは全体CI成功。I8bの`7faff97`は[全体CI39576110879](https://github.com/tyaro/temp-scada/actions/runs/39576110879)成功。I8cの`eef69fd`も[全体CI39578127673](https://github.com/tyaro/temp-scada/actions/runs/39578127673)成功。接続・解除UIはTS全1,207件・関連ブラウザ34件・型エラー／警告0・build・整形・リンクをローカル確認済み・全体CI成功。

R0〜R5の構造整理は完了し、[リファクタリング記録](../engineering/maintenance-refactoring-plan.md)に各段階の不変条件・テストを保持する。[当時の検証詳細](../history/implementation-history.md#status-validation-archive)と[性能の実測条件・採否](../performance/mixed-editor-quality.md)を現在の機能保証と区別する。実Hub／catalog・正式Runtime・認証・Windows実機の運用確認は未完了。

## 仕様・実画面への入口

- 画像: [保存](../design/images/image-assets-design.md)、[配置と差し替え](../design/images/image-placement-design.md)、[clipboard](../design/images/image-clipboard-design.md)、[cropと実画面](../design/images/image-crop-design.md)。
- 描画: [塗りと線](../design/graphics/shape-paint-design.md)、[線形gradient](../design/graphics/linear-gradient-design.md)、[pattern](../design/graphics/pattern-paint-design.md)、[α](../design/graphics/color-alpha-design.md)。
- 再利用: [共有Symbol](../design/graphics/symbol-color-design.md)、[埋込View](../design/images/embedded-screen-design.md)、[Popup](../design/images/preview-popup-design.md)、[全画面](../design/images/preview-fullscreen-design.md)。
- 操作と構想: [UX設計](../design/editor/frontend-ux-design.md)、[UI改訂](../design/editor/designer-ui-revision.md)、[機器作成の追加提案](../design/proposals/equipment-authoring-detail-proposal.md)。

## 幾何グループの実装段階

[初回設計](../design/editor/geometric-groups-design.md)に沿い、G1／G2の保存・ドメイン・再利用とG3 Designer接続を実装した。0.22.0でScreenのgroups、所属・描画順・参照の共通検証、作成／解除／名前／一括移動・90度回転／状態／整列・描画順、複製・削除・画面複製・clipboard v3を追加した。TS／Rust共通の不正ケースと、原子性・Undo・再採番を検証する。

Designerはグループ単位の選択・レイヤー行・toolbar／メニュー／右クリック・キー・Inspectorへ接続済み。G4の全体ブラウザ521件と実画面の確認も完了した。内部の部分編集はドメインで拒否し、既存v1／v2 clipboardでgroup情報を失わせない。任意拡縮・入れ子・Symbol定義内グループは後続。ローカルで型（エラー／警告なし）・TS671件・Rust31件・Clippy・関連ブラウザ23件が成功。ブラウザではgroup付きファイル往復・native v3コピー／貼付・Undoも確認した。AstraレビューのProxyコピー、実効状態no-op、Unicode名長の指摘は修正し回帰テストを追加した。G1〜G4の全体CIも成功した。

G3の型（エラー／警告なし）・TS676件、新機能の関連ブラウザ12件が成功。F2の子選択への崩れ、改名Undo後のdraft、IME、Symbol使用先の遅延ガード、非表示時の選択解除はAstraレビューに基づいて修正し、実ブラウザで確認した。

最終の全ブラウザ521件は専用サーバー・2並列の一度の実行ですべて成功した。ライト／ダーク1920×1080の[実画面](../design/editor/geometric-groups-design.md#geometric-groups-screenshots)を撮影し、同じ配置をグループ化した場合と独立配置の場合のプレビュー画素が両テーマで完全一致した。撮影後のプロパティ外観調整も関連12件と型（エラー／警告なし）・buildで再確認した。全体整形と変更文書のローカルリンク284件も成功。

## 型付き読取slotの前段

[表示用adapter](../design/equipment/typed-read-slots-design.md)へbool／numberと構造化した機器／slot keyを追加した。外部名の重複要求を集約し、未割付・未接続・未解決・型不一致・Qualityを区別する。既存数値Textと同じ検証処理を共有し、Rust40件・Clippy・Rust fmt、TS676件・全体整形が成功。Astraレビューと別正常タグの局所成功も確認した。この先行区切りではProject0.22.0・UI・固定SDK revは変更していない。現在のEquipment保存は次節の範囲。Equipmentの保存・台帳UI、動的Symbol、Host、実Hub接続の完成ではない。

## Equipmentの保存と初期台帳

0.23.0で[機器種別・Instance・採用read slot](../design/equipment/equipment-register-design.md)の保存とTS／Rust検証、原子的CRUDを実装した。プロジェクトツリーの「機器」から読取種別の追加・登録・割付・削除を行い、draft保護とUndoへ接続する。未採用と採用未割付を区別し、使用中種別の削除と採用slotの破壊的変更を拒否する。ProjectからReadSlotPlanへ接続した。TS715件・Rust43件・関連ブラウザ24件・型／Clippy／buildが成功。図面との機器参照、動的Symbol、実catalog・Host、正式Runtimeは後続。

## CIの並列化

[実装と実測](../performance/ci-acceleration-results.md)に沿い、frontend／Rust／E2E4shardを並行実行し、従来のcheckへ集約した。アプリ・テストを変えず、同じ526件で旧CI15分54秒→4分25秒／4分31秒、連続2回とも全体成功。Equipmentの保存・初期台帳までを含む型・TS715件・Rust43件とサンプル検証もCIで成功した。従来型のブランチ保護APIは403で読取不可のため、必須チェック設定全体は未確認。保護設定は変更していない。

## 機器とSymbol配置の関連付け

0.24.0で[関連付け・全画面の使用先・削除保護](../design/equipment/equipment-symbol-association.md)を追加した。同じ機器を複数配置で参照し、複製・画面複製でも割付を共有する。共有定義へは機器を埋め込まない。機器付きclipboardは明示拒否。TS728件・Rust44件・関連ブラウザ23件、型／Clippy／buildが成功。静的関連付けまでで、型付きslotの動的描画・実値表示は後続。

## Symbolの読取slotと割付状態

0.25.0で[読取宣言・Text割付・取得前状態の表示](../design/equipment/symbol-read-slots.md)を追加した。共有定義はbool／numberの役割を宣言し、各配置の機器contextから未関連付け・slot欠落・型不一致・未採用・未割付・未接続をText単位で表示する。宣言とTextの追加は一回のUndo。slot単体clipboardは理由付き拒否し、未関連Symbol全体は宣言ごと保持する。TS747件・Rust45件・関連ブラウザ41件、型／Clippy／build／CLIを確認。この区切りの実値受入は後続だった。現在の表示DTO受入は次節の範囲。宣言の追加・未使用行の改名／型変更／削除は後続節で実装済み。動的配色・実Host接続は後続。

## 型付き結果の受入とGood／Quality表示

[ReadSlotViewの受入・session世代・描画](../design/equipment/read-slot-presentation.md)を追加した。Project保存形式は0.25.0を維持する。全採用slot・型・外部名・metadataを照合し、不正入力では値を消す。旧tokenを無視し、同ID／revisionの別Projectや旧frameも表示へ流用しない。Good false／0、Bad／Staleの値消去、SIMと取得由来をメイン・埋込・小窓へ反映する。通常Designerは実Host未接続のため未接続表示を維持する。実値の検証はRust共通fixtureとブラウザテスト入力によるものであり、実Hub動作完了ではない。TS800件・Rust46件・関連ブラウザ27件、型／Clippy／build／全体整形を確認した。

## Symbolのslot宣言編集

[任意名の宣言追加・未使用行の改名／型変更／削除](../design/equipment/symbol-slot-editing.md)を左のプロジェクト設定へ追加した。hidden／lockedを含むText参照中の変更・削除をドメインとUIで保護し、同値編集はno-op。draft・IME・対象世代・Undoへ接続した。表示追加は既存コマンドを共用し、改名の適用後に古い宣言を再作成しない。Project0.25.0を維持し、機器側のslot・外部名を自動変更しない。型0エラー／0警告・TS807件・関連ブラウザ9件・buildと両テーマの実画面を確認。動的配色・実Host接続・Faceplateは後続。

## boolの型付き状態と理由表示

[動的配色の前段](../design/equipment/bool-slot-state.md)として、Goodだけに型付き値を持つ表示結果と、boolのtrue／false／unknownへの純粋な判定を追加した。0／1をboolへ変換せず、元Qualityと未知理由・SIM由来を分離する。返却valueの変更で受理frameが変わらない。invalid理由コードをTextのtooltip・読み上げへ伝え、Good復帰時に消す。メイン・埋込・小窓で同一mount更新を両テーマで確認した。Project0.25.0を維持し、配色の保存宣言・編集UI・図形への適用と実Hostは未実装。最終検証は型0エラー／0警告・TS834件・関連ブラウザ2件・build・全体整形。Rust／共通schemaは変更していない。

## bool Textの状態別文字色

0.26.0で[共有Symbolのbool Textに対する状態別文字色](../design/graphics/bool-text-colors.md)を追加した。true／false／取得不能の3色を保存・編集し、配置の単色より優先する。状態・理由・SIMの文字表示と既存αは維持する。slot変更時の配色解除を同じUndoへまとめ、二重draftの競合は適用前に拒否する。TS／Rustの現行契約とサンプルを更新した。矩形・楕円・配管の動的色、実Host接続・Faceplateは後続。

この区切りは型0エラー／0警告・TS852件・Rust46件・Clippy・Rust fmt・本番build・全体整形・CLIと、関連ブラウザ11件／追加修正後4件の確認が成功。両テーマの実画面を撮影し、設計書へ掲載した。

## 図面外の読取状態表示

[メイン図面・読取小窓の折り畳み状態一覧](../design/equipment/slot-status-summary.md)を追加した。表示参照・取得不能・SIMの件数、配置経路・機器・slot・文字／Quality／理由・由来を図面のクリップとαから独立させる。閉じた状態では行をDOMに作らず、展開時も20件ずつ表示する。可視配置と1段埋込を対象にし、hidden／α0 Textの使用参照は保持する。図形の動的配色と実Hostは今回追加していない。Project0.26.0・Rust／schemaは変更しない。

この区切りは型0エラー／0警告・TS855件・build・全体整形、状態一覧と同一mountの6件／既存小窓10件のブラウザ検証が成功。両テーマの実画面を撮影し、設計書へ掲載した。

## 共有図形の状態色追従（2026-10-20）

Project 0.27.0で、同じ定義のbool状態色Textを参照する矩形／楕円／Polylineを追加した。枠線と各図形のαを維持し、取得不能・SIMは図面外の読取状態一覧でも確認する。配色元の破壊的変更保護、参照を維持する複製、単体clipboard拒否を実装した。[仕様・検証・実画面](../design/equipment/state-color-following.md)を参照する。

この区切りのローカル検証は型エラー／警告0、TS878件（80ファイル）、Rust47件、Clippy、CLIサンプル検証、本番build、全体整形が成功。新機能と同一mount更新のブラウザ4件は専用サーバー・1並列で両テーマ成功した。初回のlocator重複と試験データの同一参照更新を修正し、同時dirty入力の原子的拒否も確認した。Astraの読取レビューで必須修正なし。実Hub接続の検証ではない。

## 機器の読取詳細（2026-10-20）

Project 0.27.0を維持し、表示プレビューの機器検索から読取専用の小窓を開く入口を追加した。図面未使用の採用slot・未割付も表示し、機器IDを固定して既存画面小窓と同じstack・合計4件上限を共用する。20件ページング、false／0・Quality・理由・SIM・来歴を既存読取sessionから表示する。[範囲と実画面](../design/equipment/equipment-read-details.md)。正式Faceplate・設備操作・実Hostは未実装。

この区切りは型エラー／警告0、TS896件（81ファイル）、本番buildが成功。関連ブラウザ15件を確認し、fixtureの採用状態・件数を修正した後の機器詳細3件も成功した。Astraの読取レビューに必須修正なし。追加観点の24slotページ切替・キーボードスクロールも確認済み。Rust／保存schemaは変更していない。

初回の全体CI `265f526` は390px幅の表示プレビューでtoolbar横はみ出しを検出した。他の区画は成功。狭い画面で表示モードのボタン群を折り返すよう修正し、既存workspace試験をボタンのviewport内表示確認でも補強した。ローカルで失敗を再現後、機器詳細3件とworkspace2件・buildの再検証が成功した。

選択Symbolから読取詳細へ直接移る入口を追加した。ロック中も使用でき、未関連付けは理由付き無効化。draft適用後に配置の機器IDを再取得し、適用／破棄／キャンセル／関連付け解除を保護する。非同期起動の世代・画面・mode確認と、切替後のtoolbarへのフォーカス復帰を行う。Astraレビューで必須修正なし。

直接起動の`f64180d`は[全体CI](https://github.com/tyaro/temp-scada/actions/runs/39384115268)が成功。続けて、非表示Textの再計測がResizeObserver通知中にSVGを更新する警告を修正した。再計測は次の描画フレームへ集約し、破棄時には予約を取り消す。実ブラウザの警告を再現後、同じ操作で0件になることを確認した。機器入口・Text書式のブラウザ13件、型エラー／警告0、TS896件、buildが成功。

## 機器種別のDesigner編集

既存0.27.0契約のまま、機器台帳を一覧／種別の切替式にし、任意bool／numberの読取slotを作成・変更・削除できる入口を追加した。採用数と未割付を含む保護、構造draft、一回の適用／Undoを実装。[仕様と実画面](../design/equipment/equipment-type-editing.md)。実catalogや正式設備テンプレートは後続。

この区切りは型エラー／警告0、TS906件（82ファイル）、本番buildが成功。関連ブラウザ12件の範囲を確認し、最終の種別編集5件も専用サーバー・1並列で成功。Astraレビューの末尾改行の指摘をフォーム検証へ反映し、禁止文字の回帰を追加した。構造変更は同期的にdirtyへ反映し、直後の移動でも入力を落とさない。ライト／ダークの実画面を撮影した。文字の再計測修正`e5158e9`も[全体CI](https://github.com/tyaro/temp-scada/actions/runs/39384957602)が成功した。

機器台帳へ番号・名前・種別名の検索と20件ページ表示を追加した。全角英数字と英字の大小を吸収する。結果外の機器も編集中の入力を保持し、対象切替のみ既存draft確認を使う。55件のページ境界・検索・保存不変と既存台帳の関連ブラウザ6件、型エラー／警告0を確認した。

機器種別の編集`5b5f53f`は[全体CI](https://github.com/tyaro/temp-scada/actions/runs/39387107106)が成功した。検索・ページ表示の本番buildも成功し、保存契約は0.27.0のまま。

## 読取詳細から機器の配置へ移動

機器小窓に全画面の使用先一覧と20件ずつのページ表示を追加し、既存の使用先選択へ接続した。編集へ戻る際に小窓を閉じ、別画面・非表示／ロック・グループの選択を扱う。表示／ロックと保存内容・Undoは変更しない。[範囲・実画面](../design/equipment/equipment-read-details.md)。台帳検索`adc1b08`の[全体CI](https://github.com/tyaro/temp-scada/actions/runs/39387797784)も成功した。

この区切りは型エラー／警告0、TS906件（82ファイル）、本番buildが成功。関連ブラウザ7件で両テーマ・グループと保存不変を確認した。Astraの静的レビューに必須修正なし。ライト／ダークの実画面も更新した。Rust／schemaは変更していない。

## 既存機器を元に別の機器を登録

既存の種別・採用slotを引き継ぎ、外部名をすべて未割付として新しい番号で登録できる。図面配置・元機器・共有種別を変更せず、作成一回をUndo／Redoできる。元機器と登録中の入力保護も維持する。[仕様と実画面](../design/equipment/equipment-register-design.md)。読取詳細の図面使用先`f33d661`は[全体CI](https://github.com/tyaro/temp-scada/actions/runs/39388959155)が成功した。

この区切りは型エラー／警告0、TS906件、関連ブラウザ8件と本番buildが成功。Astra指摘の遅延時の元ID喪失を修正し、適用して元機器へ戻る経路も確認した。Undoで内容は戻し、Project revisionは単調増加を維持する。両テーマの実画面と設計を更新した。Rust／schemaは変更していない。

## Symbolと機器の関連付け候補の確認

未適用のSymbol／機器候補に対して、実使用slotの保存設定を確認できる。hidden Textも含め、未使用宣言は別に集計する。不足・型違い・未採用・未割付と「外部名あり・catalog未確認」を表示し、候補を自動変更しない。[仕様と実画面](../design/equipment/symbol-equipment-check.md)。型エラー／警告0、TS909件（83ファイル）、関連ブラウザ8件・buildが成功。Astraレビューに必須修正なし。両テーマ・両候補の変更順・キャンセル／破棄／適用／Undo・ロック・24slotページ境界を確認した。Rust／保存schemaは変更していない。

別機器登録`8af2377`の[全体CI](https://github.com/tyaro/temp-scada/actions/runs/39389952118)も成功した。industrial #682は再確認時もOPENで、実Host接続の上流契約待ちを維持する。

## 選択Symbolから機器台帳への直接移動

プロパティの明示ボタンから対象機器の台帳設定を開く。未適用入力を解決後に機器IDを再取得し、検索を維持して機器一覧へ切り替える。非表示の左パネルと閉じた機器ツリーを復帰し、ロック配置からも共有台帳へ進める。[範囲](../design/equipment/equipment-symbol-association.md)。移動自体は保存内容・履歴を変更しない。

型エラー／警告0、TS909件、関連ブラウザ9件・本番buildが成功。両テーマのpanel／種別表示復帰、機器割付と別台帳のdraft保護、関連付け解除と保存不変を確認した。Astraレビューに必須修正なし。Rust／保存schemaは変更していない。

## 機器設定・読取詳細の右クリック入口

キャンバスとレイヤーの単一Symbolから、台帳設定と読取詳細を開ける。プロパティ非表示・配置ロック中にも利用でき、レイヤーのShift＋F10も共用する。未関連付けは無効、複数選択・定義内部では単一機器の操作を表示しない。

型エラー／警告0、TS909件とbuildが成功。既存選択メニュー12件と機器メニュー4件を確認した。最初のcanvas試験は図形の上にある正規hit領域へ内部polylineのクリックが遮られたため、実際の配置hit領域をクリックする試験へ修正し、4件の再検証が成功した。アプリ側でforceクリックやhit領域の変更は行わない。保存契約は維持する。

候補確認`386e636`の[全体CI](https://github.com/tyaro/temp-scada/actions/runs/39390905952)と、台帳への直接移動`3c01b22`の[全体CI](https://github.com/tyaro/temp-scada/actions/runs/39391528579)も成功した。

## 配置画像の表示方式（0.28.0）

Imageのfitをcontain／cover／stretchへ拡張し、共通描画と独立したプロパティへ接続した。crop後の元画素範囲を枠へ写し、原本・crop・配置枠・回転・opacityはfit変更で変えない。未適用見本は実枠の比率を使う。別原本への差替えではcropを解除し、fitを維持する。背景やScreenViewの契約は変更していない。[仕様と実画面](../design/images/image-fit-design.md)。

型エラー／警告0、TS923件（84ファイル）、Rust48件、Clippy・Rust fmt・CLIサンプル16件とbuildが成功。既存crop9件とfit3件の関連ブラウザ12件、3方式の埋込／小窓／ミニマップ確認3件と、回転・αを加えた最終fit4件が成功した。回転画素の試験では回転用SVG子の座標変換を使い、配置の平行移動だけと混同しない。Astraレビューのstretchと矛盾する旧説明を修正した。ライト／ダークの実画面を掲載した。

機器の右クリック操作`1630106`の[全体CI](https://github.com/tyaro/temp-scada/actions/runs/39392343865)も成功した。0.28.0全体のCIはPush後に確認する。

画像配置・差替えの既存ブラウザ14件も成功。変更文書のローカルリンク370件・全体整形を確認した。実画面はviewport内で撮影し、参考図の実画素の描画を待って保存する。

## 背景画像の数値トリミング（0.29.0）

背景に任意cropを追加し、配置と同じ元画素・1px・丸め境界を検証する。背景4方式を切出し後へ適用し、originalは元画素サイズの中央配置とする。独立した数値フォームと未適用見本、同hash保持・別hash解除、取込中の背景asset／crop変更と往復の失効を追加した。fit／opacityだけの変更は最新設定を維持して取込を続ける。[設計と実画面](../design/images/background-image-crop-design.md)。

型エラー／警告0、TS943件（85ファイル）、Rust49件、Clippy・buildが成功。背景の新旧ブラウザ17件が成功し、両テーマ4方式の実画素・opacity一回・原本保存／Undo・draft・遅延取込・埋込／ミニマップ／小窓を確認した。Astra指摘の2つのProxyコピー経路を修正し、通常Proxyの単体回帰と取込エラー不在も確認する。修正の再レビューに追加の必須指摘なし。ライト／ダークの実画面を掲載した。

配置画像の3方式`94c8ae5`の[全体CI](https://github.com/tyaro/temp-scada/actions/runs/39394502122)も成功。0.29.0の実装`e53a304`の[全体CI39462449843](https://github.com/tyaro/temp-scada/actions/runs/39462449843)が成功した。

## 原本プレビュー上の切出し調整（0.29.0）

配置・背景のトリミングに「範囲をマウスで調整」を追加した。原本上の範囲指定・移動・四辺／四隅のサイズ変更と、矢印1原本画素／Shift＋矢印10画素の調整に対応する。ドラッグ候補は操作面に保持し、離したときに数値欄へ反映する。図面の更新・保存契約・Undoは既存の適用経路を使う。[操作・取消条件・実画面](../design/images/image-crop-pointer-design.md)。

直前の背景cropコミット`0b65310`の[全体CI](https://github.com/tyaro/temp-scada/actions/runs/39397453493)はfrontend・Rust・全E2E4分割・checkが成功。

検証: 型エラー／警告0、TS954件（86ファイル）、本番build、全体整形が成功。既存の配置crop11件・背景crop7件と新しい操作8件を確認した。ドラッグ終了前保存、開始前の入力文字列を保つ取消、capture／blur／resize、余白・単クリック・原本外の逆方向・実ハンドル、背景とUndo、プレビュー切替を検証した。Astraの指摘した境界計算とフォーカスの座標ずれを修正済み。保存契約は不変でRustの変更はない。

## 埋込画面のclipboard（Project0.29.0・clipboard v4）

Viewの選択に参照画面・必要Symbol・画像原本を同梱し、同じProject世代では現行参照を再利用、別Projectでは新IDで取り込む。空の参照画面、背景だけの画像・crop、隠れた配置、folder／groupを保持する。原本付きの判定はsnapshot全体の資産で行い、現行画面再利用時には古い資産・定義を追加しない。機器関連付けを含むコピー、入れ子・自己参照、Symbol定義への貼付は拒否する。切取の書込完了・所有者照合と失敗時の原子性を維持する。[仕様と検証](../design/images/screen-view-clipboard-design.md)。

直前のマウスcropコミット`e6777dd`の[全体CI](https://github.com/tyaro/temp-scada/actions/runs/39399367125)はfrontend・Rust・全E2E4分割・checkが成功。

検証: 型エラー／警告0、TS962件（87ファイル）、本番build、全体整形が成功。新規の埋込clipboard4件と既存埋込・通常clipboard・画像clipboardを合わせた関連ブラウザ28件を確認した。背景だけの画像原本・cropの別Project往復、共有元の集約・現行再利用、1回のUndo／Redo、自己参照の拒否、書込失敗と遅延応答、容量／原本不正時の全体拒否を含む。Astraの読取レビューで必須修正なし。Project保存契約・Rustは変更していない。

## 共通の複数選択操作

キャンバス・レイヤーのCtrl／Command＋クリックを追加・解除へ接続し、幾何グループ単位の選択と既存の未適用入力保護を維持する。Ctrl／Command＋空白範囲は追加選択、単なる空白クリックは選択保持とする。既存Shift操作・単一選択・パン・プレビューは維持し、選択だけでProjectとUndoを変更しない。ツールバーと操作ガイドの説明を揃えた。

型エラー／警告0、本番build、全体整形、複数選択・範囲選択の関連ブラウザ14件が成功。Ctrl／Command／Shift、グループ全体の追加・解除、保存JSONとUndoの不変、範囲の取消、未適用名のキャンセルと適用後再開を確認した。Project保存契約・Rustは変更していない。

## 2色放射グラデーション（0.30.0）

矩形／楕円の塗りに、図形を正規化した中心X／Yと半径・両端のRGB／αを追加した。半径50%は幅・高さの半分、非正方形では楕円状。独立した種類別draft・初回の両端色引継ぎ・未適用見本、％往復で未変更f64を保つ再適用を実装した。共有PrimitiveはobjectBoundingBox・中心と焦点・padを明示し、定義色／単色Symbol・埋込View・Popup・ミニマップで共用する。[仕様・実画面](../design/graphics/radial-gradient-design.md)。

直前の`502cc21`の[全体CI](https://github.com/tyaro/temp-scada/actions/runs/39402603895)はfrontend・Rust・全E2E4分割・checkが成功。

## 検証記録

型エラー／警告0、TS987件（88ファイル、％入力のFormData4件も再確認）、Rust49件、Clippy・Rust fmt・本番build、CLIサンプル17件が成功。新規放射5件と既存線形・pattern12件の関連ブラウザ17件で、両テーマの実画素・回転・非正方形・resize、種類往復と両端継承、IME・不正入力の非適用、Symbol／miniのID分離とα、埋込View・Popupの共有描画を確認した。共通fixtureは中心・半径・α・不足／余剰属性・極端な寸法の描画範囲までTS／Rustで一致する。Astraの実装レビューでも必須修正なし。両テーマの原寸スクリーンショットを確認済み。

## レイヤーフォルダーの手動順

右クリック／Shift＋F10から同階層で一つ上・下へ移動する。兄弟のorderだけを交換し、図面の描画データ・親子関係・ロック／非表示を保持する。通常画面と共有定義で使え、端はno-op、検索中は理由付きで無効にする。未適用入力・世代の再照合とUndo1回を維持する。[操作・保存範囲](../design/editor/layer-folders-design.md)。

検証: 型エラー／警告0、TS990件（88ファイル）、本番buildが成功。フォルダー構造・親変更・並べ替えの関連ブラウザ25件と、並べ替え後のフォーカス復帰の再確認1件が成功した。図面画素・配置情報の不変、親・隠し／ロック・共有定義、疎なorderと安全整数上限、端のno-op、検索中の無効、未適用名のキャンセル・適用と独立Undoを含む。保存契約・Rustに変更はない。

直前の放射gradient`93058ce`の[全体CI](https://github.com/tyaro/temp-scada/actions/runs/39404742241)も成功した。

## 共有シンボルの機器情報表示

[Project0.31.0の範囲と実画面](../design/equipment/equipment-property-design.md)。共有Textの表示元へ機器コード・機器名・機器種別名を追加した。現在の保存台帳から配置ごとに解決し、未関連付けと定義の例示を区別する。信号Quality・SIMやruntime frameへ混ぜず、台帳の適用・Undoと表示を共用する。正式Faceplateと共通画面contextは後続。

機器情報表示の検証はTS1,006件（89ファイル）・Rust49件、型エラー／警告0、Clippy・Rust fmt・本番build・CLIサンプル18件が成功。新規6件と既存slot／bool文字色／状態色7件の関連ブラウザ13件が成功し、メイン・ミニマップ・埋込・小窓と台帳適用／Undoを確認した。Astra指摘のProxyを受けるcommand境界を補強し、同値no-opと履歴なしを回帰検証。両テーマのスクリーンショットは文字領域の実画素も検査した。

## 図形間の隙間の均等化

[隙間の水平／垂直均等化](../design/editor/gap-arrangement-design.md)を共通ツールバーと選択メニューへ追加した。3単位以上で両端を固定し、グループ・回転後外形・配管の矢印を考慮する。中心等間隔は維持する。負隙間は原子的に拒否し、繰返しはno-op、移動は一回のUndoとする。Projectは0.31.0のまま。

検証: TS1,014件（90ファイル）と型エラー／警告0、本番buildが成功。新規5件と既存中心等間隔6件のブラウザ11件、補償付き加算へ変更後の新規5件再確認が成功した。1,000配置の隙間0・中央修正・再適用no-op、共有定義・回転・矢印・グループ・ロック・不足空間の拒否とUndoを確認。Astraの指摘を反映し、最終レビューの必須修正なし。機器情報表示`4b02836`も[全CI](https://github.com/tyaro/temp-scada/actions/runs/39408293956)成功。

## 選択配置の配列複製

[配列複製](../design/editor/array-copy-design.md)を共通ツールバーと選択メニューへ追加した。元の組を含む行数・列数とピッチを指定し、配置数を事前表示する。独立したgroup／stateColor ID再対応、既存の参照共用、draft解決後の対象固定、入力取消と一回のUndoを共用する。連番・別機器の登録・円形配列は後続。保存契約は0.31.0のまま。

検証: TS1,021件（91ファイル）、型エラー／警告0、本番build・全体整形が成功。新規7件と既存グループ10件のブラウザ17件に加え、共有定義上限の文言を再確認した。画像asset／crop保持、機器metadata、組ごとのgroup／stateColor、埋込32件制限を超えた全体拒否・履歴保持を含む。Astraレビューの必須修正なし。両テーマの実画面を記録した。保存モデル・Rustの変更はない。隙間均等化のCIは末尾操作の期待を修正した`e92ca2c`で[全体成功](https://github.com/tyaro/temp-scada/actions/runs/39410834776)。

## 保存状態による作業領域の位置ずれ修正

保存状態とdirty件数の領域を固定し、入力の確定中にtoolbarの段数・高さが変わらないようにした。CI traceと修正前に失敗する回帰で特定し、未適用数値のblurに伴うレイヤークリック消失・resize開始失敗・範囲選択の取消を防ぐ。型・build・関連ブラウザ18件が成功。詳しい失敗と再現の条件は[履歴](../history/implementation-history.md)に記録する。

## プロパティ単体の浮動化

[初回設計・両テーマの実画面](../design/editor/inspector-floating-design.md)に従い、同じaside／form／inputを保つ右固定／浮動を追加した。操作中の入力保護・上位層優先・移動／resize取消、狭い画面への一時退避、明示保存slotと標準復元の分離を実装した。ProjectとUndoは変更しない。TS全1027件、関連ブラウザ46件、型チェック（エラー／警告なし）、本番ビルドが成功。この初回区切りでは左／下部の浮動や任意ドッキングは未実装だった。

直前の保存状態表示によるtoolbar高さ変化の修正`001e45a`は[全体CI](https://github.com/tyaro/temp-scada/actions/runs/39413669727)の成功を確認した。

## 複数配置の不透明度

[設計と両テーマの実画面](../design/graphics/selection-opacity-design.md)に従い、混在した配置のopacityを0〜100%で明示適用する。共有定義色・paint・原本・埋込先は保持し、グループとロックを含む場合は全体拒否。Undo一回、同値no-op、対象世代と複数フォームの既存入力保護を使う。関連TS76件、ブラウザは新規5件と既存色・浮動17件を確認し、型・buildが成功した。Project0.31.0は維持する。

プロパティ浮動化`f5a8e64`は[全体CI](https://github.com/tyaro/temp-scada/actions/runs/39416483652)の成功を確認した。

## 複数配置の幅・高さ

[具体設計・両テーマの実画面](../design/editor/selection-size-design.md)に従い、ローカル枠幅／高さを明示指定して各配置の中心・回転を維持する。未指定軸・参照・Imageのfit／crop等は保ち、線・グループ・ロックを含む場合は全体拒否。桁落ちによって中心を保てない極端な寸法も拒否する。関連TS45件とブラウザ16件、型・buildが成功。Project0.31.0は維持する。

不透明度一括編集`c88f790`は[全体CI](https://github.com/tyaro/temp-scada/actions/runs/39417842094)の成功を確認した。

## Textの一括文字書式

[設計と両テーマの実画面](../design/graphics/selection-text-style-design.md)に従い、Textだけの複数選択で文字サイズ・太さ・揃えを明示適用する。未指定項目と本文・タグ／slot／機器情報・bool文字色・枠寸法は保持する。異種混在・group・lockは全体拒否。関連TS15件・ブラウザ19件と最終の機器情報を含む定義選択1件、型・buildが成功。Project0.31.0を維持する。

幅／高さの統一`49fac29`は[全体CI](https://github.com/tyaro/temp-scada/actions/runs/39419117189)の成功を確認した。

## 浮動パネルの画面サイズ変更時の取消

resize通知とpointerupの順序による位置の誤確定を修正し、実window寸法の照合を追加した。[再現試験と検証記録](../design/editor/inspector-floating-design.md#画面サイズ変更と確定の競合修正)を参照する。Project・UI保存slotの形式は維持する。静的複数行Textの計算基盤`1b04755`は[全体CI](https://github.com/tyaro/temp-scada/actions/runs/39421224788)成功を確認した。計算基盤時点では保存・画面は1行だった。

## 静的Textの明示改行

[設計と両テーマの実画面](../design/graphics/multiline-text-design.md)に従い、Project0.32.0へ接続した。Enterで改行、Ctrl／Command＋Enterまたは適用で確定し、改行区切りをLFへ正規化する。空行を保ち、収容可能な先頭行と末尾の省略記号を表示する。タグ・slot・機器情報は従来の1行表示を保ち、保存した静的本文を消去しない。TS1062件、Rust50件・Clippy、型・buildとサンプル19個、既存Text9件・新規ブラウザ11件を確認した。自動折返し・任意行間・フォント選択・縁取りは後続。

浮動パネル取消の修正`ebd23cb`は[全体CI](https://github.com/tyaro/temp-scada/actions/runs/39423363080)成功を確認した。

静的Textの明示改行`e0bddca`は[全体CI](https://github.com/tyaro/temp-scada/actions/runs/39427769080)が成功した。

## 左作業パネル全体の浮動化

[設計と両テーマの実画面](../design/editor/sidebar-floating-design.md)に従い、3タブを含む同じasideを左固定／浮動へ切り替える。プロパティと操作所有者・前面順位を共有し、入力を保持して個別配置を明示保存する。プレビューと狭い画面では一時的に固定へ戻し、編集時の希望を保持する。全体配置保存・任意ドッキング・下部浮動は後続。TS1064件、型・build、関連ブラウザ20件が成功。共通化の前段`9e7e5b0`は全体CI39428835461が成功した。

小さい画面の常設メニューの[可用高・内部スクロール](../design/editor/designer-menu-viewport.md)は、Banto v6.9.0のMenuを利用する。上流#427／#430の修正を受け、局所adapterとフォーカス再試行を撤去した。保存契約やメニュー項目の機能は変えない。

## 単体開発の提供段階

I1比率固定・I2兄弟内挿入・I3静的Text折返し・I4単色paintα一括編集・I6参照名置換を提供済み。仕様・実画面・採用範囲は[文書索引](../README.md)から参照する。I5の候補評価完了は、大図面の性能改善完了を意味しない。

<details>
<summary>従来の検証節から履歴へ</summary>

| 当時の節                                                                                                              | 履歴                                                              |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| <a id="上流変更中のi1cropの比率固定"></a>上流変更中のI1：cropの比率固定                                               | [当時の記録](../history/implementation-history.md#status-note-01) |
| <a id="上流変更中のi2レイヤーの兄弟内挿入"></a>上流変更中のI2：レイヤーの兄弟内挿入                                   | [当時の記録](../history/implementation-history.md#status-note-02) |
| <a id="上流変更中のi3静的textの折返し"></a>上流変更中のI3：静的Textの折返し                                           | [当時の記録](../history/implementation-history.md#status-note-03) |
| <a id="上流変更中のi4単色塗り枠線α一括編集"></a>上流変更中のI4：単色塗り・枠線α一括編集                               | [当時の記録](../history/implementation-history.md#status-note-04) |
| <a id="i5初回混在図面の品質計測と読込の限定改善"></a>I5初回：混在図面の品質計測と読込の限定改善                       | [当時の記録](../history/implementation-history.md#status-note-05) |
| <a id="i5b進捗履歴復元の重複検証2026-10-21"></a>I5b進捗：履歴復元の重複検証（2026-10-21）                             | [当時の記録](../history/implementation-history.md#status-note-06) |
| <a id="i5c進捗project-snapshotの監視境界2026-10-21"></a>I5c進捗：Project snapshotの監視境界（2026-10-21）             | [当時の記録](../history/implementation-history.md#status-note-07) |
| <a id="i5d進捗単一行text計測の切分けと候補評価2026-10-21"></a>I5d進捗：単一行Text計測の切分けと候補評価（2026-10-21） | [当時の記録](../history/implementation-history.md#status-note-08) |

</details>

## Historianの証拠からのcoverage投影（H2b4、2026-11-01）

H2b3は[PR #19](https://github.com/tyaro/temp-scada/pull/19)でマージ済み（`b804257ac4f655aeab25bb50a1f0233245ca3af8`）、[全体CI](https://github.com/tyaro/temp-scada/actions/runs/41272492900)全7job成功。Astra主設計の[H2b4](../design/runtime/historian-coverage-projection.md)に従い、raw／minmaxと同一snapshotからsamplingMissed／storageLossを投影する。別のclosed sessionの記録可能期間、active／interruptedの開始以降を除き、untimed sessionがあれば全域unknownCoverageとする。残存欠測内にGood／無値recordがあればCorruptData。根拠のない期間はunknownCoverageを維持し、complete binや停止・expiredは生成しない。

最大256 session／1024候補gap、最終coverage256区間を制限し、超過をEvidenceLimit／CoverageLimitとして拒否する。証拠本文はparse前64 KiB、要求合計入力8 MiBを制限し、既存VM・期限・decode行・出力bytes・取消・cleanupを共有する。参照欠落をLEFT JOINで検出し、session／planと永久descriptorを型付きで照合する。

Rust workspace155件（新規単体14件・共有fixtureの統合1関数）、Clippy `-D warnings`／rustfmt、TS114ファイル・1,395件、型検査0エラー・0警告、build、関連Chromium4件が成功。実SQLiteの6成功ケースをRust／TS／ブラウザで共有し、snapshot競合、端点、上限、破損・取消後cleanupを検証した。Astraレビューで見つかった参照欠落を回帰テストで再現・修正済み。全体CIはPRで確認する。DB format 2・H1 JSON v1・依存・SDK・Project・Bantoは変更していない。H2cの保持・容量・復旧、recorder・Historyサービス・通常App接続は後続で、H2全体は継続中。

## Historianの原子trimとexpired（H2c1、2026-11-01）

H2b4は[PR #20](https://github.com/tyaro/temp-scada/pull/20)でマージ済み（`b7ee2a078357ca00000188f8845417d4e90c4754`）、[全体CI](https://github.com/tyaro/temp-scada/actions/runs/41277217468)全7job成功。Astra主設計の[H2c1](../design/runtime/historian-retention.md)に従い、active sessionがない保守時点で、明示UTC cutoff未満の全tick memberを同transactionから除去する。最大1024 tickを超えれば無変更で拒否し、CAS付きcutoff fence・実削除timestampのledger・安定receiptを原子的に保存する。削除済みtick再送は元receiptを返し、期限前の未保存tickはRetentionCutoffで拒否してsequence／frontierを進めない。

raw／minmaxは同じsnapshotの実削除時刻`[t,t+1)`だけをexpiredとして投影する。別domain／untimedがあっても、全storeの原子削除の証拠は有効。空白期間をexpiredへ補間せず、最終coverage256件と既存予算・取消・cleanupを維持する。format 3へ明示更新し、旧format 1／2は非変更で拒否する。H1 JSON v1・依存・SDK・Project・Bantoは維持。

Rust workspace174件（新規writer13単体・expired5単体・共有fixture統合1関数）、Clippy `-D warnings`／rustfmt、TS114ファイル・1,401件、型検査0エラー・0警告、build、関連Chromium5件が成功。6共有fixtureに加え、snapshot中のtrim、上限、同timestamp／無値、safe整数端点、COMMIT前後5境界のprocess終了、破損・予算・取消・panic cleanupを検証。Astraの実装整合レビューを完了した。全体CIはPRで確認する。

これはHistory query用observationsの期限除去で、再送比較用の`commits.payload_json`には値が残る。物理消去や容量問題の解決ではない。自動日次掃除・時刻跳躍検査・active recorderとの協調・大量削除の進行・receipt GC・WAL／checkpoint／disk-full運用は後続。通常App・上流・S7・実環境には接続していない。

## Historianの容量診断と明示checkpoint（H2c2、2026-11-01）

H2c1は[PR #21](https://github.com/tyaro/temp-scada/pull/21)でマージ済み（`5fe91b593d44e725b4749063c105041844a8eb37`）、[全体CI](https://github.com/tyaro/temp-scada/actions/runs/41282390503)全7job成功。Astra主設計の[H2c2](../design/runtime/historian-maintenance.md)に従い、Rust libraryにDB/WAL診断と明示PASSIVE checkpointを追加した。page数・再利用可能page・論理bytes・実file長・idleを含むreader lease数を区別して返す。SQL page値はread snapshotから取得し、filesystem値は別sampleとして扱う。

checkpointは一度だけ実行し、Complete／Incomplete／Busy／NoWalを返す。busy=0でもreader pinにより未完了となる。WAL物理長64 MiB超はMaintenanceLimitでSQL前に拒否し、診断は可能。協調取消を使うが内部I/Oの硬い期限は保証せず、成功後のlate cancellationだけで成功reportを落とさない。共通cleanup guardをmaintenanceへ集約し、取消解除→rollbackとpanic中の直接NeedsReopenをretentionでも維持する。

Rust workspace190件（新規保守15単体・snapshot競合1単体、child worker含む）、Clippy `-D warnings`／rustfmt、関連Chromium5件が成功。固定DBの事前検査、64 MiB境界、reader pinと再checkpoint、trim後のfree page、SQL/FS別sample、取消・予算・SQL failure・panic cleanup、checkpoint前後のprocess終了と再open後のreceipt／履歴を確認した。Astraレビューで見つかったmain file事前検査不足を回帰で再現・修正済み。全体CIはPRで確認する。

DB format 3・H1 JSON v1・依存・SDK・Project・Banto・TS・通常Appは変更していない。診断値はvolume空き容量や物理消去を意味せず、PASSIVEはファイル縮小を保証しない。自動保持・時刻異常・recorder協調・receipt GC・disk-full運用は後続。上流・S7・実環境には接続していない。

## H2c2のCI再オープン競合修正（2026-11-01）

同じhead `4ac4740` の[push CI](https://github.com/tyaro/temp-scada/actions/runs/41283679980)では、Rustの保守SQL障害テストがstore drop後のテスト用再openでBusyとなった。一方、[PR CI](https://github.com/tyaro/temp-scada/actions/runs/41283706313)は全job成功。64並列の反復4回目に既存の時刻付きsession試験でも同じhelperのBusyを再現したため、H2c2のcheckpoint処理だけの問題ではない。

Unixの複製lock handleを短時間保持する回帰でも即時再openの失敗を再現した。このFD寿命は並列fork→exec中のflock継承と整合するが、CIでfork起因を直接観測したとは断定しない。所有者不在を前提とする再open fixture（成功・形式／identity拒否の検証）だけをBusy限定・最大1秒の有限retryに変更した。製品のopen／排他・reader ownershipの即時拒否試験は維持する。Astraの差分レビューで必須修正はない。修正後は64並列の全Historian単体試験を10回連続で成功し、Rust workspace191件・Clippy・rustfmt・全体Prettierも成功した。修正後CIはPRで確認する。

## HistorianのSQLite容量不足と復旧（H2c3、2026-11-01）

H2c2は[PR #22](https://github.com/tyaro/temp-scada/pull/22)でマージ済み（`1295c7c0bcdb2e4d97d43cd449cbb91ac1165411`）、CI競合修正後の[全体CI](https://github.com/tyaro/temp-scada/actions/runs/41284638650)全7job成功。Astra主設計の[H2c3](../design/runtime/historian-write-failure-recovery.md)に従い、隔離DBのmax_page_countで実SQLite FULLを発生させ、保存・保持の原子性と復旧境界を検証した。

retention／maintenanceで、SQLiteエラー時に取消が立っていればFULLまでControlへ変換する不具合を再現・修正した。共通sqlite_failureはprimary OperationInterruptedだけを取消・期限・仕事量のControlへ変換し、実FULL等は元のSQL原因とNeedsReopenを維持する。新しい公開API・DB format・H1・依存は追加していない。

Rust workspace199件（新規通常書込み／証拠／trim6単体・FULLと取消併発2単体）、Clippy `-D warnings`／rustfmt、関連Chromium5件が成功。通常appendの自然増大によるFULLと、TEMP triggerによる各transaction段階の実FULLを区別し、全member・epoch・frontier・counter・ledger・fenceのrollback、既存readerのraw／minmax不変、再open後のreceiptと新session再開を確認した。trimは同requestで再試行・再送できる。retentionの取消併発はaux SQLiteの実FULLをprivate hookから注入し、本writer trimの実FULL原子性は別に検証した。Astra最終レビューに必須修正はない。全体CIはPRで確認する。

これはSQLite論理page制限の試験で、実filesystemのENOSPC・WAL／checkpointの容量障害・I/O／媒体・電源断を保証するものではない。自動保持・信頼時刻・recorder協調・大量削除・receipt GCも後続。上流・S7・実Hub／PLC／DB・通常Appには接続していない。

## Historianの永続保持jobと段階削除（H2c4、2026-11-01）

H2c3は[PR #23](https://github.com/tyaro/temp-scada/pull/23)でマージ済み（`9fb2baa14c703f95fe36170348c386097b049ebe`）、[全体CI](https://github.com/tyaro/temp-scada/actions/runs/41285704832)全7job成功。Astra主設計の[H2c4](../design/runtime/historian-retention-jobs.md)に従い、明示cutoffの永続job・連番step・状態照会を追加した。各stepは最大1024 tickと既存有限予算で全memberを原子削除する。同時刻1025 tickも1024＋1へ分割でき、再open後も同job／stepのreceiptで続行できる。

job開始は記録停止中に限り、未完了の間は新begin／新tick／単発trimを拒否する。既存receipt再送・query・診断は許可する。削除数をseries／timestampごとにstagingし、残存rawがなくなった時刻だけexpiredへ公開する。完了時に残存対象とpendingがないことを確認し、fence・job状態・step receiptを同transactionで保存する。queryは旧単発trimとjobの証拠をSQLで検証し、連続msを最大256 islandへ集約して読む。従来の1024入力点上限はこのSQL集約へ置き換え、最終coverage256区間は維持する。

format 4へ明示更新し、旧format 1／2／3は非変更拒否。H1 JSON v1・依存・SDK・Project・Bantoは維持。Rust workspace219件（job18単体・query snapshot1単体・共通fixture統合1関数を追加）、Clippy `-D warnings`／rustfmt、TS114ファイル・1,407件、型検査0エラー・0警告、build、関連Chromium6件が成功。実SQLiteの6ケースをRust／TS／ブラウザで共有し、同時刻／連続1025、部分公開、cutoff端点、FULL、予算・取消・panic、COMMIT前後5境界のprocess終了と再送、旧snapshot維持を確認した。

Astraレビューで見つかった最新step参照と過去receiptの上限検査不足を修正し、検索範囲外の最新stepも検証する回帰を追加した。最終レビューに必須修正はない。全体CIはPRで確認する。job取消による途中解放は提供せず、完了まで再開する契約である。自動保持・信頼時刻・recorder調停・receipt GC・物理容量運用は後続。通常App・上流・S7・実環境へ接続していない。

## Historianの同snapshot復旧状態とjob発見（H2c5、2026-11-01）

H2c4は[PR #24](https://github.com/tyaro/temp-scada/pull/24)でマージ済み（`4bd75d08d22880d8e30eace537df7fd84bcb3677`）、[全体CI](https://github.com/tyaro/temp-scada/actions/runs/41289139590)全7job成功。Astra主設計の[H2c5](../design/runtime/historian-recovery-state.md)に従い、Rust libraryへ`recovery_state`を追加した。job IDを保持していない再起動hostでも、同一read snapshotから現在fenceとInitial／SingleTrim／CompletedJobの出典、active記録session ID、未完了jobと直近stepの元request／receiptを取得できる。

全履歴を列挙せず、出典・active候補を小さいLIMITで取得する。jobの型付き検証と実際の最新stepを照合し、active sessionのmetadata／sequence／最新receipt header、出典重複・欠落、jobとの併存をCorruptDataとして拒否する。照会はcounter・fence・jobを変更せず、再送・新stepは既存APIで明示実行する。古い照会結果にも既存のreceipt／Conflict／Sequence規律が働く。

Rust workspace234件（新規15単体、child worker含む）、Clippy `-D warnings`／rustfmt、関連Chromium6件が成功。begin／partial／complete後のprocess終了からIDなし発見、同時刻pending、元request再送、最新出典、stale next_step、同snapshot、全write拒否下の読取、破損参照、予算・取消・SQL failure・panic cleanupを確認した。Astra最終レビューに必須修正はない。全体CIはPRで確認する。

DB format 4・H1 JSON v1・依存・SDK・Project・Banto・TS・通常Appは変更していない。snapshot位置は内部観測値で、書込みの予約やcapacity／recorder健全性の保証ではない。自動driver・自動保持・信頼時計・recorder調停・receipt GC・実媒体の容量運用は後続。上流・S7・実環境には接続していない。

## Historianの明示保持候補の時刻安全判定（H2c6、2026-11-01）

H2c5は[PR #25](https://github.com/tyaro/temp-scada/pull/25)でマージ済み（`34bf723b2f24697b3b51da438397abe3fbaf2145`）、[全体CI](https://github.com/tyaro/temp-scada/actions/runs/41290868079)成功。Astra主設計の[H2c6](../design/runtime/historian-retention-clock-guard.md)に従い、純粋関数`assess_retention`を追加した。callerの明示policy・信頼状態付きwall／monotonic sample・復旧状態・候補cutoffから、次のguard stateとactionを返す。

初回sampleはwarmupだけで、二つ目の安定sampleから評価する。時計の逆行・前進差・間隔超過、信頼喪失、policy／epoch変更、sample形式不正ではSuspendedを保持する。後続の正常sampleで自動解除せず、明示rearm後も再warmupする。正常時計でもfuture cutoff・前進上限・初回ceilingを検査し、既存job発見・NoAdvance・記録停止待ちを区別する。guard自体はDB・session・jobを変更しない。

Rust workspace256件（新規22単体、隔離DB統合4件を含む）、Clippy `-D warnings`／rustfmt、関連Chromium6件が成功。全停止理由、境界・広い算術・u64 wrap、full policy比較、不正DTO、無変更性、明示job実行と既存CAS／Busyによるstale拒否を確認した。Astra実装レビューによる累積件数検査を補強し、最終レビューに必須修正はない。全体CIはPRで確認する。

DB format 4・H1・依存・SDK・Project・Banto・TS／通常Appは維持する。proposalは実行権限・leaseではなく、実行直前の再評価が必要。信頼時計adapter、timezone／保持日数、製品policy管理、自動hostとrecorder協調、receipt GC・実媒体保守は後続。上流・S7・実環境へ接続していない。

## Historianの一回分の保持coordinator（H2c7、2026-11-01）

H2c6は[PR #26](https://github.com/tyaro/temp-scada/pull/26)でマージ済み（`7a8b5ee8cb8bfa7948289707b85bea9dc0da2530`）、[全体CI](https://github.com/tyaro/temp-scada/actions/runs/41292835540)成功。Astra主設計の[H2c7](../design/runtime/historian-retention-coordinator.md)に従い、`coordinate_retention_once`で復旧照会・時計判定と明示操作を接続した。

Observeは照会・判定だけで、Beginは今回のproposalとcanonical requestが一致した場合だけjobを開始する。ContinueExistingは同じactive jobへの正確なstep requestを一回渡し、次番号を自動選択しない。DB操作が失敗しても判定済みのnext_state／assessment／復旧snapshotを返す。InvalidInputは自動経路を止めるrearm_requiredを伴う。完了済みjobの正確なreceipt再取得は従来APIへ明示的に戻す。

Rust workspace272件（新規16単体）・Clippy `-D warnings`／rustfmt・関連Chromium6件が成功。read-only Observe、warmup／duplicate、最大一操作、記録停止待ち、ID／cutoff／fence照合、部分再送と完了発見、取消・競合・実FULL／poison時の状態保持を確認した。Astra実装レビューに必須修正はない。全体CIはPRで確認する。

DB format 4・H1・依存・SDK・Project・Banto・TS／通常Appは維持する。deadline／tokenは共通、予算カウンタは既存各API独立で最大二回分。製品policy・信頼時計・timezone／保持日数、scheduler、recorder停止／再開、receipt GC・実媒体保守は後続。通常App・上流・S7・実環境へ接続していない。

## Historianの明示duration policyとUTC cutoff（H2c8、2026-11-01）

H2c7は[PR #27](https://github.com/tyaro/temp-scada/pull/27)でマージ済み（`4fe56db877c3f43197d24df50c313a8225a907bc`）、[全体CI](https://github.com/tyaro/temp-scada/actions/runs/41294166759)成功。Astra主設計の[H2c8](../design/runtime/historian-retention-duration.md)に従い、明示elapsed durationからUTC cutoffを導出し、guard／coordinatorへ接続した。

RetentionClockPolicyに必須cutoff_ruleを追加し、durationとmodeも全snapshot比較へ含める。同revisionの短縮・延長・mode変更もPolicyChangedへ停止する。candidateはOptionとし、ExplicitCandidateはSome、ElapsedはNoneだけを受ける。安定sampleから内部計算し、範囲外ならCutoffComputationFailedを保持する。Malformed／Untrusted等の時計理由と、既存jobの固定cutoffを維持する。

Rust workspace284件（新規12単体、うち隔離DB統合5件）・Clippy `-D warnings`／rustfmt・関連Chromium6件が成功。整数境界・不正入力、mode迂回、policy変更、計算停止／rearm、記録停止→明示close→一致Begin→step、cutoff前／同値／後のrawとexpired、既存上限・job継続を確認した。Astra実装レビューに必須修正はない。全体CIはPRで確認する。

DB format 4・H1・依存・SDK・Project・Banto・TS／通常Appは維持する。Rust libraryのpolicy／candidate入力は明示変更した。elapsedの24hは暦日保持の置換ではない。ローカル暦日／timezone、製品policy適用と短縮プレビュー、信頼時計、scheduler／recorder、receipt GC・実媒体保守は後続。上流・S7・実環境には接続していない。

## Historianの保持変更の実データ影響プレビュー（H2c9、2026-11-01）

H2c8は[PR #28](https://github.com/tyaro/temp-scada/pull/28)でマージ済み（`89c46c75486f3601cc0fd5603d239d17f2cd3feb`）、[全体CI](https://github.com/tyaro/temp-scada/actions/runs/41295809874)成功。Astra主設計の[H2c9](../design/runtime/historian-retention-preview.md)に従い、明示elapsed policyの対象件数と変更差分を同snapshotで返す`preview_retention_change`を追加した。

同じ参考UTC時刻で提案・任意比較policyのcutoffを計算し、現存tick／observation／series数と時刻両端、追加対象／対象外化の半開区間をSQL集約する。無値member・同timestamp別tickを含み、既に削除済みのrawやpendingを再計上しない。active session／jobは同snapshotの復旧情報として返す。比較policyはcallerの指定値であり、永続appliedとは扱わない。

Rust workspace298件（新規14単体）・Clippy `-D warnings`／rustfmt・関連Chromium6件が成功。read-only性、全member構造・参照破損、snapshot競合、境界・差分・active／途中job、1025tick／有限SQL予算、取消・panic・SQLfailure／cleanupを確認した。AstraレビューのNUL検査を補強し、最終レビューに必須修正はない。全体CIはPRで確認する。

DB format 4・H1・依存・SDK・Project・Banto・TS／通常Appは維持する。previewは削除・適用・対象予約を行わず、全JSON内容や実行成功を保証しない。policy永続適用と期待revision、ローカル暦日／timezone、信頼時計、scheduler／recorder、receipt GC・実媒体保守は後続。上流・S7・実環境には接続していない。

## Historianの保持policy原子適用と実applied比較（H2c10、2026-11-01）

H2c9は[PR #29](https://github.com/tyaro/temp-scada/pull/29)でマージ済み（`d5e55fd6219b57fc11a6c64f47e35eaccd2b31d2`）、[全体CI](https://github.com/tyaro/temp-scada/actions/runs/41297414808)成功。Astra主設計の[H2c10](../design/runtime/historian-retention-policy-application.md)に従い、実appliedを比較基準にするpreviewと、revision／preview snapshotの両CASによる原子適用を追加した。

format 5にimmutable policy定義・適用operation／安定receipt・current pointerを保存し、復旧照会で同snapshotに復元する。同ID異内容はConflict、同内容再送は保存receiptを返し、後日のraw削除や新policy適用で過去結果を書き換えない。新規適用はactive job中に拒否し、記録中はmetadataだけを適用する。適用では削除・job開始・fence変更・guard rearmを行わない。

coordinatorの新Beginは実appliedの全文一致を要求し、job開始transaction内でも適用世代を再確認する。job列と内部canonical payloadにpolicy_applied_revisionを保存し、復旧時に照合する。Observe／既存jobの正確な継続・再送、直接保守用job／trimは維持する。

Rust workspace314件（新規16単体、child worker含む）・Clippy `-D warnings`／rustfmt・関連Chromium6件が成功。CAS、immutable定義、記録中／job中、raw削除後receipt再送、coordinator途中apply競合、容量不足・取消・panic・SQL／rollback poison、COMMIT前後5境界のprocess終了、pointer／receipt／binding破損と旧format4非変更拒否を検証した。Astra指摘の保存receipt内active jobを拒否し、最終レビューに必須修正はない。全体CIはPRで確認する。

旧format 1〜4は自動移行しない。H1・依存・SDK・Project・Banto・TS／通常Appは維持する。製品desired配布／管理認証、ローカル暦日／timezone、信頼時計adapter、scheduler／recorder、receipt GC・実媒体保守は後続。上流・S7・実環境には接続していない。

## Historianの位相固定周期recorder（H3a、2026-11-01）

H2c10は[PR #30](https://github.com/tyaro/temp-scada/pull/30)でマージ済み（`5c9fa8445c7d81877ad67247457beca53bfcc097`）、[全体CI](https://github.com/tyaro/temp-scada/actions/runs/41300113647)成功。ユーザーのS7で「1秒周期でも誤差が積み重なり1時間3600点に届かない」経験を受け、Astra主設計の[H3a](../design/runtime/historian-periodic-recorder.md)を実装した。

単調時計anchor＋n×periodの絶対deadlineで固定groupを記録し、処理完了時刻を次の基準にしない。capture直後の実UTCでslotを決め、飛ばしたslotはsamplingMissedと診断へ残す。slot・実観測・source時刻・連続保存sequenceを分け、過去slotを最新値で水増ししない。mock source／制御時計とstd時計adapterから実SQLiteへ接続する。

仮想1時間試験ではwake jitterとcapture／処理相当時間を加えても3600予定・3600観測・3600commit・missed0となった。Rust workspace330件（新規16単体）・Clippy `-D warnings`／rustfmt・関連Chromium6件が成功。境界・overrun／horizon、raw／minmaxとgap、無値／source、時計・source異常、overflow、取消、gap成功後FULLとcleanup失敗、std時計待機を確認し、Astra最終レビューに必須修正はない。全体CIはPRで確認する。

DB format 5・H1・依存・SDK・Project・Banto・TS／通常Appは維持する。専用SDK購読、計画配布・複数group・queue、永続slot台帳とgap／tick一括commit、保持との停止再開、製品History／Trendは後続。同期adapter／SQLite I/Oに硬い時間上限はなく、任意UTC正時や実S7の異なる実測3600件を保証しない。上流・S7・実環境には接続していない。

## Historianの専用SDK入力（H3b、2026-11-01）

H3aは[PR #31](https://github.com/tyaro/temp-scada/pull/31)でマージ済み（`41d5a2872294cd168d35a2eb77e8af40bd885b42`）、[全体CI](https://github.com/tyaro/temp-scada/actions/runs/41302448259)成功。Astra主設計の[H3b](../design/runtime/historian-sdk-source.md)を実装し、UIとは別の固定SDK所有者をSnapshotSourceへ接続した。

一回のcaptureでSDK状態を一度だけ参照し、同一generationのcatalog／resolution／valuesから固定group全体を投影する。一時切断は無値、catalog／run／source／identityの変更は再確認まで停止する。値側sourceを使い、SDKが公開しないsource変更を検出できたとは扱わない。記録処理をSDK executorから分離し、mock Hub→固定SDK→recorder→実SQLite→raw／minmaxを検証した。

Rust workspace347件（新規8単体・9統合）・Clippy `-D warnings`／rustfmt・関連Chromium6件が成功。Good0／false、部分／全未解決、Bad／Stale、切断／再接続、SIM／未知source、固定identity、epoch保存、UI寿命の双方向独立、Unauthorized・shutdown取消・再呼出し・Dropを確認した。Astra最終レビューに必須修正はない。全体CIはPRで確認する。

DB format 5・H1・外部依存・固定SDK・Project・Banto・TS／通常Appを維持し、runtime→historianのworkspace依存を追加した。無関係catalog変更でも初期は停止する。計画配布・複数group／queue・保持との停止再開、製品History／Trend・正式host、実媒体運用受入は後続。上流・S7・実環境には接続していない。
