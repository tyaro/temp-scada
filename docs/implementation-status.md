# 現在の実装状況

状態: **現行実装の要約**。2026-10-20（日本時間）、Project 0.27.0。Banto基盤のローカル工程図エディタと読取表示確認を提供する。**Core v1全体・正式Runtime・SCADA serverは未完成**。

この文書を現在状況の入口とする。[統合設計](scada-integrated-design.md)は目標仕様、[開発計画](development-plan.md)は今後の工程、[実装履歴](implementation-history.md)は過去の仕様・検証。[リファクタリング計画](maintenance-refactoring-plan.md)の構造整理は機能追加と分離して進める。

## 保存契約と基盤

| 項目       | 現在の契約                                                                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| アプリ基盤 | Banto v6.7.0を固定。Svelte 5／TypeScript／Vite。認証統合は延期                                                                          |
| Project    | `schemaVersion`／`minRuntimeVersion`は**0.27.0**。TS／Rustで共通JSON Schemaと参照・幾何・予算の意味検証                                 |
| 保存       | 資産なしはJSON。PNG／JPEG原本付きは最小`.bantoscada` ZIP（`banto-scada.image-project` profile 1）。設計上の正式directory／ZIP全体は後続 |
| 旧形式     | 0.1.0のみ既存の検証付き読込経路で現行へ移行。0.2.0〜0.26.0や未知の形式は拒否。リリース前の互換性を保証しない                            |
| IDと変更   | lowercase UUID v7、有限座標、明示order。編集失敗は原子的拒否、同値はno-op、Undo／Redoでもrevisionは巻き戻さない                         |
| 所有者     | Projectは設定と参照。原本bytesはAssetStore。UI選択・倍率・draft・小窓位置はProject外。値・Qualityを保存やUndoへ入れない                 |
| 共有SDK    | industrialの固定revを使う読取投影とモックHub検証。PLC直接接続・SDKや式評価の複製はしない                                                |

## 機能の対応範囲

| 領域           | 実装した範囲                                                                                                                                     | 主な残り                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Studio         | 薄いheader、6分類メニュー、共通toolbar、ライト／ダーク／OS連動                                                                                   | 5種類の開発画面全体、外観の仕上げ                                                      |
| 左ペイン・部品 | プロジェクト／レイヤー／部品、ツリー、検索、分類、アイコン／名称、右クリック、お気に入りと連続配置、機器台帳と任意種別編集、Symbolの機器関連付け | 大規模機器一覧、グループ内部編集等                                                     |
| パネル         | 個別／一括表示と復帰、左右幅と下部高さの保存、固定標準配置の復元                                                                                 | 浮動／再ドッキング、名前付き配置、draftのDOM分離                                       |
| 共通作図       | 選択・範囲選択、移動・サイズ・回転・整列・中心等間隔、頂点、コピー／切取／貼付、Undo／Redo、幾何グループ                                         | グループ任意拡縮・入れ子、図形演算、接続口と配管追従                                   |
| 配置・レイヤー | 名前、編集ロック、静的非表示、整理フォルダー、親と所属のドラッグ変更                                                                             | 継承表示、一時非表示、フォルダーの手動順変更                                           |
| 図形・文字     | 矩形／楕円の塗り・枠線、一括編集、実線／破線／点線、配置opacityと色α、2色線形gradient、斜線／交差線／点pattern、Textの書式と揃え                 | 放射gradient、多点stop、複数行Text・縁取り、α一括                                      |
| 画像           | 原本共有、背景fit、Imageのcontain枠、比率復帰、原本付きclipboard、差し替え、配置ごとの非破壊crop                                                 | 背景crop、ドラッグcrop、Imageのcover／stretch、Symbol内画像                            |
| 画面再利用     | 同一Project・1段の読取埋込View、共有参照、参照先編集、使用中画面の削除保護、複製                                                                 | Viewのclipboard、機器context付き共通画面、独立テンプレート                             |
| 表示確認       | 画面／機器の読取Popup合計4件、前面化・移動・resize・Esc、ブラウザ全画面と終了経路                                                                | 正式Equipment Faceplate、設備操作、正式RuntimeのPopup、運用kiosk                       |
| viewport       | 画面別倍率・pan、ミニマップ、ルーラー、選択範囲表示、縦／横ホイールとCtrlズーム                                                                  | 実図面・画像／Symbol等の計測と必要な最適化                                             |
| 入力           | 数値Enter／blur、明示適用フォーム、IME、未適用入力保護、対象世代と非同期破棄                                                                     | 実catalog選択、draftのDOM分離                                                          |
| タグ・Runtime  | TextのexternalName、参照一覧、サンプルタグ検索と型絞込、未接続表示、Rust SDK投影                                                                 | 実Hub／catalog、汎用状態条件、Host、正式RuntimeとAction境界                            |
| server・監視   | 提供段階と共有層の設計                                                                                                                           | Core v1のS9b、その上のv1.1 Alarm／Event・Action／History・Trend、Camera、HTTP／Program |
| 認証・MES      | ログイン不要のローカル編集                                                                                                                       | industrialの修正後に認証再確認。ユーザー管理・運用移行・MESは未実装                    |

