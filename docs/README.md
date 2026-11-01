# ドキュメント索引

2026-10-21（日本時間）更新。機能仕様・現在の提供範囲・今後の工程・過去の記録を分けて読む。起動・ツールの導入・検証コマンドは[リポジトリREADME](../README.md)に置く。

## フォルダー構成

`docs`直下にはこの索引だけを置く。新しい文書は用途に合うフォルダーへ追加し、索引と関連文書のリンクを更新する。

```text
docs/
├── project/       現在の実装状況・開発計画・工程表
├── design/        機能仕様・設計・追加提案
│   ├── editor/    編集操作・レイヤー・パネル
│   ├── graphics/  文字・線・塗り・配色
│   ├── images/    画像・画面再利用
│   ├── equipment/機器・タグ・読取slot
│   ├── runtime/   SDK境界・認証方針
│   └── proposals/追加構想
├── guides/        操作ガイド
├── engineering/   コード対応表・リファクタリング
├── history/       日付付きの実装・検証記録
├── performance/   性能・CIの記録と計測資産
├── reviews/       上流比較・共通機能引渡し・再現fixture
├── prototypes/    操作試作
├── assets/        実画面・設計画像
└── upstream/      変更しない上流スナップショット
```

## 目的別の入口

現在の実行計画: [S7 SOAK中のSCADA読取開発](project/soak-independent-runtime-plan.md)。固定SDKの更新から進め、IndustrialとS7環境は変更しない。

| 確認すること             | 正とする文書                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| 目標仕様・提供段階       | [統合設計](design/scada-integrated-design.md)。S9bはCore v1のserver基盤。v1.1のAlarm／Event／History／Trendはその上に追加 |
| 今使える機能・残り       | [実装状況](project/implementation-status.md)。正式Runtime・serverは未完成                                                 |
| 次の判断・上流待ち・統合 | [開発計画](project/development-plan.md)と[単体開発工程表](project/upstream-independent-plan.md)                           |
| 操作・ショートカット     | [操作ガイド](guides/user-guide.md)                                                                                        |
| コード・責務・関連テスト | [コード対応表](engineering/code-map.md)                                                                                   |
| 過去の仕様・実装・検証   | [実装履歴](history/implementation-history.md)。当時の「次は」「未実装」を現在情報として読まない                           |
| 構造整理の不変条件・結果 | [リファクタリング計画](engineering/maintenance-refactoring-plan.md)                                                       |

## 文書の読み方・更新先

- 採用済みの目標仕様と、各機能の実装段階は別。個別の採用設計・未採用提案・当時の実装記録は文頭の状態を確認する。
- 新機能は個別設計に対象・除外・不変条件・受入を置き、完了したら実装状況と工程表を更新する。次の判断は開発計画、日付付きの経緯・件数・CI結果は履歴または各機能の検証記録へ置く。
- 状況の入口に古いCI件数や「次工程」を継ぎ足さない。完了した工程を次の着手対象として残さない。新しい文書はこの索引へ登録する。
- 画像は各設計書の相対リンクから参照する。[assets/frontend-ux](assets/frontend-ux/)は実画面、[performance](performance/)は計測・候補再現資産。画像や生データの存在だけで機能完了・性能保証とはしない。
- `upstream/industrial`は固定commitの参照スナップショットで編集しない。上流の状態とSCADA側の実装状況を区別する。

## 機能別の資料

以下は分類索引。分類は実装済みを意味しない。現在の採用範囲は各文書の状態と実装状況を確認する。

### 画面・操作設計

- [SCADA フロントエンド UX 設計](design/editor/frontend-ux-design.md)
- [SCADA Designer UI 改訂提案](design/editor/designer-ui-revision.md)
- [サイドチャット試作の Designer 適用レビュー](design/editor/prototype-design-review.md)
- [Designerメニューの可用高さとスクロール](design/editor/designer-menu-viewport.md)
- [プロパティパネルの浮動化・初回設計](design/editor/inspector-floating-design.md)
- [左作業パネルの浮動配置](design/editor/sidebar-floating-design.md)

### 作図・レイヤー・一括編集

- [Symbol配置への接続と配管端点追従](design/editor/connection-follow-design.md)

