# 現在の実装状況

状態: **現行実装の要約**。2026-10-22（日本時間）、Project 0.35.0。Banto基盤のローカル工程図エディタと読取表示確認を提供する。**Core v1全体・正式Runtime・SCADA serverは未完成**。

この文書を現在状況の入口とする。[統合設計](../design/scada-integrated-design.md)は目標仕様、[開発計画](development-plan.md)は今後の工程、[実装履歴](../history/implementation-history.md)は過去の仕様・検証。[リファクタリング計画](../engineering/maintenance-refactoring-plan.md)の構造整理は機能追加と分離して進める。

最新の区切り: I0〜I4の作図改善と[I6の参照名一括置換](../design/equipment/text-reference-replacement-design.md)は提供済み・全体CI成功。I5は現行版を再計測し、I5f候補を見送り、I5gで保持履歴の資産hash再抽出を限定削減した（全体CI成功）。大図面の読込・キー操作遅延は残る。[工程表と保留条件](upstream-independent-plan.md)を次の判断に使う。

I7は[Symbol内画像の段階設計](../design/images/symbol-image-design.md)に従い、I7aは全体CI成功。I7bのProject0.34.0の保存・読込・共通表示・Symbol配置の原本付きコピーも全体CI成功。I7cとして定義内への画像取込・貼付・差替え・crop／fitを完了・CI成功。

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
| タグ・Runtime  | TextのexternalName、参照一覧と全画面の差分確認・一括置換、サンプルタグ検索と型絞込、未接続表示、Rust SDK投影                                                                                                                                      | 実Hub／catalog、汎用状態条件、Host、正式RuntimeとAction境界                            |
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