共有Symbolは定義と単色／定義色、独立コピー、機器関連付け、型付きslot宣言とText表示・bool状態別文字色に対応する。矩形／楕円の単色塗りとPolyline・矢印はbool Textの状態色追従に対応する。汎用状態条件・設備操作は未実装。整理フォルダーを幾何グループとして扱わない。読取プレビューから実機要求は送らない。

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

0.25.0で[読取宣言・Text割付・取得前状態の表示](symbol-read-slots.md)を追加した。共有定義はbool／numberの役割を宣言し、各配置の機器contextから未関連付け・slot欠落・型不一致・未採用・未割付・未接続をText単位で表示する。宣言とTextの追加は一回のUndo。slot単体clipboardは理由付き拒否し、未関連Symbol全体は宣言ごと保持する。TS747件・Rust45件・関連ブラウザ41件、型／Clippy／build／CLIを確認。この区切りの実値受入は後続だった。現在の表示DTO受入は次節の範囲。宣言の追加・未使用行の改名／型変更／削除は後続節で実装済み。動的配色・実Host接続は後続。

## 型付き結果の受入とGood／Quality表示

[ReadSlotViewの受入・session世代・描画](read-slot-presentation.md)を追加した。Project保存形式は0.25.0を維持する。全採用slot・型・外部名・metadataを照合し、不正入力では値を消す。旧tokenを無視し、同ID／revisionの別Projectや旧frameも表示へ流用しない。Good false／0、Bad／Staleの値消去、SIMと取得由来をメイン・埋込・小窓へ反映する。通常Designerは実Host未接続のため未接続表示を維持する。実値の検証はRust共通fixtureとブラウザテスト入力によるものであり、実Hub動作完了ではない。TS800件・Rust46件・関連ブラウザ27件、型／Clippy／build／全体整形を確認した。

## Symbolのslot宣言編集

[任意名の宣言追加・未使用行の改名／型変更／削除](symbol-slot-editing.md)を左のプロジェクト設定へ追加した。hidden／lockedを含むText参照中の変更・削除をドメインとUIで保護し、同値編集はno-op。draft・IME・対象世代・Undoへ接続した。表示追加は既存コマンドを共用し、改名の適用後に古い宣言を再作成しない。Project0.25.0を維持し、機器側のslot・外部名を自動変更しない。型0エラー／0警告・TS807件・関連ブラウザ9件・buildと両テーマの実画面を確認。動的配色・実Host接続・Faceplateは後続。

## boolの型付き状態と理由表示

[動的配色の前段](bool-slot-state.md)として、Goodだけに型付き値を持つ表示結果と、boolのtrue／false／unknownへの純粋な判定を追加した。0／1をboolへ変換せず、元Qualityと未知理由・SIM由来を分離する。返却valueの変更で受理frameが変わらない。invalid理由コードをTextのtooltip・読み上げへ伝え、Good復帰時に消す。メイン・埋込・小窓で同一mount更新を両テーマで確認した。Project0.25.0を維持し、配色の保存宣言・編集UI・図形への適用と実Hostは未実装。最終検証は型0エラー／0警告・TS834件・関連ブラウザ2件・build・全体整形。Rust／共通schemaは変更していない。

## bool Textの状態別文字色

0.26.0で[共有Symbolのbool Textに対する状態別文字色](bool-text-colors.md)を追加した。true／false／取得不能の3色を保存・編集し、配置の単色より優先する。状態・理由・SIMの文字表示と既存αは維持する。slot変更時の配色解除を同じUndoへまとめ、二重draftの競合は適用前に拒否する。TS／Rustの現行契約とサンプルを更新した。矩形・楕円・配管の動的色、実Host接続・Faceplateは後続。

この区切りは型0エラー／0警告・TS852件・Rust46件・Clippy・Rust fmt・本番build・全体整形・CLIと、関連ブラウザ11件／追加修正後4件の確認が成功。両テーマの実画面を撮影し、設計書へ掲載した。

## 図面外の読取状態表示