- [選択配置の配列複製](design/editor/array-copy-design.md)
- [レイヤーフォルダーのドラッグによる親変更](design/editor/folder-drag-design.md)
- [図形間の隙間の均等化](design/editor/gap-arrangement-design.md)
- [幾何グループ：初回の実装設計](design/editor/geometric-groups-design.md)
- [レイヤー配置のドラッグによる所属変更](design/editor/layer-drag-design.md)
- [レイヤーフォルダーの設計](design/editor/layer-folders-design.md)
- [レイヤーの兄弟内挿入](design/editor/layer-relative-order-design.md)
- [配置の回転（次の実装工程）](design/editor/object-rotation-design.md)
- [複数配置の幅・高さを統一する](design/editor/selection-size-design.md)
- [選択範囲の表示](design/editor/selection-view-design.md)
- [矩形・楕円の枠線の一括編集](design/editor/selection-outline-design.md)

### 文字・線・塗り

- [bool slot表示Textの状態別文字色](design/graphics/bool-text-colors.md)
- [単色と枠線のα](design/graphics/color-alpha-design.md)
- [実線・破線・点線](design/graphics/line-style-design.md)
- [矩形・楕円の2色線形グラデーション](design/graphics/linear-gradient-design.md)
- [静的Textの明示改行](design/graphics/multiline-text-design.md)
- [配置全体の不透明度](design/graphics/opacity-design.md)
- [矩形・楕円の繰返しパターン](design/graphics/pattern-paint-design.md)
- [2色の放射グラデーション](design/graphics/radial-gradient-design.md)
- [複数配置の不透明度](design/graphics/selection-opacity-design.md)
- [単色塗り・枠線のα一括編集](design/graphics/selection-paint-alpha-design.md)
- [Text配置の文字書式を一括編集する](design/graphics/selection-text-style-design.md)
- [矩形・楕円の塗りと枠線](design/graphics/shape-paint-design.md)
- [静的Textの枠幅での折返し](design/graphics/static-text-wrap-design.md)
- [共有Symbolの静的な配色](design/graphics/symbol-color-design.md)
- [Textの基本書式と枠内表示](design/graphics/text-style-design.md)

### 画像・画面再利用

- [共有Symbol内の静止画像：段階設計](design/images/symbol-image-design.md)

- [背景画像の数値トリミング](design/images/background-image-crop-design.md)
- [別画面を表示する埋込View](design/images/embedded-screen-design.md)
- [画像資産と背景画像の最小保存基盤](design/images/image-assets-design.md)
- [画像の貼り付けと原本を含む図形clipboard](design/images/image-clipboard-design.md)
- [原本プレビューのトリミング比率固定](design/images/image-crop-aspect-design.md)
- [配置画像の非破壊トリミング](design/images/image-crop-design.md)
- [原本プレビュー上のトリミング操作](design/images/image-crop-pointer-design.md)
- [配置画像の表示方式](design/images/image-fit-design.md)
- [画面へ配置するImageの最初の範囲](design/images/image-placement-design.md)
- [ブラウザ全画面での表示確認](design/images/preview-fullscreen-design.md)
- [プレビュー専用の画面内Popup](design/images/preview-popup-design.md)
- [埋込画面のコピーと貼り付け](design/images/screen-view-clipboard-design.md)

### 機器・タグ・読取境界

