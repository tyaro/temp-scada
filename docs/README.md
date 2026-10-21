# ドキュメント索引

2026-10-21（日本時間）更新。機能仕様・現在の提供範囲・今後の工程・過去の記録を分けて読む。起動・ツールの導入・検証コマンドは[リポジトリREADME](../README.md)に置く。

## 目的別の入口

| 確認すること             | 正とする文書                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| 目標仕様・提供段階       | [統合設計](scada-integrated-design.md)。S9bはCore v1のserver基盤。v1.1のAlarm／Event／History／Trendはその上に追加 |
| 今使える機能・残り       | [実装状況](implementation-status.md)。正式Runtime・serverは未完成                                                  |
| 次の判断・上流待ち・統合 | [開発計画](development-plan.md)と[単体開発工程表](upstream-independent-plan.md)                                    |
| 操作・ショートカット     | [操作ガイド](user-guide.md)                                                                                        |
| コード・責務・関連テスト | [コード対応表](code-map.md)                                                                                        |
| 過去の仕様・実装・検証   | [実装履歴](implementation-history.md)。当時の「次は」「未実装」を現在情報として読まない                            |
| 構造整理の不変条件・結果 | [リファクタリング計画](maintenance-refactoring-plan.md)                                                            |

## 文書の読み方・更新先

- 採用済みの目標仕様と、各機能の実装段階は別。個別の採用設計・未採用提案・当時の実装記録は文頭の状態を確認する。
- 新機能は個別設計に対象・除外・不変条件・受入を置き、完了したら実装状況と工程表を更新する。次の判断は開発計画、日付付きの経緯・件数・CI結果は履歴または各機能の検証記録へ置く。
- 状況の入口に古いCI件数や「次工程」を継ぎ足さない。完了した工程を次の着手対象として残さない。新しい文書はこの索引へ登録する。
- 画像は各設計書の相対リンクから参照する。[assets/frontend-ux](assets/frontend-ux/)は実画面、[performance](performance/)は計測・候補再現資産。画像や生データの存在だけで機能完了・性能保証とはしない。
- `upstream/industrial`は固定commitの参照スナップショットで編集しない。上流の状態とSCADA側の実装状況を区別する。

## 機能別の資料

以下は分類索引。分類は実装済みを意味しない。現在の採用範囲は各文書の状態と実装状況を確認する。

### 画面・操作設計

- [SCADA フロントエンド UX 設計](frontend-ux-design.md)
- [SCADA Designer UI 改訂提案](designer-ui-revision.md)
- [サイドチャット試作の Designer 適用レビュー](prototype-design-review.md)
- [Designerメニューの可用高さとスクロール](designer-menu-viewport.md)
- [プロパティパネルの浮動化・初回設計](inspector-floating-design.md)
- [左作業パネルの浮動配置](sidebar-floating-design.md)

### 作図・レイヤー・一括編集

- [選択配置の配列複製](array-copy-design.md)
- [レイヤーフォルダーのドラッグによる親変更](folder-drag-design.md)
- [図形間の隙間の均等化](gap-arrangement-design.md)
- [幾何グループ：初回の実装設計](geometric-groups-design.md)
- [レイヤー配置のドラッグによる所属変更](layer-drag-design.md)
- [レイヤーフォルダーの設計](layer-folders-design.md)
- [レイヤーの兄弟内挿入](layer-relative-order-design.md)
- [配置の回転（次の実装工程）](object-rotation-design.md)
- [複数配置の幅・高さを統一する](selection-size-design.md)
- [選択範囲の表示](selection-view-design.md)
- [矩形・楕円の枠線の一括編集](selection-outline-design.md)

### 文字・線・塗り