[メイン図面・読取小窓の折り畳み状態一覧](slot-status-summary.md)を追加した。表示参照・取得不能・SIMの件数、配置経路・機器・slot・文字／Quality／理由・由来を図面のクリップとαから独立させる。閉じた状態では行をDOMに作らず、展開時も20件ずつ表示する。可視配置と1段埋込を対象にし、hidden／α0 Textの使用参照は保持する。図形の動的配色と実Hostは今回追加していない。Project0.26.0・Rust／schemaは変更しない。

この区切りは型0エラー／0警告・TS855件・build・全体整形、状態一覧と同一mountの6件／既存小窓10件のブラウザ検証が成功。両テーマの実画面を撮影し、設計書へ掲載した。

## 共有図形の状態色追従（2026-10-20）

Project 0.27.0で、同じ定義のbool状態色Textを参照する矩形／楕円／Polylineを追加した。枠線と各図形のαを維持し、取得不能・SIMは図面外の読取状態一覧でも確認する。配色元の破壊的変更保護、参照を維持する複製、単体clipboard拒否を実装した。[仕様・検証・実画面](state-color-following.md)を参照する。

この区切りのローカル検証は型エラー／警告0、TS878件（80ファイル）、Rust47件、Clippy、CLIサンプル検証、本番build、全体整形が成功。新機能と同一mount更新のブラウザ4件は専用サーバー・1並列で両テーマ成功した。初回のlocator重複と試験データの同一参照更新を修正し、同時dirty入力の原子的拒否も確認した。Astraの読取レビューで必須修正なし。実Hub接続の検証ではない。

## 機器の読取詳細（2026-10-20）

Project 0.27.0を維持し、表示プレビューの機器検索から読取専用の小窓を開く入口を追加した。図面未使用の採用slot・未割付も表示し、機器IDを固定して既存画面小窓と同じstack・合計4件上限を共用する。20件ページング、false／0・Quality・理由・SIM・来歴を既存読取sessionから表示する。[範囲と実画面](equipment-read-details.md)。正式Faceplate・設備操作・実Hostは未実装。

この区切りは型エラー／警告0、TS896件（81ファイル）、本番buildが成功。関連ブラウザ15件を確認し、fixtureの採用状態・件数を修正した後の機器詳細3件も成功した。Astraの読取レビューに必須修正なし。追加観点の24slotページ切替・キーボードスクロールも確認済み。Rust／保存schemaは変更していない。

初回の全体CI `265f526` は390px幅の表示プレビューでtoolbar横はみ出しを検出した。他の区画は成功。狭い画面で表示モードのボタン群を折り返すよう修正し、既存workspace試験をボタンのviewport内表示確認でも補強した。ローカルで失敗を再現後、機器詳細3件とworkspace2件・buildの再検証が成功した。

選択Symbolから読取詳細へ直接移る入口を追加した。ロック中も使用でき、未関連付けは理由付き無効化。draft適用後に配置の機器IDを再取得し、適用／破棄／キャンセル／関連付け解除を保護する。非同期起動の世代・画面・mode確認と、切替後のtoolbarへのフォーカス復帰を行う。Astraレビューで必須修正なし。

