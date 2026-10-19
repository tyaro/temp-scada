# コードと検証の対応表

状態: **現行構造の案内**。基準は画像crop接続後の`e04e44c`。責務や関数の移動時はこの対応表を更新する。[現在の実装状況](implementation-status.md)、[構造整理の計画・結果](maintenance-refactoring-plan.md)、[作業規則](../AGENTS.md)を併読する。

パスはリポジトリルート基準。関数名を検索し、行番号・ファイルの大きさに依存しない。現在の依存方向はUI→編集／履歴→Project検証。純粋計算とモデルからDOMやAppをimportしない。

## 責務と読む場所

以下のパスはリポジトリルート基準。関数名を検索キーにし、行番号への依存を避ける。

| 責務                     | 現在の入口                                                                                                                                                                        | 守る境界                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 編集セッションと画面接続 | `apps/banto-scada/src/App.svelte`のproject・history・workspaceGeneration・screenId・editingSymbolId・selectedIds・mode                                                            | Projectと履歴の所有者を一つにする。UIの選択・倍率をProjectへ入れない           |
| 入力保護                 | `lib/designer/drafts.svelte.ts`の`createDraftGuard`、Appの`transition`・`validateDrafts`・`commitNumber`                                                                          | 未確定文字列、IME、適用／破棄／取消、数値の個別確定を保つ                      |
| 編集と履歴               | `lib/editor.ts`の`applyCommand`・`finish`、`lib/history.ts`                                                                                                                       | コピー上で実行・検証し、失敗時に元Projectを保持                                |
| 保存モデル               | `lib/project.ts`、`crates/scada-model/schema/project.schema.json`、`crates/scada-model/src/lib.rs`                                                                                | TS／Rust／schema／examplesの契約を合わせる                                     |
| 保存・読込               | Appの`adopt`・`load`・`writeProject`、`lib/project-package.ts`・`save-state.ts`                                                                                                   | ファイル選択・置換確認・実際のデータ処理を識別する                             |
| 画像原本と取込           | `lib/image-assets.ts`・`image-frame.ts`、Appの`prepareImage`・`collectAssets`・差替え処理                                                                                         | 原本共有、仮Store、履歴からの参照、非同期取消を保つ                            |
| クリップボード           | Appの`clipboardAction`、`lib/clipboard.ts`・`asset-clipboard.ts`・`image-clipboard.ts`                                                                                            | OS APIの成功前に切取元を消さない。snapshotと資産leaseを保つ                    |
| 表示と操作               | `lib/ObjectPainting.svelte`・`ScreenPainting.svelte`・`ScreenBackground.svelte`・`Primitive.svelte`・`ImagePainting.svelte`、`Renderer.svelte`・`designer/CanvasWorkspace.svelte` | 読取描画を選択・ドラッグ・入力処理から分ける。追加済みの画像描画部品も確認する |
| レイヤー                 | Appの`beginLayerDrag`・`dropLayer`・`openFolderRequest`、`designer/layer-tree.ts`・`layer-drag.ts`                                                                                | フォルダーの所属と描画順・座標を区別する                                       |
| Runtime読取              | `lib/tag-presentation.ts`、`crates/scada-runtime`                                                                                                                                 | 現在値・QualityをProject定義と分ける。Hub／PLC機能を複製しない                 |
| テスト                   | `lib/*.test.ts`、`examples/*-cases.json`、`e2e`、`.github/workflows/ci.yml`                                                                                                       | 単体の契約とブラウザ操作を併用し、既存の拒否ケースを保持                       |

`lib/`は`apps/banto-scada/src/lib/`を指す。現在の依存方向は「UI → 編集／履歴 → Project検証」。純粋計算・モデルからDOMやAppをimportしない。

## 機能を変更するときの対応表

変更対象の行を入口に、対応する契約・実装・関連検証を読む。

| 変更内容                     | 実装・契約                                                                    | 追加で読む設計                                                                                                       | 主な検証                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 塗り・線・α・一括属性        | Primitive、ShapePaint、Selection系、editor、project                           | [塗り](shape-paint-design.md)・[線種](line-style-design.md)・[α](color-alpha-design.md)                              | shape-paint・gradient・pattern・selection・numeric関連                       |
| 画像配置・差替え・背景・取込 | image-assets／frame／crop、Project、描画、Appの画像取込                       | [画像保存](image-assets-design.md)・[配置と差替え](image-placement-design.md)                                        | image-assets・placement・replacement・background、開始時に追加済みのcrop関連 |
| コピー／切取／貼付           | clipboard、image-clipboard、editor、資産lease                                 | [画像clipboard](image-clipboard-design.md)                                                                           | clipboard・image-paste・asset-clipboard                                      |
| 画面・Symbol・フォルダー     | editor、screen-references、layer-tree／drag、使用先集計                       | [埋込](embedded-screen-design.md)・[配置ドラッグ](layer-drag-design.md)・[フォルダードラッグ](folder-drag-design.md) | screens・symbols・screen-view・layer／folder関連                             |
| 選択・viewport・数値         | Renderer、CanvasWorkspace、geometry、drafts、numeric-properties               | [選択表示](selection-view-design.md)・[回転](object-rotation-design.md)・[UX](frontend-ux-design.md)                 | numeric・range・rotation・resize・viewport・wheel・placement                 |
| 保存形式                     | TS Project、JSON Schema、Rust Project、生成処理、examples、package／clipboard | [保存基盤](image-assets-design.md)・[統合設計](scada-integrated-design.md)                                           | TS／Rust共有ケース、JSON／package往復、copy／paste、Undo                     |

