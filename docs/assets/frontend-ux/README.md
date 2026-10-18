# フロントエンド UX 設計の画像

このフォルダーは [フロントエンド UX 設計](../../frontend-ux-design.md) と [統合設計](../../scada-integrated-design.md) の画像を保持します。Markdown の相対リンクで参照し、リポジトリの checkout だけで文書と一緒に閲覧できます。実画面・構成図・生成コンセプトを分けて出典を記載します。

| ファイル                    | 種別・出典                                                         |
| --------------------------- | ------------------------------------------------------------------ |
| `current-editor.png`        | 現状の工程図エディタ。`e6c62d2` の実装を Chromium で撮影した画像。 |
| `current-symbol-editor.png` | 現状の Symbol 定義エディタ。同上。                                 |
| `current-preview.png`       | 現状の静的な表示プレビュー。同上。                                 |
| `designer-wireframe.png`    | 未実装の提案ワイヤーフレーム。下部ドックを開いた構成例。           |
| `designer-wireframe.svg`    | 提案ワイヤーフレームの編集元。構成を説明するために独自に作図。     |

追加画像:

| ファイル                          | 種別・出典                                                                        |
| --------------------------------- | --------------------------------------------------------------------------------- |
| `tag-binding-editor.png`          | `7beedab` のタグ割り当てと未接続表示の実画面                                      |
| `tag-references-editor.png`       | `8d6fd95` の全画面タグ参照一覧の実画面                                            |
| `symbol-placement-editor.png`     | `7fdde19` の配置用定義の独立コピーを使った実画面                                  |
| `designer-revision-wireframe.svg` | サイドチャット案と Astra レビューに基づく改訂提案の編集元。1440×900 の独自構成図  |
| `designer-revision-wireframe.png` | 上記 SVG を Chromium で描画した未実装の提案図。アプリのスクリーンショットではない |

改訂図は左3タブ・分類アコーディオン・浮動パネルの例・専用タグ選択の入口・6メニューを説明する。図の明るいキャンバスは目標の例示で、現行 Project に背景色属性を追加したという意味ではない。詳細は [改訂提案](../../designer-ui-revision.md) を参照。

作成日: 2026-10-18。上表の現状画像は `scripts/capture-ui.mjs` の撮影結果をコピーしたものです。これらの実画面は生成画像や他リポジトリの画面から合成していません。実機・ライブタグには接続していません。

提案図はブラウザで動く実装のスクリーンショットではありません。ルーラー・ツール・タグブラウザー等の未実装要素を含み、寸法は標準構成の目安です。図中のタグ名は説明用の仮名です。

会話に添付された SCADA Designer の参考画像は構成の検討に用いていますが、このフォルダーへ元画像のファイルを保存していません。`ems-apps` の画面・コード・アセットも取り込んでいません。

## 開発画面の生成コンセプト

同日後続の [concepts](concepts/README.md) には、サイドチャットで画像生成ツールを使って作成した画面一覧・タグ選択・共有シンボル編集・環境設定・表示確認の5画像を保持します。実画面の撮影とは別の資料で、将来機能・架空の値・白い Project 背景を含みます。出典と制約は同 README、操作契約は [統合設計](../../scada-integrated-design.md) を参照してください。

## 統合設計採用後のメニューバー実画面

- [ライト](menubar-light.png) / [ダーク](menubar-dark.png): 2026-10-18、段階 A のメニューバー実装を Chromium、1440×900 CSS px で撮影。工程図サンプルを開き、ポンプを選択して「表示」メニューを展開した状態。生成コンセプトや合成画像ではありません。
- メニューバーと常設メニューは実装済みですが、左3タブ・可動パネル・専用の新しい外枠は未実装です。Project のキャンバスは従来の暗色のままで、アプリテーマのみを切り替えています。実設備・Hub には接続していません。

## 左3タブ・部品分類の実画面（2026-10-19）

- `sidebar-parts-light.png`: 部品タブ。基本図形を畳み、シンボルとオブジェクトを展開した状態。
- `sidebar-layers-dark.png`: レイヤータブ。工程図サンプルの配置一覧と、選択したポンプのプロパティ。