- [bool slot表示Textの状態別文字色](bool-text-colors.md)
- [単色と枠線のα](color-alpha-design.md)
- [実線・破線・点線](line-style-design.md)
- [矩形・楕円の2色線形グラデーション](linear-gradient-design.md)
- [静的Textの明示改行](multiline-text-design.md)
- [配置全体の不透明度](opacity-design.md)
- [矩形・楕円の繰返しパターン](pattern-paint-design.md)
- [2色の放射グラデーション](radial-gradient-design.md)
- [複数配置の不透明度](selection-opacity-design.md)
- [単色塗り・枠線のα一括編集](selection-paint-alpha-design.md)
- [Text配置の文字書式を一括編集する](selection-text-style-design.md)
- [矩形・楕円の塗りと枠線](shape-paint-design.md)
- [静的Textの枠幅での折返し](static-text-wrap-design.md)
- [共有Symbolの静的な配色](symbol-color-design.md)
- [Textの基本書式と枠内表示](text-style-design.md)

### 画像・画面再利用

- [共有Symbol内の静止画像：段階設計](symbol-image-design.md)

- [背景画像の数値トリミング](background-image-crop-design.md)
- [別画面を表示する埋込View](embedded-screen-design.md)
- [画像資産と背景画像の最小保存基盤](image-assets-design.md)
- [画像の貼り付けと原本を含む図形clipboard](image-clipboard-design.md)
- [原本プレビューのトリミング比率固定](image-crop-aspect-design.md)
- [配置画像の非破壊トリミング](image-crop-design.md)
- [原本プレビュー上のトリミング操作](image-crop-pointer-design.md)
- [配置画像の表示方式](image-fit-design.md)
- [画面へ配置するImageの最初の範囲](image-placement-design.md)
- [ブラウザ全画面での表示確認](preview-fullscreen-design.md)
- [プレビュー専用の画面内Popup](preview-popup-design.md)
- [埋込画面のコピーと貼り付け](screen-view-clipboard-design.md)

### 機器・タグ・読取境界

- [bool slotの状態判定と動的配色への接続](bool-slot-state.md)
- [共有シンボル内の機器情報表示](equipment-property-design.md)
- [機器の読取詳細](equipment-read-details.md)
- [Equipmentの保存契約と初期台帳](equipment-register-design.md)
- [Symbol配置と機器の関連付け](equipment-symbol-association.md)
- [機器種別と任意の読取slotの編集](equipment-type-editing.md)
- [型付き読取結果の受入とSymbol表示](read-slot-presentation.md)
- [Runtime の SDK 投影境界](runtime-sdk.md)
- [図面外の読取状態表示](slot-status-summary.md)
- [共有Symbolの図形・配管の状態色追従](state-color-following.md)
- [Symbolと機器の関連付け候補の確認](symbol-equipment-check.md)
- [共有Symbolの読取slotと割付状態表示](symbol-read-slots.md)
- [共有Symbolのslot宣言編集](symbol-slot-editing.md)
- [読み取りタグ Binding の初期契約](tag-binding.md)
- [I6：ローカルProjectのタグ参照名一括置換](text-reference-replacement-design.md)
- [型付き読取slotの初回実装](typed-read-slots-design.md)

### 性能・CI

- [CI高速化の変更案・メインチャットへの引継ぎ](ci-acceleration-proposal.md)
- [CI並列化の実装と検証](ci-acceleration-results.md)
- [編集性能の計測（R6）](editor-performance.md)
- [混在図面の品質・性能計測（I5）](mixed-editor-quality.md)

### 運用・追加構想

- [開発・運用フェーズとログイン](access-policy.md)
- [機器登録・図面からの機器化・画面再利用の詳細検討](equipment-authoring-detail-proposal.md)
- [SCADA 作成支援・機器定義・プラント運用の追加検討](scada-authoring-plant-operations-proposal.md)
- [画像・描画表現・Faceplate・画面展開・kioskの拡張検討](scada-graphics-runtime-extension-design.md)

## 上流連携・レビュー

- [Bantoパネル基盤との比較](reviews/banto-dock-comparison.md)
- [Bantoへの共通機能引渡し](reviews/banto-contribution-handoff.md)：Issue・実装／テスト資産・受入候補
- [再現fixture](reviews/banto-dock-fixture/README.md)
- [Industrial設計スナップショット](upstream/industrial/README.md)：出典・固定commitは開発計画を参照
