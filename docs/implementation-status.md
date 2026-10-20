# 現在の実装状況

状態: **現行実装の要約**。2026-10-20（日本時間）、Project 0.25.0。Banto基盤のローカル工程図エディタと読取表示確認を提供する。**Core v1全体・正式Runtime・SCADA serverは未完成**。

この文書を現在状況の入口とする。[統合設計](scada-integrated-design.md)は目標仕様、[開発計画](development-plan.md)は今後の工程、[実装履歴](implementation-history.md)は過去の仕様・検証。[リファクタリング計画](maintenance-refactoring-plan.md)の構造整理は機能追加と分離して進める。

## 保存契約と基盤

| 項目       | 現在の契約                                                                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| アプリ基盤 | Banto v6.7.0を固定。Svelte 5／TypeScript／Vite。認証統合は延期                                                                          |
| Project    | `schemaVersion`／`minRuntimeVersion`は**0.25.0**。TS／Rustで共通JSON Schemaと参照・幾何・予算の意味検証                                 |
| 保存       | 資産なしはJSON。PNG／JPEG原本付きは最小`.bantoscada` ZIP（`banto-scada.image-project` profile 1）。設計上の正式directory／ZIP全体は後続 |
| 旧形式     | 0.1.0のみ既存の検証付き読込経路で現行へ移行。0.2.0〜0.24.0や未知の形式は拒否。リリース前の互換性を保証しない                            |
| IDと変更   | lowercase UUID v7、有限座標、明示order。編集失敗は原子的拒否、同値はno-op、Undo／Redoでもrevisionは巻き戻さない                         |
| 所有者     | Projectは設定と参照。原本bytesはAssetStore。UI選択・倍率・draft・小窓位置はProject外。値・Qualityを保存やUndoへ入れない                 |
| 共有SDK    | industrialの固定revを使う読取投影とモックHub検証。PLC直接接続・SDKや式評価の複製はしない                                                |

## 機能の対応範囲

| 領域           | 実装した範囲                                                                                                                           | 主な残り                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Studio         | 薄いheader、6分類メニュー、共通toolbar、ライト／ダーク／OS連動                                                                         | 5種類の開発画面全体、外観の仕上げ                                                      |
| 左ペイン・部品 | プロジェクト／レイヤー／部品、ツリー、検索、分類、アイコン／名称、右クリック、お気に入りと連続配置、初期機器台帳、Symbolの機器関連付け | 大規模機器一覧、グループ内部編集等                                                     |
| パネル         | 個別／一括表示と復帰、左右幅と下部高さの保存、固定標準配置の復元                                                                       | 浮動／再ドッキング、名前付き配置、draftのDOM分離                                       |
| 共通作図       | 選択・範囲選択、移動・サイズ・回転・整列・中心等間隔、頂点、コピー／切取／貼付、Undo／Redo、幾何グループ                               | グループ任意拡縮・入れ子、図形演算、接続口と配管追従                                   |
| 配置・レイヤー | 名前、編集ロック、静的非表示、整理フォルダー、親と所属のドラッグ変更                                                                   | 継承表示、一時非表示、フォルダーの手動順変更                                           |
| 図形・文字     | 矩形／楕円の塗り・枠線、一括編集、実線／破線／点線、配置opacityと色α、2色線形gradient、斜線／交差線／点pattern、Textの書式と揃え       | 放射gradient、多点stop、複数行Text・縁取り、α一括                                      |
| 画像           | 原本共有、背景fit、Imageのcontain枠、比率復帰、原本付きclipboard、差し替え、配置ごとの非破壊crop                                       | 背景crop、ドラッグcrop、Imageのcover／stretch、Symbol内画像                            |
| 画面再利用     | 同一Project・1段の読取埋込View、共有参照、参照先編集、使用中画面の削除保護、複製                                                       | Viewのclipboard、機器context付き共通画面、独立テンプレート                             |
| 表示確認       | 同一Projectの読取Popup最大4件、前面化・移動・resize・Esc、ブラウザ全画面と終了経路                                                     | Equipment Faceplate、設備操作、正式RuntimeのPopup、運用kiosk                           |
| viewport       | 画面別倍率・pan、ミニマップ、ルーラー、選択範囲表示、縦／横ホイールとCtrlズーム                                                        | 実図面・画像／Symbol等の計測と必要な最適化                                             |
| 入力           | 数値Enter／blur、明示適用フォーム、IME、未適用入力保護、対象世代と非同期破棄                                                           | 実catalog選択、draftのDOM分離                                                          |
| タグ・Runtime  | TextのexternalName、参照一覧、サンプルタグ検索と型絞込、未接続表示、Rust SDK投影                                                       | 実Hub／catalog、slotの図面表示、Host、正式RuntimeとAction境界                          |
| server・監視   | 提供段階と共有層の設計                                                                                                                 | Core v1のS9b、その上のv1.1 Alarm／Event・Action／History・Trend、Camera、HTTP／Program |
| 認証・MES      | ログイン不要のローカル編集                                                                                                             | industrialの修正後に認証再確認。ユーザー管理・運用移行・MESは未実装                    |