保存形式の変更は本リファクタでは行わないが、後続の機能追加では上記の同期対象を確認する。モデル変更時だけ必要な契約ケースを追加し、関数移動そのものを確認するだけのテストは作らない。

## フォームの現行境界

フォームの移行中。塗りと枠線は`designer/forms/shape-paint.ts`、枠線一括は`selection-outline.ts`が入力と対象を解釈し、残るフォームはAppの`formCommand`が解釈する。`validateDrafts`は共通のまま候補Projectへ順に適用して全体検証する。確定は`submitForm`→`edit`、成功時は`acknowledgeForm`→DraftGuardへ戻す。通常数値は`commitNumber`と`acceptField`を通す。別のdirty台帳やProject所有者を作らない。

| フォーム      | 現在の入力・描画                                    | 解析・確定の所在                                                               |
| ------------- | --------------------------------------------------- | ------------------------------------------------------------------------------ |
| 塗りと枠線    | `designer/ShapePaint.svelte`、`pattern-fields.ts`   | `forms/shape-paint.ts`へ入力解析・世代／所有先／配置の照合を移行済み           |
| 枠線一括      | `SelectionOutline.svelte`                           | `forms/selection-outline.ts`の解析・固有reset、`selection-target.ts`の対象照合 |
| 線・色の一括  | `SelectionLine`／`SelectionColor`                   | Appの`formCommand`・`acknowledgeForm`                                          |
| Symbol配色    | `SymbolColorMode.svelte`                            | Appの`formCommand`                                                             |
| 背景画像      | Appの画面設定フォーム                               | Appの`formCommand`                                                             |
| 画像crop      | `designer/ImageCrop.svelte`・`image-crop-fields.ts` | 数値解析はhelper、対象照合とコマンドはApp                                      |
| 通常配置      | `InspectorPanel.svelte`・`numeric-properties.ts`    | Appの`formCommand`と`commitNumber`                                             |
| 画面・Project | Appの左ペイン                                       | Appの`formCommand`                                                             |

R3ではフォームごとにadapterへ移し、成功済みと残る経路を計画の進捗へ記録する。上表は移行先の完成を示さない。

## 画像と非同期の現行境界

- `AssetStore`は不変原本・hash・URL・leaseを所有する。Appの`collectAssets`は現在ProjectとUndo／Redoから必要なhashを集計する。
- `prepareImage`は仮Storeで検証し、対象が現在でも有効な場合だけ共有Storeへ取込む。配置・背景・差し替えの要求条件を別に保持する。
- 差し替えは配置ID／元asset／選択世代に加え、decode開始時のcrop世代を確認する。既存draft適用とdecode中の変更を区別する。
- `ImagePainting`がcropとcontainの共通描画を担い、`ObjectPainting`経由で編集・ミニマップ・埋込・小窓へ使われる。
- native clipboard取得と、Promise付きClipboardItemのwrite開始はユーザー操作イベントの境界を保つ。controller化で最初のawaitより後へ送らない。

## ブラウザ検証の共通準備

`e2e/helpers/designer.ts`はメニュー・テーマ・左タブと主キャンバスroot、`images.ts`はブラウザでのPNG fixture生成、`project-files.ts`は成功読込とdownload／bytesの取得を所有する。まず画像配置・差し替え・背景の3specで使う。他のspecの一斉置換はしない。

成功読込helperはファイル入力のクリア／再生成とenabled、成功表示、未処理確認なしを待つ。前回の成功メッセージだけで次の読込完了と判定しない。不正ファイル・未適用入力・遅延応答など、失敗や確認自体を検証するケースは明示手順を残す。packageのブラウザ内importはネイティブdecodeと原本復元の確認に使い、一般的なZIP／schemaの網羅検証は既存の単体側で行う。

`playwright.config.ts`で失敗trace・screenshot、CIではHTML reportを出す。workflowは失敗時にtest-results／playwright-reportを7日保持する。待機時間・retry・拒否条件を緩める変更ではない。

ShapePaintの成功後の確定は固有のfield resetを持たないため、既存の共通acknowledgeForm／DraftGuardを維持する。形状やフォームの全体事前検証、数値確定順、フォームごとの履歴は変更しない。

プレビュー等の切替でfitを測る場合は`settleCanvasLayout`でviewportのResizeObserver通知と後続描画フレームを待つ。切替クリックの完了だけでは、補助ペインの伸縮後のfitが確定したとは限らない。

SelectionOutlineの空欄はpatchへ入れず、変更項目が全くない要求は既存モデルで拒否する。有効な同値の再適用はno-op。成功時はadapter内で一回限りのpatch欄を空にしてから、既存の共通draft確定へ戻す。選択の世代・IDsの検証は移行済みフォームだけがselection-targetを使い、未移行フォームは元の経路を維持する。
