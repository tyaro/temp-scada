# 現在の実装状況

状態: **現行実装の要約**。2026-10-20（日本時間）、機能の照合基準は`e04e44c`。Banto基盤のローカル工程図エディタと読取表示確認を提供する。**Core v1全体・正式Runtime・SCADA serverは未完成**。

この文書を現在状況の入口とする。[統合設計](scada-integrated-design.md)は目標仕様、[開発計画](development-plan.md)は今後の工程、[実装履歴](implementation-history.md)は過去の仕様・検証。[リファクタリング計画](maintenance-refactoring-plan.md)の構造整理は機能追加と分離して進める。

## 保存契約と基盤

| 項目       | 現在の契約                                                                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| アプリ基盤 | Banto v6.7.0を固定。Svelte 5／TypeScript／Vite。認証統合は延期                                                                          |
| Project    | `schemaVersion`／`minRuntimeVersion`は**0.21.0**。TS／Rustで共通JSON Schemaと参照・幾何・予算の意味検証                                 |
| 保存       | 資産なしはJSON。PNG／JPEG原本付きは最小`.bantoscada` ZIP（`banto-scada.image-project` profile 1）。設計上の正式directory／ZIP全体は後続 |
| 旧形式     | 0.1.0のみ既存の検証付き読込経路で現行へ移行。0.2.0〜0.20.0や未知の形式は拒否。リリース前の互換性を保証しない                            |
| IDと変更   | lowercase UUID v7、有限座標、明示order。編集失敗は原子的拒否、同値はno-op、Undo／Redoでもrevisionは巻き戻さない                         |
| 所有者     | Projectは設定と参照。原本bytesはAssetStore。UI選択・倍率・draft・小窓位置はProject外。値・Qualityを保存やUndoへ入れない                 |
| 共有SDK    | industrialの固定revを使う読取投影とモックHub検証。PLC直接接続・SDKや式評価の複製はしない                                                |

## 機能の対応範囲

| 領域           | 実装した範囲                                                                                                                     | 主な残り                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Studio         | 薄いheader、6分類メニュー、共通toolbar、ライト／ダーク／OS連動                                                                   | 5種類の開発画面全体、外観の仕上げ                                                      |
| 左ペイン・部品 | プロジェクト／レイヤー／部品、ツリー、検索、分類、アイコン／名称、右クリック、お気に入りと連続配置                               | 機器台帳、幾何グループ等                                                               |
| パネル         | 個別／一括表示と復帰、左右幅と下部高さの保存、固定標準配置の復元                                                                 | 浮動／再ドッキング、名前付き配置、draftのDOM分離                                       |
| 共通作図       | 選択・範囲選択、移動・サイズ・回転・整列・中心等間隔、頂点、コピー／切取／貼付、Undo／Redo                                       | 幾何グループ、図形演算、接続口と配管追従                                               |
| 配置・レイヤー | 名前、編集ロック、静的非表示、整理フォルダー、親と所属のドラッグ変更                                                             | 継承表示、一時非表示、フォルダーの手動順変更                                           |
| 図形・文字     | 矩形／楕円の塗り・枠線、一括編集、実線／破線／点線、配置opacityと色α、2色線形gradient、斜線／交差線／点pattern、Textの書式と揃え | 放射gradient、多点stop、複数行Text・縁取り、α一括                                      |
| 画像           | 原本共有、背景fit、Imageのcontain枠、比率復帰、原本付きclipboard、差し替え、配置ごとの非破壊crop                                 | 背景crop、ドラッグcrop、Imageのcover／stretch、Symbol内画像                            |
| 画面再利用     | 同一Project・1段の読取埋込View、共有参照、参照先編集、使用中画面の削除保護、複製                                                 | Viewのclipboard、機器context付き共通画面、独立テンプレート                             |
| 表示確認       | 同一Projectの読取Popup最大4件、前面化・移動・resize・Esc、ブラウザ全画面と終了経路                                               | Equipment Faceplate、設備操作、正式RuntimeのPopup、運用kiosk                           |
| viewport       | 画面別倍率・pan、ミニマップ、ルーラー、選択範囲表示、縦／横ホイールとCtrlズーム                                                  | 大規模図面の性能計測と必要な最適化                                                     |
| 入力           | 数値Enter／blur、明示適用フォーム、IME、未適用入力保護、対象世代と非同期破棄                                                     | 実catalog選択、draftのDOM分離                                                          |
| タグ・Runtime  | TextのexternalName、参照一覧、サンプルタグ検索と型絞込、未接続表示、Rust SDK投影                                                 | 実Hub／catalog、型付きslot、Host、正式RuntimeとAction境界                              |
| server・監視   | 提供段階と共有層の設計                                                                                                           | Core v1のS9b、その上のv1.1 Alarm／Event・Action／History・Trend、Camera、HTTP／Program |
| 認証・MES      | ログイン不要のローカル編集                                                                                                       | industrialの修正後に認証再確認。ユーザー管理・運用移行・MESは未実装                    |

共有Symbolは静的な定義と単色／定義色、独立コピーに対応する。状態別表示・機器slot・Binding付きSymbolは未実装。整理フォルダーを幾何グループとして扱わない。読取プレビューから実機要求は送らない。

## 検証の範囲

R5a〜R5eで編集コマンド型・分類、Project／Symbol／Screen／Folder／Image handlerを分離した。最新のR5eは型チェック（エラー／警告なし）、TS全636件、関連ブラウザ24件、本番ビルド・全体整形が成功。分類漏れ・誤分類と、分類後のhandler未実装を型エラーで検出することも一時変更で確認した。各区切りと検証対象は[R5の記録](maintenance-refactoring-plan.md#r5a-command-types)を参照する。Objectと入口全体の網羅性は後続で、R5全体の完了ではない。

全体CIはR5cの`f02ca65`まで[成功を確認済み](https://github.com/tyaro/temp-scada/actions/runs/39332935722)。全ブラウザ509件と型・TS単体・ビルド・整形・Rust30件・Clippy・CLIサンプル検証を通過した。R5d以後の差分はPush後のCI結果と区別する。R4のローカル4並列での496件成功／13件失敗と、同一コードでの単独再確認13件成功、既存サーバーでの途中停止は[R4eの記録](maintenance-refactoring-plan.md#r4e-actions)に保持する。

保存契約・画面配置・Undo単位は維持した。R4dの両テーマ・2画面幅の比較画像8枚は移動前後でpixel完全一致。R4eとR5a〜R5eは画面markup／CSSに変更なし。既存のJS bundle 500kB警告は継続する。

過去のプレビューfit測定の失敗と、テスト側のレイアウト待機修正は[R0の記録](maintenance-refactoring-plan.md#refactoring-progress)を参照する。

## 仕様・実画面への入口

- 画像: [保存](image-assets-design.md)、[配置と差し替え](image-placement-design.md)、[clipboard](image-clipboard-design.md)、[cropと実画面](image-crop-design.md)。
- 描画: [塗りと線](shape-paint-design.md)、[線形gradient](linear-gradient-design.md)、[pattern](pattern-paint-design.md)、[α](color-alpha-design.md)。
- 再利用: [共有Symbol](symbol-color-design.md)、[埋込View](embedded-screen-design.md)、[Popup](preview-popup-design.md)、[全画面](preview-fullscreen-design.md)。
- 操作と構想: [UX設計](frontend-ux-design.md)、[UI改訂](designer-ui-revision.md)、[機器作成の追加提案](equipment-authoring-detail-proposal.md)。