- [bool slotの状態判定と動的配色への接続](design/equipment/bool-slot-state.md)
- [共有シンボル内の機器情報表示](design/equipment/equipment-property-design.md)
- [機器の読取詳細](design/equipment/equipment-read-details.md)
- [Equipmentの保存契約と初期台帳](design/equipment/equipment-register-design.md)
- [Symbol配置と機器の関連付け](design/equipment/equipment-symbol-association.md)
- [機器種別と任意の読取slotの編集](design/equipment/equipment-type-editing.md)
- [型付き読取結果の受入とSymbol表示](design/equipment/read-slot-presentation.md)
- [Runtime の SDK 投影境界](design/runtime/runtime-sdk.md)
- [Project単位の読取Host（P2）](design/runtime/read-host.md)
- [Host表示DTOと画面sessionの接続（P3a）](design/runtime/read-presentation.md)
- [製品transport・接続設定の境界（P3b）](design/runtime/transport-boundary.md)
- [Host catalogとタグ選択（P4）](design/equipment/catalog-selection.md)
- [Historian／Trendの契約設計（P5、実装は後続）](design/runtime/historian-trend-contract.md)
- [Historianの版付きJSON契約と共通fixture（H1）](design/runtime/historian-contract-fixtures.md)
- [Historianの保存方式・transaction／recovery（H1、DB実装はH2）](design/runtime/historian-storage-decision.md)
- [Historianの固定session・SQLite原子appendコア（H2a）](design/runtime/historian-atomic-store.md)
- [Historianのraw snapshot検索・有限予算と取消（H2b1）](design/runtime/historian-query-snapshot.md)
- [Historianの共通grid・min/max集約（H2b2）](design/runtime/historian-minmax-query.md)
- [Historianの時刻付き記録計画と欠測の証拠保存（H2b3）](design/runtime/historian-recording-evidence.md)
- [Historianの証拠からの保守的なcoverage投影（H2b4）](design/runtime/historian-coverage-projection.md)
- [Historianの原子trim・expiredと保持／容量の段階設計（H2c）](design/runtime/historian-retention.md)
- [HistorianのDB/WAL診断と明示PASSIVE checkpoint（H2c2）](design/runtime/historian-maintenance.md)
- [HistorianのSQLite容量不足と原子的復旧（H2c3）](design/runtime/historian-write-failure-recovery.md)
- [Historianの永続保持jobと段階削除（H2c4）](design/runtime/historian-retention-jobs.md)
- [Historianの同snapshot復旧状態とjob発見（H2c5）](design/runtime/historian-recovery-state.md)
- [Historianの明示保持候補の時刻安全判定（H2c6）](design/runtime/historian-retention-clock-guard.md)
- [Historianの明示意図による一回分の保持coordinator（H2c7）](design/runtime/historian-retention-coordinator.md)
- [Historianの明示duration policyとUTC cutoff計算（H2c8）](design/runtime/historian-retention-duration.md)
- [Historianの保持policy変更の実データ影響プレビュー（H2c9）](design/runtime/historian-retention-preview.md)
- [Historianの保持policy原子適用・実applied比較（H2c10）](design/runtime/historian-retention-policy-application.md)
- [Historianの位相を累積させない周期recorder（H3a）](design/runtime/historian-periodic-recorder.md)
- [Historianの専用SDK所有者とsnapshot入力（H3b）](design/runtime/historian-sdk-source.md)
- [ChronoGazer資産の共通利用調査](reviews/chronogazer-historian-reuse.md)
- [図面外の読取状態表示](design/equipment/slot-status-summary.md)
- [共有Symbolの図形・配管の状態色追従](design/equipment/state-color-following.md)
- [Symbolと機器の関連付け候補の確認](design/equipment/symbol-equipment-check.md)
- [共有Symbolの読取slotと割付状態表示](design/equipment/symbol-read-slots.md)
- [共有Symbolのslot宣言編集](design/equipment/symbol-slot-editing.md)
- [読み取りタグ Binding の初期契約](design/equipment/tag-binding.md)
- [I6：ローカルProjectのタグ参照名一括置換](design/equipment/text-reference-replacement-design.md)
- [型付き読取slotの初回実装](design/equipment/typed-read-slots-design.md)

### 性能・CI

- [CI高速化の変更案・メインチャットへの引継ぎ](performance/ci-acceleration-proposal.md)
- [CI並列化の実装と検証](performance/ci-acceleration-results.md)
- [編集性能の計測（R6）](performance/editor-performance.md)
- [混在図面の品質・性能計測（I5）](performance/mixed-editor-quality.md)

### 運用・追加構想

- [開発・運用フェーズとログイン](design/runtime/access-policy.md)
- [機器登録・図面からの機器化・画面再利用の詳細検討](design/proposals/equipment-authoring-detail-proposal.md)
- [SCADA 作成支援・機器定義・プラント運用の追加検討](design/proposals/scada-authoring-plant-operations-proposal.md)
- [画像・描画表現・Faceplate・画面展開・kioskの拡張検討](design/proposals/scada-graphics-runtime-extension-design.md)

## 上流連携・レビュー

- [Bantoパネル基盤との比較](reviews/banto-dock-comparison.md)
- [Bantoへの共通機能引渡し](reviews/banto-contribution-handoff.md)：Issue・実装／テスト資産・受入候補
- [Bantoへの還元候補と採用境界](reviews/banto-contribution-candidates.md)：追加候補・TreeViewとの差分・優先順位
- [Hub／ChronoGazerとの保存・参照検証・編集履歴の調査](reviews/cross-app-document-history-research.md)
- [再現fixture](reviews/banto-dock-fixture/README.md)
- [Industrial設計スナップショット](upstream/industrial/README.md)：出典・固定commitは開発計画を参照