共有Symbolは静的な定義と単色／定義色、独立コピーに対応する。状態別表示・機器slotを使うSymbol・Binding付きSymbolは未実装。整理フォルダーを幾何グループとして扱わない。読取プレビューから実機要求は送らない。

## 検証の範囲

R5a〜R5fで編集コマンド型・分類とProject／Symbol／Screen／Folder／Image／Objectのhandlerを分離した。最新のR5fは型チェック（エラー／警告なし）、TS全637件、全ブラウザ509件、Rust30件・Clippy・CLIサンプル3件、本番ビルド・全体整形が成功。全ブラウザは専用サーバー・2並列の一度の実行ですべて通過した。分類漏れ・誤分類と、分類後のhandler未実装を型エラーで検出することも一時変更で確認した。未知runtimeコマンドをProject／履歴を保って拒否する契約テスト1件を追加した。各区切りの詳細は[R5の記録](maintenance-refactoring-plan.md#r5a-command-types)を参照する。最終差分のCIも成功し、R0〜R5の構造整理を完了した。[R6の性能計測と候補コピーの限定改善](editor-performance.md)を追加した。同じparserによる入力拒否を維持して重複を減らし、TS641件・関連ブラウザ30件・型・build・全体整形が成功。5,000配置の編集中央値は同環境の計測で約251→197ms、履歴付きは約311→250ms。小規模では揺れがあり、ブラウザ応答時間の保証や履歴のメモリ最適化完了を示すものではない。R6と次工程設計`9b19048`までの[全体CI](https://github.com/tyaro/temp-scada/actions/runs/39341399005)も成功した。

全体CIは幾何グループのDesigner接続を含む`fdea3df`まで[成功を確認済み](https://github.com/tyaro/temp-scada/actions/runs/39348714448)。全ブラウザ521件と型・TS単体676件・ビルド・整形・Rust31件・Clippy・CLIサンプル検証を通過した。R4のローカル4並列での496件成功／13件失敗と、同一コードでの単独再確認13件成功、既存サーバーでの途中停止は[R4eの記録](maintenance-refactoring-plan.md#r4e-actions)に保持する。

保存契約・画面配置・Undo単位は維持した。R4dの両テーマ・2画面幅の比較画像8枚は移動前後でpixel完全一致。R4eとR5a〜R5fは画面markup／CSSに変更なし。既存のJS bundle 500kB警告は継続する。

過去のプレビューfit測定の失敗と、テスト側のレイアウト待機修正は[R0の記録](maintenance-refactoring-plan.md#refactoring-progress)を参照する。

## 仕様・実画面への入口

- 画像: [保存](image-assets-design.md)、[配置と差し替え](image-placement-design.md)、[clipboard](image-clipboard-design.md)、[cropと実画面](image-crop-design.md)。
- 描画: [塗りと線](shape-paint-design.md)、[線形gradient](linear-gradient-design.md)、[pattern](pattern-paint-design.md)、[α](color-alpha-design.md)。
- 再利用: [共有Symbol](symbol-color-design.md)、[埋込View](embedded-screen-design.md)、[Popup](preview-popup-design.md)、[全画面](preview-fullscreen-design.md)。
- 操作と構想: [UX設計](frontend-ux-design.md)、[UI改訂](designer-ui-revision.md)、[機器作成の追加提案](equipment-authoring-detail-proposal.md)。

## 幾何グループの実装段階

[初回設計](geometric-groups-design.md)に沿い、G1／G2の保存・ドメイン・再利用とG3 Designer接続を実装した。0.22.0でScreenのgroups、所属・描画順・参照の共通検証、作成／解除／名前／一括移動・90度回転／状態／整列・描画順、複製・削除・画面複製・clipboard v3を追加した。TS／Rust共通の不正ケースと、原子性・Undo・再採番を検証する。

Designerはグループ単位の選択・レイヤー行・toolbar／メニュー／右クリック・キー・Inspectorへ接続済み。G4の全体ブラウザ521件と実画面の確認も完了した。内部の部分編集はドメインで拒否し、既存v1／v2 clipboardでgroup情報を失わせない。任意拡縮・入れ子・Symbol定義内グループは後続。ローカルで型（エラー／警告なし）・TS671件・Rust31件・Clippy・関連ブラウザ23件が成功。ブラウザではgroup付きファイル往復・native v3コピー／貼付・Undoも確認した。AstraレビューのProxyコピー、実効状態no-op、Unicode名長の指摘は修正し回帰テストを追加した。G1〜G4の全体CIも成功した。

G3の型（エラー／警告なし）・TS676件、新機能の関連ブラウザ12件が成功。F2の子選択への崩れ、改名Undo後のdraft、IME、Symbol使用先の遅延ガード、非表示時の選択解除はAstraレビューに基づいて修正し、実ブラウザで確認した。

最終の全ブラウザ521件は専用サーバー・2並列の一度の実行ですべて成功した。ライト／ダーク1920×1080の[実画面](geometric-groups-design.md#geometric-groups-screenshots)を撮影し、同じ配置をグループ化した場合と独立配置の場合のプレビュー画素が両テーマで完全一致した。撮影後のプロパティ外観調整も関連12件と型（エラー／警告なし）・buildで再確認した。全体整形と変更文書のローカルリンク284件も成功。

## 型付き読取slotの前段

[表示用adapter](typed-read-slots-design.md)へbool／numberと構造化した機器／slot keyを追加した。外部名の重複要求を集約し、未割付・未接続・未解決・型不一致・Qualityを区別する。既存数値Textと同じ検証処理を共有し、Rust40件・Clippy・Rust fmt、TS676件・全体整形が成功。Astraレビューと別正常タグの局所成功も確認した。この先行区切りではProject0.22.0・UI・固定SDK revは変更していない。現在のEquipment保存は次節の範囲。Equipmentの保存・台帳UI、動的Symbol、Host、実Hub接続の完成ではない。

## Equipmentの保存と初期台帳

0.23.0で[機器種別・Instance・採用read slot](equipment-register-design.md)の保存とTS／Rust検証、原子的CRUDを実装した。プロジェクトツリーの「機器」から読取種別の追加・登録・割付・削除を行い、draft保護とUndoへ接続する。未採用と採用未割付を区別し、使用中種別の削除と採用slotの破壊的変更を拒否する。ProjectからReadSlotPlanへ接続した。TS715件・Rust43件・関連ブラウザ24件・型／Clippy／buildが成功。図面との機器参照、動的Symbol、実catalog・Host、正式Runtimeは後続。

## CIの並列化

[実装と実測](ci-acceleration-results.md)に沿い、frontend／Rust／E2E4shardを並行実行し、従来のcheckへ集約した。アプリ・テストを変えず、同じ526件で旧CI15分54秒→4分25秒／4分31秒、連続2回とも全体成功。Equipmentの保存・初期台帳までを含む型・TS715件・Rust43件とサンプル検証もCIで成功した。従来型のブランチ保護APIは403で読取不可のため、必須チェック設定全体は未確認。保護設定は変更していない。

## 機器とSymbol配置の関連付け

0.24.0で[関連付け・全画面の使用先・削除保護](equipment-symbol-association.md)を追加した。同じ機器を複数配置で参照し、複製・画面複製でも割付を共有する。共有定義へは機器を埋め込まない。機器付きclipboardは明示拒否。TS728件・Rust44件・関連ブラウザ23件、型／Clippy／buildが成功。静的関連付けまでで、型付きslotの動的描画・実値表示は後続。

## Symbolの読取slotと割付状態

0.25.0で[読取宣言・Text割付・取得前状態の表示](symbol-read-slots.md)を追加した。共有定義はbool／numberの役割を宣言し、各配置の機器contextから未関連付け・slot欠落・型不一致・未採用・未割付・未接続をText単位で表示する。宣言とTextの追加は一回のUndo。slot単体clipboardは理由付き拒否し、未関連Symbol全体は宣言ごと保持する。TS747件・Rust45件・関連ブラウザ41件、型／Clippy／build／CLIを確認。この区切りの実値受入は後続だった。現在の表示DTO受入は次節の範囲。宣言の自由編集・改名／削除、動的配色・実Host接続は後続。

## 型付き結果の受入とGood／Quality表示

[ReadSlotViewの受入・session世代・描画](read-slot-presentation.md)を追加した。Project保存形式は0.25.0を維持する。全採用slot・型・外部名・metadataを照合し、不正入力では値を消す。旧tokenを無視し、同ID／revisionの別Projectや旧frameも表示へ流用しない。Good false／0、Bad／Staleの値消去、SIMと取得由来をメイン・埋込・小窓へ反映する。通常Designerは実Host未接続のため未接続表示を維持する。実値の検証はRust共通fixtureとブラウザテスト入力によるものであり、実Hub動作完了ではない。TS800件・Rust46件・関連ブラウザ27件、型／Clippy／build／全体整形を確認した。

## Symbolのslot宣言編集

[任意名の宣言追加・未使用行の改名／型変更／削除](symbol-slot-editing.md)を左のプロジェクト設定へ追加した。hidden／lockedを含むText参照中の変更・削除をドメインとUIで保護し、同値編集はno-op。draft・IME・対象世代・Undoへ接続した。表示追加は既存コマンドを共用し、改名の適用後に古い宣言を再作成しない。Project0.25.0を維持し、機器側のslot・外部名を自動変更しない。型0エラー／0警告・TS807件・関連ブラウザ9件・buildと両テーマの実画面を確認。動的配色・実Host接続・Faceplateは後続。