`scripts/capture-ui.mjs` を `SCADA_SCREENSHOT_THEME=light` / `dark` で実行し、1600×1000 CSS px の Chromium で撮影した画像。生成画像や合成画像ではなく、実設備・Hub への接続もありません。可動パネルや永続レイヤーの実装完了を示すものではありません。

## コンパクトな部品一覧（2026-10-19・同日後続）

- `palette-icons-light.png`: アイコン一覧。分類内へ小さなアイコンを並べ、検索欄と表示形式切替を1行へ集約。
- `palette-names-dark.png`: 名称一覧。小さなアイコンと名前を1行で表示。

`scripts/capture-ui.mjs` の `scada-parts.png` / `scada-parts-names.png` をコピーした実画面。Chromium、1600×1000 CSS px、工程図サンプルを使い、アプリのテーマと表示形式だけを操作して撮影した。

## プロパティの表示切替（2026-10-19・同日後続）

- `inspector-visible-light.png`: 独立コンポーネントへ分離したプロパティと、コンパクトな見出し。
- `inspector-hidden-light.png`: プロパティを隠して中央へ幅を戻した状態。

`scripts/capture-ui.mjs` の `scada-parts.png` / `scada-wide-canvas.png` をコピーした実画面。ライトテーマ、Chromium、1600×1000 CSS px、工程図サンプルを使い、同じポンプを選択した状態で表示を切り替えて撮影した。

## 補助パネルの一括非表示（2026-10-19）

- `panels-hidden-light.png` / `panels-hidden-dark.png`: 実装済み工程図サンプルで左パネル・プロパティ・タグ参照一覧を一括非表示にした実画面。
- `SCADA_SCREENSHOT_THEME=light` / `dark` を指定して `scripts/capture-ui.mjs` が出力する `scada-canvas-only.png` を保存した。1600×1000。アプリの通常操作で撮影し、画像や DOM は加工していない。
- ドッキング・保存配置・設備のライブ接続の完成を示す画像ではない。

## 共通編集ツールバー（2026-10-19）

- `edit-toolbar-light.png` / `edit-toolbar-dark.png`: 共通操作をツールバーへ移した実装画面。補助パネルを隠しても操作可能な状態。
- 各テーマを指定した `scripts/capture-ui.mjs` の `scada-editor.png`（ライト・パネル表示）と `scada-canvas-only.png`（ダーク・パネル非表示）、いずれも1600×1000を保存した。通常操作で撮影し、画像と DOM は加工していない。

## 部品パレットの操作メニュー（2026-10-19）

- `palette-context-light.png`: 組込ポンプの配置／情報メニュー。
- `palette-context-dark.png`: Project の共有定義ポンプの配置／定義編集／複製／情報メニュー。
- 各テーマを指定した `scripts/capture-ui.mjs` の `scada-part-context.png`（ライト）と `scada-shared-context.png`（ダーク）を保存した。1600×1000、通常操作で撮影した実画面で、画像と DOM は加工していない。

## 薄いヘッダーと統合ツールバー（2026-10-19）

- `compact-shell-light.png` / `compact-shell-dark.png`: グリッド・選択／パン・倍率・モード・保存状態を上部ツールバーへ移した実画面。ヘッダーはサブタイトルなしでテーマはアイコンメニュー。
- 各テーマを指定した `scripts/capture-ui.mjs` の `scada-editor.png`（1600×1000）を保存した。アプリの通常操作で撮影し、画像や DOM は加工していない。

## キャンバスとレイヤーの操作メニュー（2026-10-19）

- `selection-context-light.png`: キャンバス上のポンプ配置を右クリックしたメニュー。
- `layer-context-dark.png`: レイヤー一覧の同じ配置を右クリックしたメニュー。
- 各テーマを指定した `scripts/capture-ui.mjs` の `scada-selection-context.png`（ライト）と `scada-layer-context.png`（ダーク）、1600×1000を保存した。アプリの通常操作で撮影し、画像と DOM は加工していない。