直接起動の`f64180d`は[全体CI](https://github.com/tyaro/temp-scada/actions/runs/39384115268)が成功。続けて、非表示Textの再計測がResizeObserver通知中にSVGを更新する警告を修正した。再計測は次の描画フレームへ集約し、破棄時には予約を取り消す。実ブラウザの警告を再現後、同じ操作で0件になることを確認した。機器入口・Text書式のブラウザ13件、型エラー／警告0、TS896件、buildが成功。

## 機器種別のDesigner編集

既存0.27.0契約のまま、機器台帳を一覧／種別の切替式にし、任意bool／numberの読取slotを作成・変更・削除できる入口を追加した。採用数と未割付を含む保護、構造draft、一回の適用／Undoを実装。[仕様と実画面](equipment-type-editing.md)。実catalogや正式設備テンプレートは後続。

この区切りは型エラー／警告0、TS906件（82ファイル）、本番buildが成功。関連ブラウザ12件の範囲を確認し、最終の種別編集5件も専用サーバー・1並列で成功。Astraレビューの末尾改行の指摘をフォーム検証へ反映し、禁止文字の回帰を追加した。構造変更は同期的にdirtyへ反映し、直後の移動でも入力を落とさない。ライト／ダークの実画面を撮影した。文字の再計測修正`e5158e9`も[全体CI](https://github.com/tyaro/temp-scada/actions/runs/39384957602)が成功した。

機器台帳へ番号・名前・種別名の検索と20件ページ表示を追加した。全角英数字と英字の大小を吸収する。結果外の機器も編集中の入力を保持し、対象切替のみ既存draft確認を使う。55件のページ境界・検索・保存不変と既存台帳の関連ブラウザ6件、型エラー／警告0を確認した。

機器種別の編集`5b5f53f`は[全体CI](https://github.com/tyaro/temp-scada/actions/runs/39387107106)が成功した。検索・ページ表示の本番buildも成功し、保存契約は0.27.0のまま。

## 読取詳細から機器の配置へ移動

機器小窓に全画面の使用先一覧と20件ずつのページ表示を追加し、既存の使用先選択へ接続した。編集へ戻る際に小窓を閉じ、別画面・非表示／ロック・グループの選択を扱う。表示／ロックと保存内容・Undoは変更しない。[範囲・実画面](equipment-read-details.md)。台帳検索`adc1b08`の[全体CI](https://github.com/tyaro/temp-scada/actions/runs/39387797784)も成功した。

この区切りは型エラー／警告0、TS906件（82ファイル）、本番buildが成功。関連ブラウザ7件で両テーマ・グループと保存不変を確認した。Astraの静的レビューに必須修正なし。ライト／ダークの実画面も更新した。Rust／schemaは変更していない。

## 既存機器を元に別の機器を登録

既存の種別・採用slotを引き継ぎ、外部名をすべて未割付として新しい番号で登録できる。図面配置・元機器・共有種別を変更せず、作成一回をUndo／Redoできる。元機器と登録中の入力保護も維持する。[仕様と実画面](equipment-register-design.md)。読取詳細の図面使用先`f33d661`は[全体CI](https://github.com/tyaro/temp-scada/actions/runs/39388959155)が成功した。

この区切りは型エラー／警告0、TS906件、関連ブラウザ8件と本番buildが成功。Astra指摘の遅延時の元ID喪失を修正し、適用して元機器へ戻る経路も確認した。Undoで内容は戻し、Project revisionは単調増加を維持する。両テーマの実画面と設計を更新した。Rust／schemaは変更していない。

## Symbolと機器の関連付け候補の確認

未適用のSymbol／機器候補に対して、実使用slotの保存設定を確認できる。hidden Textも含め、未使用宣言は別に集計する。不足・型違い・未採用・未割付と「外部名あり・catalog未確認」を表示し、候補を自動変更しない。[仕様と実画面](symbol-equipment-check.md)。型エラー／警告0、TS909件（83ファイル）、関連ブラウザ8件・buildが成功。Astraレビューに必須修正なし。両テーマ・両候補の変更順・キャンセル／破棄／適用／Undo・ロック・24slotページ境界を確認した。Rust／保存schemaは変更していない。

別機器登録`8af2377`の[全体CI](https://github.com/tyaro/temp-scada/actions/runs/39389952118)も成功した。industrial #682は再確認時もOPENで、実Host接続の上流契約待ちを維持する。

## 選択Symbolから機器台帳への直接移動

プロパティの明示ボタンから対象機器の台帳設定を開く。未適用入力を解決後に機器IDを再取得し、検索を維持して機器一覧へ切り替える。非表示の左パネルと閉じた機器ツリーを復帰し、ロック配置からも共有台帳へ進める。[範囲](equipment-symbol-association.md)。移動自体は保存内容・履歴を変更しない。

型エラー／警告0、TS909件、関連ブラウザ9件・本番buildが成功。両テーマのpanel／種別表示復帰、機器割付と別台帳のdraft保護、関連付け解除と保存不変を確認した。Astraレビューに必須修正なし。Rust／保存schemaは変更していない。

## 機器設定・読取詳細の右クリック入口

キャンバスとレイヤーの単一Symbolから、台帳設定と読取詳細を開ける。プロパティ非表示・配置ロック中にも利用でき、レイヤーのShift＋F10も共用する。未関連付けは無効、複数選択・定義内部では単一機器の操作を表示しない。

型エラー／警告0、TS909件とbuildが成功。既存選択メニュー12件と機器メニュー4件を確認した。最初のcanvas試験は図形の上にある正規hit領域へ内部polylineのクリックが遮られたため、実際の配置hit領域をクリックする試験へ修正し、4件の再検証が成功した。アプリ側でforceクリックやhit領域の変更は行わない。保存契約は維持する。

候補確認`386e636`の[全体CI](https://github.com/tyaro/temp-scada/actions/runs/39390905952)と、台帳への直接移動`3c01b22`の[全体CI](https://github.com/tyaro/temp-scada/actions/runs/39391528579)も成功した。
