# コードと検証の対応表

`examples/real-hub-s7.project.json` はDB由来pushタグ、`examples/real-plc-r.project.json` はR系実PLCの変動数値・trueの製品表示用fixture。`examples/real-plc-q-r-zero.project.json` はQ系D3000の数値0と、R系の読取専用D4000／M1500の0・falseを通常画面と機器小窓で照合するfixture。実機Hubへ追加した読取専用タグを参照し、別環境へそのまま適用しない。

2026-11-05 の実Hub接続入口: `crates/scada-host` が Windows の資格情報と非機密のHub接続記録を所有し、`crates/scada-host/examples/real_hub_read.rs` が REST の読取専用プローブを提供する。`apps/banto-scada/src-tauri/src/main.rs` は Tauri command／event と `ReadHost`／`CatalogHost` の単一owner、購読開始より先に届いた終了通知も保持して退役済み開始を拒否する。`apps/banto-scada/src/native/` は通常entrypointの `ReadSource`／`CatalogSource` 配送を担当し、購読開始と終了のIPCを順に送る。`sources.ts` は認証失効をShellへ通知し、値と接続表示を消す。`sources.test.ts`、`e2e/read-presentation.spec.ts`、`e2e/native-read-path.spec.ts` が旧通知破棄・接続源切替・通常画面のIPC経路を検証する。`src-tauri/src/native_tests.rs` はTauri command／eventからループバックのモックHubまで、`crates/scada-runtime/tests/read_host.rs` はReadHost／SDK境界を検証する。native試験は関連変更時にWindows CIで実行する。実機結果と残る受入条件は[接続記録](../project/real-hub-c0.md)を参照。

2026-11-08 の記録registry認証: `crates/scada-host/src/auth.rs` の `HostAuth` が、Banto v7.0.0 の `banto-admin-services`（users／settings／audit）とwebviewの `DesktopSession` 一枠を所有する。migrationはBanto admin-templateの0002〜0008（0001・0006を除く）を `crates/scada-host/migrations-sqlite/` へそのままコピーしている。`current`が毎回認証DBを（認証無効モードを先に）読み直してsessionを再検証し、`require_role`が未ログインを`Unauthorized`、権限不足を`Forbidden`（監査に`denied`）とする。slotの`seq`は認可の内容が変わったときだけ進む。試験は `crates/scada-host/src/auth/tests.rs`（一時SQLite）。設計は[認証・host gate](../design/runtime/historian-recording-host-gate.md)。`crates/scada-host/src/recording_epoch.rs` は記録registry rootの世代ごとの`ownerRef`／`ownerEpoch`（OSのCSPRNGから128bit、32桁小文字hex）を生成し、前回値と照合してアプリdata dirの`recording-epoch.json`へ`recording-epoch.lock`の排他lockの下で、一時fileとrenameで保存する。`create_recording_root`は保存が成功してからrootを作る。試験は `crates/scada-host/src/recording_epoch/tests.rs`。

2026-11-11 の記録workflowの引継ぎ（C5-7）: `crates/scada-host/src/recording_gate.rs` の `HeldWorkflow` が段階ごとの元requestと元replyを持ち、`workflow_resumption`（command `recording_workflow_resumption`）で同じprincipalへ返す。`apps/banto-scada/src/lib/recording-async/resumption.ts` が検査し、`native/recording/port.ts` が台帳へ保存済みの元callとして入れ、`coordinator.ts` の `restore` がworkflowを復元する。試験は `recording_gate/tests/workflow.rs`、`recording-async/resumption.test.ts`、`e2e/native-recording-operations.spec.ts`。設計は [製品owner設計 §7.2](../design/runtime/historian-recording-product-owner.md)。

2026-11-09 の記録DBと履歴読取（C5-1）: `crates/scada-host/src/recording_runtime.rs` の `RecordingRuntime` が、アプリdata dirの `historian-store.json`（`storeId`・`deploymentId`・`historianNamespace`、store作成より前に一時fileとrenameで保存）と `historian/` の `SqliteStore` を開く（初回は作成）。先に `HistoryReader` を一つ取って `HistoryHost` を作り、storeを`Idle`の `RecordingSupervisor` へ渡す。開けないときは固定の理由コードで `unavailable` とし、アプリは止めない。`history_context` は起動時に読んだ適用済み計画の系列から HistoryContext v2 を作り（Projectの`recordingPlan.planId`が一致するときだけ）、`history_query`／`history_cancel` は呼出し側のcallIdで一件ずつ照会・取消する。試験は `crates/scada-host/src/recording_runtime/tests.rs`（一時SQLite）。Tauri commandは `apps/banto-scada/src-tauri/src/history.rs`、IPC試験は `history_tests.rs`。画面側は `apps/banto-scada/src/native/history.ts`（`nativeHistorySource`・`createNativeHistory`）が `App` の `onprojectchange` でProjectのID・revision・計画IDの変化ごとにcontextを取り直し、`NativeShell` が `historyService` として渡す。Hubの状態は、ネイティブでは`NativeShell`のヘッダー左の接続設定（`headerExtension`）だけが示し、Appヘッダー右の「Hub 未接続」はブラウザ（`headerExtension`なし）だけで出す。全画面プレビューではヘッダーが隠れるので、Appはツールバーに「接続と記録の状態」の組（`connectionStatus`の読取専用バッジ、なければブラウザ用バッジ、と記録状態）を出し、ツールバー名はモードで「共通編集ツールバー」／「表示確認ツールバー」に切り替える。試験は `native/history.test.ts` と `e2e/native-history.spec.ts`（IPC mock）。設計は[製品hostの記録owner](../design/runtime/historian-recording-product-owner.md)。

状態: **現行構造の案内**。2026-10-21更新、Symbol内画像の作成UI（I7c）と接続の保存・編集追従（I8b）の追加を含む。責務や関数の移動時はこの対応表を更新する。[現在の実装状況](../project/implementation-status.md)、[構造整理の計画・結果](maintenance-refactoring-plan.md)、[作業規則](../../AGENTS.md)を併読する。

パスはリポジトリルート基準。関数名を検索し、行番号・ファイルの大きさに依存しない。現在の依存方向はUI→編集／履歴→Project検証。純粋計算とモデルからDOMやAppをimportしない。

## 責務と読む場所

以下のパスはリポジトリルート基準。関数名を検索キーにし、行番号への依存を避ける。

| 責務                     | 現在の入口                                                                                                                                                                        | 守る境界                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 編集セッションと画面接続 | `apps/banto-scada/src/App.svelte`のproject・history・workspaceGeneration・screenId・editingSymbolId・selectedIds・mode                                                            | Projectと履歴の所有者を一つにする。UIの選択・倍率をProjectへ入れない           |
| 入力保護                 | `lib/designer/drafts.svelte.ts`の`createDraftGuard`、Appの`transition`・`validateDrafts`・`commitNumber`                                                                          | 未確定文字列、IME、適用／破棄／取消、数値の個別確定を保つ                      |
| 編集と履歴               | `lib/editor.ts`の`applyCommand`・`finish`、`lib/editor/commands.ts`の型・分類、Project／Symbol／Screen handler、`lib/history.ts`                                                  | コピー上で実行・検証し、失敗時に元Projectを保持                                |
| 保存モデル               | `lib/project.ts`、`crates/scada-model/schema/project.schema.json`、`crates/scada-model/src/lib.rs`                                                                                | TS／Rust／schema／examplesの契約を合わせる                                     |
| 保存・読込               | Appの`adopt`、`designer/controllers/project-files.svelte.ts`、`lib/project-package.ts`・`save-state.ts`                                                                           | ファイル選択・置換確認・実際のデータ処理を識別する                             |
| 画像原本と取込           | `lib/image-assets.ts`・`image-frame.ts`、`designer/controllers/image-import.svelte.ts`、Appの`collectAssets`                                                                      | 原本共有、仮Store、履歴からの参照、非同期取消を保つ                            |
| クリップボード           | `designer/controllers/clipboard.svelte.ts`、`lib/clipboard.ts`・`asset-clipboard.ts`・`image-clipboard.ts`                                                                        | OS APIの成功前に切取元を消さない。snapshotと資産leaseを保つ                    |
| 表示と操作               | `lib/ObjectPainting.svelte`・`ScreenPainting.svelte`・`ScreenBackground.svelte`・`Primitive.svelte`・`ImagePainting.svelte`、`Renderer.svelte`・`designer/CanvasWorkspace.svelte` | 読取描画を選択・ドラッグ・入力処理から分ける。追加済みの画像描画部品も確認する |
| レイヤー                 | `designer/LayerTree.svelte`の一覧markup／CSS、`designer/controllers/layer-tree.svelte.ts`の検索・展開・drag・folder操作、`layer-tree.ts`・`layer-drag.ts`                         | フォルダーの所属と描画順・座標を区別する                                       |
| 共通操作定義             | `designer/controllers/designer-actions.ts`のfolder／toolbar／clipboard／selection context／menu builder、Appの`designerActions`接続                                               | 実行時の現在値・共通項目の参照・同期chooser呼出しを保つ                        |
| Runtime読取              | `lib/tag-presentation.ts`、`lib/read-presentation.ts`、`designer/controllers/read-presentation.svelte.ts`、`crates/scada-runtime/src/{lib,slots,projection,host,display}.rs`      | 現在値・QualityをProject定義と分ける。Hub／PLC機能を複製しない                 |
| テスト                   | `lib/*.test.ts`、`examples/*-cases.json`、`e2e`、`.github/workflows/ci.yml`                                                                                                       | 単体の契約とブラウザ操作を併用し、既存の拒否ケースを保持                       |

`lib/`は`apps/banto-scada/src/lib/`を指す。現在の依存方向は「UI → 編集／履歴 → Project検証」。純粋計算・モデルからDOMやAppをimportしない。

## 機能を変更するときの対応表

変更対象の行を入口に、対応する契約・実装・関連検証を読む。

| 変更内容                     | 実装・契約                                                                    | 追加で読む設計                                                                                                                                                          | 主な検証                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 塗り・線・α・一括属性        | Primitive、ShapePaint、Selection系、editor、project                           | [塗り](../design/graphics/shape-paint-design.md)・[線種](../design/graphics/line-style-design.md)・[α](../design/graphics/color-alpha-design.md)                        | shape-paint・gradient・pattern・selection・numeric関連                       |
| 画像配置・差替え・背景・取込 | image-assets／frame／crop、Project、描画、image-import controllerとAppの接続  | [画像保存](../design/images/image-assets-design.md)・[配置と差替え](../design/images/image-placement-design.md)                                                         | image-assets・placement・replacement・background、開始時に追加済みのcrop関連 |
| コピー／切取／貼付           | clipboard controller、clipboard、image-clipboard、editor、資産lease           | [画像clipboard](../design/images/image-clipboard-design.md)                                                                                                             | clipboard・image-paste・asset-clipboard                                      |
| 画面・Symbol・フォルダー     | editor、screen-references、layer-tree／drag、使用先集計                       | [埋込](../design/images/embedded-screen-design.md)・[配置ドラッグ](../design/editor/layer-drag-design.md)・[フォルダードラッグ](../design/editor/folder-drag-design.md) | screens・symbols・screen-view・layer／folder関連                             |
| 選択・viewport・数値         | Renderer、CanvasWorkspace、geometry、drafts、numeric-properties               | [選択表示](../design/editor/selection-view-design.md)・[回転](../design/editor/object-rotation-design.md)・[UX](../design/editor/frontend-ux-design.md)                 | numeric・range・rotation・resize・viewport・wheel・placement                 |
| 保存形式                     | TS Project、JSON Schema、Rust Project、生成処理、examples、package／clipboard | [保存基盤](../design/images/image-assets-design.md)・[統合設計](../design/scada-integrated-design.md)                                                                   | TS／Rust共有ケース、JSON／package往復、copy／paste、Undo                     |

保存形式の変更は本リファクタでは行わないが、後続の機能追加では上記の同期対象を確認する。モデル変更時だけ必要な契約ケースを追加し、関数移動そのものを確認するだけのテストは作らない。

## フォームの現行境界

フォームの入力名・未指定の意味・EditCommand生成は`designer/forms/`内の各adapterが解釈する。Appの`formCommand`はkindの振分けと現在対象の供給を担当する。`validateDrafts`は共通のまま候補Projectへ順に適用して全体検証する。確定は`submitForm`→`edit`、成功時は各adapterの固有確定→DraftGuardへ戻す。通常数値は既存の`commitNumber`と`acceptField`を通し、別のdirty台帳やProject所有者を作らない。

| フォーム      | 現在の入力・描画                                    | 解析・確定の所在                                                               |
| ------------- | --------------------------------------------------- | ------------------------------------------------------------------------------ |
| 塗りと枠線    | `designer/ShapePaint.svelte`、`pattern-fields.ts`   | `forms/shape-paint.ts`へ入力解析・世代／所有先／配置の照合を移行済み           |
| 枠線一括      | `SelectionOutline.svelte`                           | `forms/selection-outline.ts`の解析・固有reset、`selection-target.ts`の対象照合 |
| 線の一括      | `SelectionLine.svelte`                              | `forms/selection-line.ts`の解析・固有reset、`selection-target.ts`の対象照合    |
| 色の一括      | `SelectionColor.svelte`                             | `forms/selection-color.ts`の解析・固有reset、`selection-target.ts`の対象照合   |
| Symbol配色    | `SymbolColorMode.svelte`                            | `forms/symbol-color-mode.ts`の解析・対象照合                                   |
| 背景画像      | Appの画面設定フォーム                               | `forms/background-image.ts`の解析・対象照合                                    |
| 画像crop      | `designer/ImageCrop.svelte`・`image-crop-fields.ts` | `forms/image-crop.ts`の対象照合・コマンドと既存の数値解析helper                |
| 通常配置      | `InspectorPanel.svelte`・`numeric-properties.ts`    | `forms/object-form.ts`の解析・名前確定と既存Appの`commitNumber`                |
| 画面・Project | Appの左ペイン                                       | `forms/screen-form.ts`／`project-form.ts`の解析・Project名確定                 |

複数選択の移動欄は`forms/move-form.ts`で解析する。フォームのmarkup・dirty追跡と通常数値の個別確定は既存の所有先に残す。関連検証と未移行の責務は計画の進捗へ記録する。

## 画像と非同期の現行境界

- `AssetStore`は不変原本・hash・URL・leaseを所有する。Appの`collectAssets`は現在ProjectとUndo／Redoから必要なhashを集計する。
- `designer/controllers/image-import.svelte.ts`の`prepareImage`は仮Storeで検証し、対象が現在でも有効な場合だけ最新の共有Storeへ取込む。配置・背景・差し替えの要求条件とchooser intent、read／選択／cropのepoch、busy、scope effectを所有する。Appから必要な現在情報のgetterと操作callbackだけを受け、Project・履歴のコピーを持たない。
- file inputのDOMと同期clickはApp。controllerはintentを記録してchooser callbackを呼ぶ。画像pasteも同じprepareへ接続する。背景fit／opacity・同一hash assetは適用時点、配置viewportはchooser開始時点のコピーを使う。
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

フォーム境界はfactory委譲を採用する。Appがkindと現在対象のDTOを供給し、候補全体の検証・submit順序・共通draft確定を所有する。adapterは入力名・未指定の意味・対象照合・コマンド生成・成功後の固有resetを所有する。DraftGuardに新しいcallback登録機構は追加しない。

SelectionColorは単色化の明示checkboxと色入力だけを解析する。共有Symbol定義色からの変換を自動化せず、成功後に色と変換checkboxをresetして共通draft確定へ戻す。

通常Object／Screen／Project・移動も既存の入力変換を移動したもので、新しい対象guardや数値規則を追加していない。通常数値の個別確定と全フォーム適用の別経路を維持し、Project／配置名の成功後確定は採用済みモデルの名前をadapterへ渡す。

## クリップボードの現行境界

`designer/controllers/clipboard.svelte.ts`は要求・busy・owner epochと連続paste記録を所有する。Appはnativeイベントと操作対象の判定を行い、同期でcontrollerのactionを呼ぶ。Projectはcopy snapshot／事前検証に必要な現在値のgetterで渡し、履歴・共有AssetStoreの所有と共通edit／draftはAppへ残す。

native payloadの読取、snapshot／lease確保、Promise付きClipboardItemのwrite開始を最初のawaitより前に保つ。画像pasteはimage-import controllerへ委譲し、OS成功後のcut再確認、candidate／leaseの解放は従来の順序を維持する。取消条件の対応表はリファクタリング計画R4bを参照する。

## Projectファイルの現行境界

`designer/controllers/project-files.svelte.ts`は読込要求・候補Store・置換確認・書出しsnapshot・busyと保存基準を所有する。Appは`adopt`でProjectと共有Storeを交換し、旧Store破棄・履歴・画面状態・世代を一括更新する。保存基準は、従来と同じProject代入直後に`adopted`を同期で呼んで確定する。

file inputの接続getter／clear callbackと同期chooserをAppから供給する。保存や新規・置換コマンドはcontrollerへ直接接続し、busy／保存表示等は`$derived`で追従する。書出し後のbaselineは開始時のsnapshotで、実ファイル保存の完了を意味しない。

## レイヤーの現行境界

`designer/LayerTree.svelte`は一覧markupとCSS、`designer/controllers/layer-tree.svelte.ts`は検索・展開・drag・folder操作の状態とeffectを所有する。表示部品へcontrollerの`LayerTreeBindings`を直接渡す。Project・選択・履歴、表示／lockの実処理はAppへ残し、context actionの定義は共通action builderへ渡す。

FolderDialogとfolder ContextActionsはAppのrootに置いたまま、controllerのrequest・menu handleを接続する。元がplain letのoriginはgetterを操作時に直接読む。AppのProject採用は元の位置で`resetPresentation`を呼ぶ。drag解除はscope・mode・activePanel・sidebar表示を追跡し、編集可否flagの変化だけで取消条件を広げない。

## 共通操作の現行境界

`designer/controllers/designer-actions.ts`は状態を持たないaction builder。Appの`$derived`から呼び、toolbar・編集メニュー・右クリックでは同じ編集／clipboard項目を共有する。disabledとラベルは生成時のgetterで追従し、run callback内の選択ID・screen・context座標・originは実行時に読む。生成時の値を閉じ込めない。

Appはキー／クリックイベントの受付、現在情報と既存callbackの供給、Project・履歴・draft・共通editを所有する。ファイル・画像・clipboardの操作は同期で各controllerへ渡し、ブラウザのuser activationを維持する。新しいaction registry・非同期wrapper・編集コマンドの分類は追加しない。コマンド分類とhandler分割は次節のR5の境界で進める。

## 編集コマンドの現行境界

`lib/editor/commands.ts`はEditCommand／ObjectPatch等の型と全コマンドの分類を所有する。分類表は全41種類のキーと型ごとの所属を照合し、追加漏れ・誤分類を型エラーにする。`isObjectCommand`は従来と同じ29種類を返す。フォルダー・画像等を含む定義編集の範囲であり、UIの選択図形だけを意味しない。

既存の`lib/editor.ts`は公開入口として型・関数を再exportし、`applyCommand`がmode確認→候補コピー→handler→`finish`の順序を所有する。`finish`の資産整理・検証・同値判定・revision更新は共通のまま。未知コマンドは`unhandledCommand(never)`で拒否し、型を追加して分類・handlerを省くと型検査が失敗する。

| モジュール（`lib/editor/`）                                    | 責務と守る順序                                                                                                    |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `project-handler.ts`／`symbol-handler.ts`／`screen-handler.ts` | Project名、共有定義、画面の候補変更。mode・コピー・finishは入口へ残す。画面並べ替え端のno-opだけは元Projectへ戻る |
| `object-handler.ts`                                            | 所有先解決、操作の振分けとlock判定の順序。履歴・DOM・通知・元Projectを所有しない                                  |
| `folder-handler.ts`                                            | 構造操作はlock前、所属変更はlockと複数ID照合後。整理と配置編集のguardを混同しない                                 |
| `image-handler.ts`                                             | 配置追加は従来位置、差替え・crop・比率復帰はlock／対象lookup後。資産登録とcropの条件を維持                        |
| `object-state-handler.ts`                                      | 表示・lockのboolean確認とno-op。通常のlock拒否より前に実行し、解除を拒まない                                      |
| `paste-handler.ts`                                             | 原本宣言／Symbol参照の対応付けと新ID。元ProjectそのものではなくIDだけを受け、同じoriginの参照を再利用             |
| `selection-handler.ts`                                         | 複数IDの空／重複／不存在を照合した全選択へ適用。型に合う配置だけを抽出して部分適用しない。等間隔の両端一致はno-op |
| `placement-handler.ts`                                         | 埋込Viewと図形・組込Symbolの配置。定義内拒否、基準色、寸法・中心計算とID発行順を維持                              |
| `single-object-handler.ts`                                     | 対象lookup後の画像委譲・独立Symbol・頂点・複製・重なり順・単体patch。重なり順端のno-opを維持                      |
| `model-helpers.ts`                                             | 既存のID発行・使用数・複製時のID／所属参照付替え・配置中心・資産登録。`newId`／`symbolUsage`の公開入口も維持      |

handlerは候補だけを変更する。表示／lock・等間隔の両端一致・配置／画面順の早期no-opは`unchanged`を返し、入口が元Projectを直返しする。それ以外は共通finishで検証してから内容を比較する。Project形式とUndo単位を変更せず、historyからhandlerへ逆依存を追加しない。

## 編集性能の計測

`apps/banto-scada/scripts/benchmark-editor.mjs`はViteのSSR loaderで現行ドメイン関数を読み込み、100／1,000／5,000配置の編集・履歴・Undo・保存と各処理の独立probeを計測する。ブラウザ描画や入力から表示までの遅延は測らない。実行方法・fixture・解釈・結果は[編集性能の計測](../performance/editor-performance.md)を参照する。通常のunit／E2Eに時間閾値を追加するものではない。

## 幾何グループ（0.22.0）

- `lib/geometric-groups.ts`：所属の意味検証、選択全体の検査・展開、操作単位、bounds・90度回転。UI状態・履歴を持たない。
- `lib/editor/group-handler.ts`：作成／解除／名前／回転／状態／描画順。候補だけを変更し、共通finish・Undoは入口側。
- `lib/editor/group-arrangement.ts`：groupを含む整列・等間隔。子の間隔を保ち単位を移動する。
- `object-handler.ts`：部分指定と内部の書式変更を拒否。`selection-handler.ts`：複製／削除の所属処理。`model-helpers.ts`：画面複製のID対応。
- `clipboard.ts`／`asset-clipboard.ts`／`paste-handler.ts`：明示v3、画像原本・所属・配置ID再採番。旧v1／v2でgroupを受理しない。
- `examples/geometric-group-cases.json`をTS／Rust双方で使用。`geometric-groups.test.ts`は原子性・Undo・幾何・再利用・Proxy・名前と状態の境界。`geometric-group-contract.spec.ts`は実ブラウザの読込・v3コピー・保存／Undoと不正読込保持。

G3でDesignerも接続した。`App.svelte`の選択・キー・mode境界を純粋なgroup単位へ接続し、`layer-tree.ts`／`LayerTree.svelte`が検索可能な1行を表示する。`layer-drag.ts`は全メンバーの所属変更を扱う。`GroupInspector.svelte`と`forms/group-name.ts`は名前の世代・対象・draft・IMEを保護し、共通操作は`designer-actions.ts`のtoolbar／メニュー／右クリックへ置く。`geometric-groups.spec.ts`は両テーマ・F2・IME・Undo後のdraft・使用先・状態・ドラッグ／方向キーを確認する。現在の機能提供段階は[実装状況](../project/implementation-status.md)を参照する。

型付き読取slotの契約・現在値の非永続化・後続Equipmentとの境界は[初回設計](../design/equipment/typed-read-slots-design.md)を参照。`slots.rs`が機器contextとplan、`projection.rs`が既存Textと共通のmetadata／値検証を所有し、`tests/sdk_projection.rs`で実SDKのloopback投影を確認する。

Equipmentは`lib/equipment.ts`と`crates/scada-model/src/equipment.rs`が保存後の意味検証、`editor/equipment-handler.ts`が原子的な候補編集を担当する。初期UIは`EquipmentLibrary.svelte`、対象世代とFormDataの解釈は`forms/equipment.ts`。共通契約は`examples/equipment-cases.json`、UIの回帰は`e2e/equipment.spec.ts`。[契約と検証](../design/equipment/equipment-register-design.md)を参照する。

[機器とSymbolの関連付け](../design/equipment/equipment-symbol-association.md)は`equipmentUsages()`が非永続の全画面参照索引を生成し、同じ意味検証をTS／Rustで実行する。`single-object-handler.ts`と既存objectフォームが関連付け、`equipment-handler.ts`が使用中削除拒否、`clipboard.ts`が機器移入の明示拒否を担当。`e2e/equipment-association.spec.ts`と共通`equipment-reference-cases.json`で検証する。

共有Symbolの読取宣言は`project.ts`と共通schema、意味検証・機器contextの取得前状態解決は`lib/symbol-slots.ts`が担当する。`symbol-handler.ts`は宣言＋Textの原子的追加、既存objectフォームは宣言選択、`ObjectPainting`／`Primitive`は値を代用しない描画を担当する。`EquipmentContext`はメイン／minimap／埋込／小窓へ明示伝搬し、global stateを作らない。共通`symbol-slot-cases.json`、`symbol-slots.test.ts`、`e2e/symbol-slots.spec.ts`で確認する。[実装範囲](../design/equipment/symbol-read-slots.md)を参照する。

読取DTOの構造は`crates/scada-runtime/schema/read-slot-view.schema.json`、TSの受入・plan照合・世代／frame所有は`lib/read-slot-session.ts`が担当する。`equipmentReadContext()`がcurrentProjectと返却frameを表示contextへ接続し、`symbol-slots.ts`が保存設定を優先して解決する。`TextPrimitive`はSIM・Quality・由来の文字／属性を描画し、接続やQuality判定を所有しない。共通`read-slot-view-cases.json`とRustの実投影、`read-slot-session.test.ts`、`e2e/read-slot-session.spec.ts`で確認する。[受入契約](../design/equipment/read-slot-presentation.md)を参照する。

Symbol宣言のCRUDは`editor/symbol-handler.ts`、全Text参照の導出は`symbolSlotUsages()`。`designer/SymbolSlots.svelte`は左の宣言UIと使用保護の説明、`forms/symbol-slot.ts`は世代・定義・元のslot名を照合し、成功した追加フォームだけ初期化する。既存`add-symbol-readout`は宣言行からの操作では存在を再確認する。`symbol-slot-editing.test.ts`／`e2e/symbol-slot-editing.spec.ts`で検証する。[編集契約](../design/equipment/symbol-slot-editing.md)を参照する。

読取表示結果の判別共用体・欠測文言・SIM判定・boolのtrue／false／unknownへの純粋な変換は`lib/slot-presentation.ts`が担当する。Goodだけに型付きvalueを持たせる。`read-slot-session.ts`は所有コピーを返し、`TextPrimitive`はinvalid理由も表示する。`slot-presentation.test.ts`と既存session／ブラウザ検証で確認する。[動的配色への前段と残り](../design/equipment/bool-slot-state.md)を参照する。

状態別文字色はTextの`boolColors`として`project.ts`と共通schemaに保存し、`symbol-slots.ts`／Rustの意味検証でbool宣言へ制限する。`Primitive`が型付き状態を色へ接続し、`BoolColors.svelte`と`forms/bool-colors.ts`が独立した編集フォームを持つ。`object-form.ts`は静的／number変更時の同時解除、Appのdraft事前検証は二重入力の競合拒否を担当する。[提供範囲と検証](../design/graphics/bool-text-colors.md)を参照する。

図面外の読取状態は`lib/slot-status-summary.ts`が現在の可視配置経路・使用roleを収集し、既存resolverへ状態解決を委譲する。`SlotReadStatus.svelte`は件数・20件ページング・開閉のみを所有し、Appと`PreviewWindow`が描画と同じcontextを渡す。表示プレビュー（`alert`）では取得不能が1件以上で要約行を警告色とアイコンにし、全件なら「この画面の値はすべて取得できていません」と文で出す（編集中は中立のまま）。品質の語は`slot-presentation.ts`・`tag-presentation.ts`で「更新停止」「不良」に揃える。`slot-status-summary.test.ts`、`e2e/slot-status-summary.spec.ts`、既存の同一mount検証で確認する。[範囲と後続](../design/equipment/slot-status-summary.md)を参照する。

`studio.css`は取得状態一覧がある画面に限り図面タイトルを通常配置へ戻し、一覧との重なりを防ぐ。状態一覧のブラウザ検証で、折畳み時／展開時にタイトル・一覧・canvasが重ならないことを確認する。

状態色追従は`lib/state-color.ts`が参照・塗り条件の検証と色解決、`designer/StateColor.svelte`と`forms/state-color.ts`が編集入力を担当する。`Primitive.svelte`は動的な塗り／線と静的枠線を分離する。`model-helpers.ts`の`remapStateColor`を定義複製・複数選択複製が共用する。`state-color.test.ts`、共通`examples/state-color-cases.json`、`e2e/state-color.spec.ts`と同一mount読取試験が回帰入口。[契約](../design/equipment/state-color-following.md)。

機器の読取詳細は`equipment-read-details.ts`が全採用slotの導出、`EquipmentReadDetails.svelte`が20件ずつの表示を持つ。`symbol-slots.ts`の`resolveEquipmentSlot`をSymbolと共用する。`preview-popups.ts`の`kind + targetId`を画面／機器小窓が共用し、枠・フォーカス・前後順は既存PreviewWindow／PreviewPopupsが担当する。`equipment-read-details.test.ts`・`preview-popups.test.ts`・`e2e/equipment-read-details.spec.ts`と同一mount試験を変更時の入口にする。[詳細](../design/equipment/equipment-read-details.md)。

Symbolからの読取詳細の起動はInspectorの`onopenequipment`をAppの`openSelectedEquipment`へ渡す。draft解決後の機器再取得とmode遷移・tick後の世代照合はApp、直接起動と既存窓の再前面化はPreviewPopupsの`showEquipment`が担当する。`e2e/equipment-read-entry.spec.ts`で適用／破棄／キャンセル／関連付け解除・ロック中・履歴不変を確認する。

表示プレビュー（全画面を含む）で機器を関連付けたSymbolを押すと、`Renderer`が`equipment-read-details.ts`の`previewEquipmentLink`で対象機器を決め、`onopenequipment`（`CanvasWorkspace`経由）からAppがPreviewPopupsの`showEquipment`を呼ぶ。編集中・関連付けなし・存在しない機器は入口を付けない。ツールバーの「機器の読取詳細」は一覧からの入口として残す。`preview-equipment-link.test.ts`と`e2e/preview-equipment-click.spec.ts`を変更時の入口にする。

TextPrimitiveの非表示計測の再試行はResizeObserver通知中にprobeへ書き込まず、requestAnimationFrameへ集約する。破棄時に予約を取り消す。隠れた部品パネルからの計測復帰はtext-style、mode／Modal切替でのResizeObserver配送エラー不在はequipment-read-entryで検証する。

機器種別の編集は`EquipmentTypes.svelte`が構造draftと採用数表示、`forms/equipment-type.ts`が入力・世代・種別の検査を持つ。`EquipmentLibrary.svelte`が機器割付との切替をdraft経路へ通す。既存`equipment-handler.ts`と最終Project検証が参照保護・原子性を維持する。`equipment-type-editing.test.ts`と`e2e/equipment-types.spec.ts`が回帰入口。[詳細](../design/equipment/equipment-type-editing.md)。

機器台帳の検索と20件ページングはEquipmentLibrary内の一時UI状態。番号・名前・種別名をNFKCと大小文字の正規化で検索し、選択とフォームを検索結果から独立させる。`e2e/equipment-search.spec.ts`の55件台帳でDOM行数・ページ境界・検索・draft保持・保存不変を確認する。

機器小窓の図面使用先は既存`equipmentUsages`を`PreviewWindow`から`EquipmentReadDetails`へ渡し、独立した20件ページで表示する。移動は`App.openPreviewEquipmentUsage`から既存`openSymbolUsage`を呼び、世代・呼出mode・Symbol／機器参照の再確認と編集復帰、グループ選択を共用する。`e2e/equipment-usage-navigation.spec.ts`が非表示／ロック・別画面・グループ・ページ境界・保存不変を確認する。

別機器登録は`EquipmentLibrary`が登録元IDと新規入力を保持し、`forms/equipment.ts`が現行Projectの元機器から採用slotを未割付にして既存`create-equipment`へ渡す。戻る処理はクリック時のID・世代を固定し、登録後の自動選択と競合させない。`e2e/equipment-copy.spec.ts`で両テーマの独立登録・元機器と配置の不変・重複拒否・Undo／Redoとdraft分岐を確認する。

Symbolと機器の候補確認は`symbol-equipment-check.ts`が実使用slotを既存resolverで保存設定だけから導出する。`SymbolEquipmentCheck.svelte`は親フォームの現在値を読取専用で監視し、モデル反映後のtick・フォーム同一性・対象keyを保護する。`InspectorPanel`はobjectの世代key内、編集fieldset外へ置く。`symbol-equipment-check.test.ts`と`e2e/symbol-equipment-check.spec.ts`がhidden・未使用・設定状態と未適用／破棄／Undo・ロック・ページ境界を確認する。[詳細](../design/equipment/symbol-equipment-check.md)。

選択Symbolから機器台帳への移動は`App.openSelectedEquipment`のsettings分岐で読取詳細のdraft解決・機器再取得を共用する。`EquipmentLibrary.showEquipment`が一覧への切替とID選択を行い、tick後に同じ世代・対象・接続中のformだけを返す。Appが再照合してツリー展開・focusを担当する。`e2e/equipment-settings-entry.spec.ts`がpanel／種別view復帰とdraft全分岐を確認する。

機器のcontext操作は`designer-actions.ts`の`selectionContext`が単一・画面Symbolだけに二つの入口を追加し、hostの`openEquipment`へ委譲する。Appの既存起動関数を共用し、メニュー側に別の対象解決・draft処理を作らない。`e2e/equipment-context.spec.ts`でcanvas／レイヤーのShift＋F10・プロパティ非表示・ロック・未関連・複数選択・未適用割付を確認する。

配置画像の表示方式は`image-fit.ts`の閉じた型／SVG対応と、既存image handlerの`set-image-fit`が担当する。`ImageFitSettings`／`forms/image-fit.ts`が独立draft・実枠比率の見本と対象世代照合を持つ。`ObjectPainting`から共通`ImagePainting`へfitを渡し、crop矩形とviewportのclipを共用する。`image-fit-cases.json`をTS／Rustで検証し、`image-fit.test.ts`と`e2e/image-fit.spec.ts`・cropの全fit共通描画試験を変更時の入口とする。[具体設計](../design/images/image-fit-design.md)。

背景cropは`BackgroundImage.crop`と共通schema、TSの`imageCropViewBox`とRustの`validate_image_crop`で配置と同じ数値契約を使う。`ImageCrop`のbackgroundモードを背景設定へ置き、`forms/background-crop.ts`が対象世代とassetを照合して既存`set-background-image`へ渡す。`screen-handler`でProxy由来のcropをplain dataへコピーし未知属性は最終schemaへ残す。`ScreenBackground`はcrop時だけ共通`ImagePainting`を使い、originalの元画素配置とopacity一回を担当する。

`image-import.svelte.ts`の背景epochはasset＋cropの変更・往復を失効させ、fit／opacityだけは確定時の最新値を保持する。同hashではcropをコピーし別hashでは解除する。`background-crop.test.ts`／Rust共通fixtureと`e2e/background-crop.spec.ts`・既存background-imageが数値、Proxy、実画素、原本往復、遅延取込、全描画入口を検証する。[設計と実画面](../design/images/background-image-crop-design.md)。

### 原本プレビュー上の切出し操作

`designer/image-crop-gesture.ts`は原本内の移動・四辺／隅・範囲指定の幾何、`ImageCropSelection.svelte`はpointer候補・capture・取消・矢印操作、`ImageCrop.svelte`は数値欄とdraft保護への接続を担当する。Projectの更新は従来のcropフォーム／commandへ戻す。`image-crop-gesture.test.ts`と`e2e/image-crop-gesture.spec.ts`で境界・1画素・取消・保存とUndoを確認する。設計は[切出し操作](../design/images/image-crop-pointer-design.md)。

`cropAspect`／`cropWithAspect`と`cropGesture`の任意aspectは原本画素比率の取得・数値連動・比率付き幾何を共用する。`image-crop-fields.ts`が入力軸を渡し、`ImageCrop.svelte`が非永続の固定状態・対の欄の更新・native validityとIMEを担当する。Project／原本／SDKの契約は変えない。[比率固定の仕様](../design/images/image-crop-aspect-design.md)。

### 埋込Viewのclipboard

`clipboard-dependencies.ts`はView参照画面・Symbol・画像原本の閉包収集、`clipboard.ts`は必要データだけのv4 envelopeとsnapshotを担当する。`paste-handler.ts`は現行画面再利用を先に決め、実取込配置から定義・資産の対応表を作り、内部ID更新と外部参照を再配線する。`asset-clipboard.ts`のlease／decodeとcontrollerの所有者・切取保護は共用する。`screen-view-clipboard.test.ts`、`asset-clipboard.test.ts`、`e2e/screen-view-clipboard.spec.ts`で参照・原本・失敗時を確認する。[設計](../design/images/screen-view-clipboard-design.md)。

### 放射グラデーション

`project.ts`と共通schema／RustはradialGradientの中心・半径・有限描画範囲を検証し、`paintBaseColor`は始点色を返す。`Primitive.svelte`はinstanceごとのSVG IDとobjectBoundingBox描画、`designer/radial-gradient-fields.ts`は％入力・未変更値の往復、`ShapePaint.svelte`は種類別draftと未適用見本を担当する。既存shape-paintフォームで1回の編集へ戻す。共通`shape-paint-cases.json`、`radial-gradient.test.ts`、`e2e/radial-gradient.spec.ts`が検証入口。[設計](../design/graphics/radial-gradient-design.md)。

### フォルダーの兄弟順

`folder-order.ts`は同じ親の隣を判定し、`editor/folder-handler.ts`の`reorder-folder`はorderの交換だけを実施する。controllerの世代・draft照合とfolderContextメニューへ接続する。`layer-folders.test.ts`は通常／共有定義・境界・大きなorder・原子性・履歴、`e2e/folder-order.spec.ts`はツリー表示・図面画素の不変・検索・未適用名を確認する。

## 機器情報のText表示

- `lib/equipment-property.ts`: 保存済みmetadataのpure resolver、例示の明示と未関連表示。値・Qualityは扱わない。
- `ObjectPainting.svelte`／`Primitive.svelte`／`TextPrimitive.svelte`／`designer/SymbolThumbnail.svelte`: 配置context・定義例示と通常Textの省略表示。
- `symbol-slots.ts`／model schema／Rust検証: Symbol内限定・信号参照との排他。`single-object-handler.ts`と既存state-color検証で原子的変更。
- `designer/forms/object-form.ts`／`numeric-properties.ts`／`InspectorPanel.svelte`: 単一表示元、slot・metadata切替と既存draft保護。
- `equipment-property.test.ts`／`examples/symbol-slot-cases.json`／`e2e/equipment-property.spec.ts`: 解決・保存・no-op・Undo・コピー・実描画。`scripts/capture-equipment-property.mjs`が実画面を記録する。

## 隙間の均等化

`editor/gap-arrangement.ts`は`selectionUnits`／`unitBounds`を共用し、回転後外形の隙間と固定端を計算する。`commands.ts`／`object-handler.ts`／`selection-handler.ts`で原子的な`distribute-gaps`をroutingし、共通`designer-actions.ts`から実行する。`gap-arrangement.test.ts`と`e2e/gap-arrangement.spec.ts`で異幅・回転・矢印・グループ・拒否・no-op・Undoを確認する。中心等間隔の既存経路は維持する。

## 配列複製

- `lib/array-copy.ts`: 組数・ピッチ・配置予算の入力契約。
- `editor/duplicate-placement.ts`: 複数配置・配列で共用する配置／group／stateColorのID対応と参照保持。
- `editor/selection-handler.ts`: `duplicate-array`の行列展開と最終の原子的検証。
- `designer/controllers/array-copy.svelte.ts`／`ArrayCopyDialog.svelte`: draft解決、owner世代／revision、IMEと一時入力。Appは所有者と共通actionへ接続。
- `array-copy.test.ts`／`e2e/array-copy.spec.ts`: 順序・参照・group・予算・取消／Undo・失効。既存`geometric-groups`の回帰を併用する。

配列設定の実画面は`scripts/capture-array-copy.mjs`で記録し、入力値の実画素も確認する。

`e2e/toolbar-status-layout.spec.ts`は保存／dirty表示の寸法変化を検証する。Appの`.save-state`は固定領域と常設dirty行を持ち、数値blur中に作業領域の高さを変えない。`numeric-properties`／`range-input`／`edit-toolbar`の実操作回帰を併用する。

## プロパティの浮動配置

- `designer/floating-panel-layout.ts`: Project外のversion付き配置、表示用clamp、固定起点の移動／サイズ計算。`inspector-layout.ts`は既存slotのadapter。`inspector-layout.test.ts`で不正設定・境界を確認する。
- `designer/controllers/floating-panel.svelte.ts`: 同じDOMの配置、pointer／keyboard transaction、取消・上位層優先・明示保存。workspaceは操作所有者を一つにし、二枚の前面順位を管理する。`floating-inspector.svelte.ts`と`floating-sidebar.svelte.ts`は各保存slot・文言・幾何のadapter。`FloatingPanelHeader.svelte`が左右の見出しを共用する。
- `designer/FloatingPanelHeader.svelte`／`InspectorPanel.svelte`: 非モーダルな操作ハンドルと配置メニュー。フォーム本体を移設・再生成しない。
- `banto/setup.ts`: Banto UI設定の専用slot。書込成功時のみ保存済みsnapshotを更新する。
- Appの`measureWorkspace`: ResizeObserverで上部境界を追跡。`CanvasWorkspace.cancelInteractions`は配置変更と作図gestureを排他にする。既存の手動倍率・中心保持は共用する。
- `e2e/inspector-floating.spec.ts`: DOM identity・複数draft・IME・通常blur・取消・保存復元・狭い画面・上位Menuを実操作で確認する。

## 複数配置の不透明度

`set-opacity`を`commands.ts`のobject分類から`object-handler.ts`の共通lock／group guardを経て`selection-handler.ts`へ送る。全対象・値検証後に既存opacityだけを更新する。`designer/SelectionOpacity.svelte`／`forms/selection-opacity.ts`は既存の選択snapshot・draft guardを使い、成功時にこの入力だけを解除する。`selection-opacity.test.ts`／`e2e/selection-opacity.spec.ts`で値・所有者・参照・拒否・Undo・IME・複数フォームを検証する。実画面は`scripts/capture-selection-opacity.mjs`で記録する。

## 複数配置のサイズ統一

`set-size`はobject分類・lock／group guardから`editor/size-arrangement.ts`へ送る。全候補の中心・回転・描画範囲と桁落ちを検証してから反映する。`designer/SelectionSize.svelte`／`forms/selection-size.ts`は寸法別の混在値と空欄の明示patch、既存のsnapshot／draft guardを使う。`selection-size.test.ts`と`e2e/selection-size.spec.ts`が幾何・参照・原子性・入力を検証し、`scripts/capture-selection-size.mjs`が両テーマの実画面を記録する。

## Textの一括文字書式

`set-text-style`はobject分類と共通guardを経て`selection-handler.ts`でpatchと全対象を検証する。`designer/SelectionTextStyle.svelte`／`forms/selection-text-style.ts`はTextだけの選択を明示し、未指定項目をpatchへ含めない。`selection-text-style.test.ts`が保存・所有者・表示元保持・原子性を、`e2e/selection-text-style.spec.ts`がIME・draft・両テーマ・描画を確認する。実画面は`scripts/capture-selection-text-style.mjs`で記録する。

## 静的複数行Text

`multiline-text-layout.ts`の`normalizeTextNewlines`／`fitTextWidth`／`fitStaticLines`は純粋な文字計測adapterを受け取り、空行と幅／高さの省略・実inkのunionを計算する。`multiline-text-layout.test.ts`で字体・grapheme・縦省略と一時cacheを検証する。`text-content.ts`がTS公開読込・編集・保存のLF正規化を担い、Rust・schema・共有ケースを揃える。`Primitive.svelte`は静的かつLFを含む配置だけ`MultilineTextPrimitive.svelte`へ渡し、従来の一行描画を保つ。`InspectorPanel.svelte`のtextareaと`object-form.ts`がIME・確定・入力保護を接続する。`multiline-text.spec.ts`が両テーマ、動的表示・再利用・保存・clipboardを確認する。Project0.32.0の契約と範囲は[具体設計](../design/graphics/multiline-text-design.md)を参照する。

浮動Inspectorのgestureは開始時のnative window寸法も保持し、入力捕捉時に照合する。`e2e/inspector-floating.spec.ts`の通知遅延ケースはresizeイベントへの依存を切り離して確定競合を再現する。

左右の浮動配置は`App.svelte`で一つのworkspaceへ接続し、表示・上位層・作図操作・固定幅と連携する。sidebarはプレビュー時だけ浮動を休止する。`setup.ts`は各slotを独立して明示保存し、`designer-actions.ts`は復帰と前面表示を提供する。`sidebar-floating.spec.ts`と`inspector-floating.spec.ts`で同じDOM・入力保持・排他・永続化を確認する。

Banto v6.9.0の`Menu`が可用高・内部scroll・初回フォーカス・resize・Esc復帰を所有する。Designerの局所adapterとmount前のcapture listenerは撤去した。`DesignerMenubar.svelte`は横方向のメニュー移動、`ContextActions.svelte`はSCADA対象の選択と起動、画面外へ残った仮想trigger座標の高さ補正を担う。contextKeyごとにMenuの子のMenuGroup／MenuItemだけを再生成し、項目差替え後も上流の登録順を表示順へ揃える。Menu・popover・⋮ triggerを維持して、effectによる同じpopupのcloseとclosed()のorigin消去・条件付きfocus復帰、dialogへ渡したopenerの寿命を保つ。openedKeyの実行前照合も維持する。同じcontext内のMenuItemは表示位置ごとに再利用する。`selection-context.spec.ts`が選択／空白contextの往復、初期フォーカス・全有効項目の矢印巡回・Home／End・Esc復帰を確認する。`selection-context.spec.ts`のCtrl／Command＋Aはcanvas／行へのfocus復帰・次のキー操作・他へ移ったfocusの保持も検証する。`screen-context.spec.ts`は⋮からの複製・未適用入力dialog確定後のtrigger identity／focus／再操作を検証する。`menu-viewport.spec.ts`が内部／外部scroll・キー・resize・狭幅と両テーマを確認する。[Menuの責務と受入](../design/editor/designer-menu-viewport.md)。

### レイヤーの兄弟内挿入

`relative-layer-order.ts`は同じ親のfolder順と単一配置／グループの描画順を純粋計算し、所属・順序・グループのsnapshotを返す。`reorder-folder-relative`はfolder handler、`reorder-relative`はselection handlerへ分類し、既存lock・group guardを通す。`designer/layer-drag.ts`が行内位置と挿入可否、layer-tree controllerがtoken・snapshot・入力確認後の再検証、`LayerTree.svelte`が挿入線と案内を担当する。単体`relative-layer-order.test.ts`／`layer-drag.test.ts`、E2E`layer-relative-order.spec.ts`と既存folder／membership／orderが入口。[仕様](../design/editor/layer-relative-order-design.md)。

### 静的Textの折返し

`static-text-wrap.ts`はLFなし段落の語／書記素境界と幅計測を使って原文を欠落させずに分割する。`fitStaticLines`の一時cacheを共用し、既存の空行・高さ省略・ink境界へ接続する。TextStyleのwrapは共通schema／TS・Rustで検証し、object-form／numeric-propertiesが既存draftと値を往復する。Primitiveは静的な非空本文だけMultilineTextPrimitiveへ渡し、wrapを再計測keyへ含める。動的表示は変更しない。`static-text-wrap*.test.ts`、共通text-style-cases、Rustの往復／旧形式拒否、`e2e/multiline-text.spec.ts`が入口。[仕様](../design/graphics/static-text-wrap-design.md)。

## 塗り・枠線のα一括編集（I4）

`selection-paint-alpha.ts`は項目別適用可否・現在値・全件検査後の変更を担当する。`editor/selection-handler.ts`から呼び、`designer/SelectionPaintAlpha.svelte`とフォーム変換で所有者・選択・draftを接続する。`selection-paint-alpha.test.ts`が原子性・no-op・Undo・共有定義、`e2e/selection-paint-alpha.spec.ts`が実操作・入力保護を担当する。[採用仕様](../design/graphics/selection-paint-alpha-design.md)に従う。

## 混在図面の計測とSVG文字計測（I5）

`apps/banto-scada/scripts/mixed-editor-fixture.mjs`は公開サンプル＋自作PNG、`benchmark-mixed-editor.mjs`は本番ブラウザでの実操作・保存原本・資源寿命・投影比較を担当する。`svg-text-measure.ts`は複数行Textの一時SVG probeとfont／SVG座標変換・finally解放を担当し、`MultilineTextPrimitive.svelte`の既存折返し計算へ接続する。大域cacheやProject属性は追加しない。`e2e/svg-text-measure.spec.ts`は変換・文字寸法・失敗時解放、`e2e/multiline-text.spec.ts`は共通描画・入力と保存を確認する。[条件と結果](../performance/mixed-editor-quality.md)を参照。

I5bでは`benchmark-editor.mjs --mixed`が同じ混在fixtureのドメイン費用を担当し、`benchmark-mixed-editor.mjs`の`keyBreakdown`はwarmup2回＋移動9回＋Undo9回のCDP差を保存する。`history.ts`の復元候補はrevision変更後に一度再検証し、snapshot入口と現在状態の検証を維持する。`history.test.ts`はUndo／Redo両方向の不正履歴・現在状態・revision上限での原子的拒否とテキスト正規化を追加確認する。[I5bの根拠](../performance/mixed-editor-quality.md)を参照。

I5cの診断は`profile-editor.mjs`（独立したCPU採取）、`summarize-editor-profile.mjs`（source mapで関数開始位置へ対応、self／inclusive集計）、`compare-editor-load.mjs`（別buildをA/B/B/A順に読込）に分ける。通常の性能値は既存`benchmark-mixed-editor.mjs`へ残す。AppのProjectとproject-files controllerの確認待ちcandidateはルート差替えを監視し、ネストした変更通知には使わない。編集入口はcommand・history・adopt。`save-state.spec.ts`で確認置換後の編集・Undo／Redoと保存baselineも確認する。[I5cの根拠](../performance/mixed-editor-quality.md)を参照。

I5dの一律隔離候補は速度面の採用条件を満たさず未採用。現行`TextPrimitive.svelte`は図面側の直接計測、`MultilineTextPrimitive.svelte`は既存の隔離計測を維持する。`profile-text-load.mjs`はnative getBBoxの場所別回数・時間、CDP差、全Text投影を診断する。`svg-text-measure.spec.ts`の単一行fit両テーマ288条件比較は残し、従来の寸法・非表示／失敗時解放も維持する。候補patchと比較専用Vite configは`docs/performance/i5d-*`へ保管し、通常buildでは読み込まない。[I5dの結果](../performance/mixed-editor-quality.md)を参照。

## タグ参照名の置換基盤（I6a）

`lib/binding-replacement.ts`の`previewBindingReplacement`が完全一致の全画面差分・既存参照先・ロック／グループの拒否理由を算出する。`applyBindingReplacement`はsnapshotを照合して対象を再収集し、`editor/project-handler.ts`の`replace-binding-reference`から候補Projectへ適用する。最終検証・revision・履歴は従来の`applyCommand`／`recordEdit`が所有する。`binding-replacement.test.ts`が不正・no-op・原子性・世代・Undo／Redoを検証する。I6bの`designer/BindingReplacement.svelte`を`BindingReferences.svelte`から開き、全画面差分・取消・明示適用を表示する。AppからProject・編集scope・既存draft guard・editを渡し、`revealDraftForm`／`validateDrafts`が未適用の置換を保護する。`e2e/binding-replacement.spec.ts`は両テーマ・IME・履歴・保存・Project差替えを検証する。[詳細仕様](../design/equipment/text-reference-replacement-design.md)を参照。

## Symbol内画像へ向けた資産参照基盤（I7a）

`lib/asset-references.ts:imageAssetReferences`は画面背景・直接Image・全Symbol定義から所有者付き参照を投影する。`project.ts:referencedAssets`とRustの`referenced_assets`は保存対象の集合を作る。`clipboard-dependencies.ts`は選択配置から到達する定義／埋込画面だけを収集する。両者の範囲を混同しない。共通低層fixtureは`examples/image-reference-cases.json`、TSの契約試験は`asset-references.test.ts`。I7aでは公開validatorのSymbol内Image拒否を維持した。保存・paste再配線・描画は[I7b](../design/images/symbol-image-design.md)。

## Symbol内Imageの保存・共通表示（I7b）

Project0.34.0のSymbol定義はImageを許可する。`editor/paste-handler.ts`は実取込する定義を決めてから内部画像の原本登録・ID再配線を行い、現行定義再利用の境界で古い資産の展開を止める。`ObjectPainting.svelte`／`designer/SymbolThumbnail.svelte`はImagePaintingを呼び、Appからパレット・定義一覧・レイヤー・お気に入りへ画像Mapを渡す。親Symbolのopacity／colorAlphaは従来の合成位置を保つ。`symbol-image.test.ts`、RustのSymbol画像契約、`e2e/symbol-image.spec.ts`と原本同梱サンプルが受入入口。[段階設計](../design/images/symbol-image-design.md)のI7cでは下記の既存入口へ接続する。

## Symbol内Imageの取込・編集（I7c）

`editor/image-handler.ts`は画面とSymbol定義に共通の配置・差替え・fit／cropを扱う。owner／lock／mode検査とfinish・履歴は従来どおり呼出側に残す。`designer/controllers/image-import.svelte.ts`のscreenIdは現在のキャンバス（定義なら定義ID）を指し、既存epochを使って往復後の遅延適用を止める。背景だけは定義で拒否する。clipboard controllerの画像拒否を外し、定義で非対応のgroup／Symbol／View／タグ付きTextはpaste-handlerに残す。Inspectorとfit／cropフォームは同じdraft・IME・対象照合を使用する。`symbol-image-authoring.test.ts`と`e2e/symbol-image-authoring.spec.ts`が受入入口。

## 接続・配管追従の幾何（I8a）

`lib/connection-geometry.ts`はSymbol配置枠のanchorをworld座標へ投影し、Polylineの両端を同時に変更して暗黙pivotの差を補正する。中間点と自由端点のworld座標を保つ。ID解決・lock／group・保存・UIは所有せず、`connection-geometry.test.ts`で幾何だけを確認する。公開Projectへの接続は[I8b以降](../design/editor/connection-follow-design.md)。

## 接続の保存・全編集・コピー（I8b）

Project0.35.0の`Polyline.shape.connections`は同一画面のSymbol配置IDを参照する。`connections.ts`のvalidate／resolve／remapを保存読込・finish・Renderer一時操作・各複製とclipboardへ接続する。画面の依存取込はrenewOwnerIds、root貼付はplacementIdsで別々に対応付ける。Rustは`scada-model/src/connections.rs`、共通ケースは`examples/connection-cases.json`、native sampleは`connection.project.json`。serde_jsonの`float_roundtrip`とTS同順の角度演算も保存精度の契約。`connections.test.ts`、`connection-contract.test.ts`、`e2e/connections.spec.ts`が受入入口。接続設定UIはI8c。

## 接続・解除の設定UI（I8c）

`designer/ConnectionSettings.svelte`は端点ごとの明示フォーム・配置順付き候補・適用済み状態・lock／group／候補なしの表示を担当する。`designer/forms/line-connection.ts`はAppのcommand構築と一括draft事前検証から共用し、generation／owner／対象・候補・anchorとIME状態を検査する。InspectorのSymbol側は`connectionUsages`を投影するだけで、別の参照台帳を持たない。`line-connection-form.test.ts`と`e2e/connection-settings.spec.ts`でUndo・保存往復・両テーマ・同名候補・複数draftの部分適用防止を確認する。

## 保持中履歴の資産索引（I5g）

`history-assets.ts:createHistoryAssetCollector`はAppごとのclosureに、現在のpast／futureのsnapshot文字列→hash配列だけを保持する。現在Projectのassetsは毎回読み、脱落snapshotを捨てる。全抽出成功後にStore.collect、collect成功後に索引を置換する。Store／Blob／URL／pin／leaseとProject検証は所有しない。App.collectAssetsはこのhelperへ委譲し、既存のeffectと画像処理の回収入口を共用する。`history-assets.test.ts`が保持集合・再利用・失敗・脱落・初期化を、`image-replacement.spec.ts`が実原本のRedo破棄／50履歴上限・保存を、`symbol-image.spec.ts`が同一package再読込時のStore更新／URL解放を確認する。

`compare-editor-load.mjs`の`--keys`／`--history`は通常の交互操作比較、`profile-editor.mjs --history`は50履歴を事前投入した別CPU診断。`summarize-editor-profile.mjs`の任意filterは上位30件から落ちた対象関数も抽出する。I5fの画像Map候補は速度根拠がなく未採用で、patch／source overlay configだけを保管する。[採否と測定条件](../performance/mixed-editor-quality.md#history-asset-index)を参照。

### I5hの読込診断

`apps/banto-scada/scripts/profile-editor-load.mjs`は初回取込／同一package再読込だけを計測し、通常runと`--cpu`を分ける。`--direct-file-query`で計測側の入力欄検索を比較できる。時間計測後に文字投影・原本SHA・旧URL解放を確認する。`summarize-editor-profile.mjs`はnative呼出しを最も近いmapped callerへ集計する。[結果と制限](../performance/mixed-editor-quality.md#load-diagnostics-i5h)。通常アプリへの計測APIは追加しない。

## S7 SOAK中の読取開発（P1）

`scada-runtime::project_view(plan, state)`／`read_slot_view(plan, state)`はSDKの同一世代snapshotから投影する。`projection.rs`はresolutionの要求対応・型・Quality・値側sourceを検証し、`slots.rs`は機器contextへ配る。別catalog取得・ネットワーク・session寿命は所有しない。表示DTOはRustのschemaと`lib/read-slot-session.ts`で共有し、Unboundの無値診断を受け入れる。関連検証は`tests/sdk_projection.rs`、`examples/read-slot-view-cases.json`、`read-slot-session.test.ts`、`e2e/read-slot-session.spec.ts`。[工程・未実装境界](../project/soak-independent-runtime-plan.md)を参照する。

## Project単位の読取Host（P2）

`crates/scada-runtime/src/host.rs`の`ReadHost`がProjectのText／slot要求とSDK handleの所有者。`ReadPlan`が重複排除、`Running`がSDKとpumpの終了、`publish_if_current`が同じwatch slot内のsession照合を担当する。`RuntimeView::pending`／`ReadSlotView::pending`は無値DTOの共通生成。SDKの再試行・再解決を複製しない。関連検証は`tests/read_host.rs`とHostの旧token拒否試験。[API・取消・drop・未接続境界](../design/runtime/read-host.md)を参照する。画面のHost transportはまだ接続していない。

## 表示DTOとAppのsession配布（P3a）

`display.rs:ReadDisplayStream`はHost sessionに束縛した連番付き`ReadDisplayUpdate`を生成する。ローカルtokenは直列化しない。`schema/{runtime-view,read-display-update}.schema.json`は既存slot schemaを参照する。`lib/read-presentation.ts`は両DTOの一括検証、旧sequence／SDK世代の拒否、guard付きreadingsとequipment contextを所有する。

`designer/controllers/read-presentation.svelte.ts`はAppから現在Project／任意ReadSourceのgetterを受け、session reset、購読解除、旧callback拒否を所有する。Project・編集履歴はAppに残す。CanvasWorkspace・Minimap・PreviewPopupsは同じcontextを受け、Primitiveの数値TextもQualityと由来を描画する。通常entrypointにはsourceを渡さない。

関連検証は`display.rs`のRust単体、`examples/read-display-cases.json`、`lib/read-presentation.test.ts`、`e2e/read-presentation.spec.ts`。既存`read-slot-session`と型付きslot表示を再利用する。[製品transport未実装の境界](../design/runtime/read-presentation.md)を維持する。

## Host catalogとタグ選択（P4）

`crates/scada-runtime/src/catalog.rs`の`CatalogHost`がSDK REST clientとProject／要求tokenを所有する。`request().fetch()`は一度だけ取得し、`accept`が最新要求と一致した結果だけを公開する。`catalog_view`はSDKの重複名検査を再利用して表示metadataへ投影する。`schema/catalog-view.schema.json`と`examples/catalog-view.json`をRust／TSで共有する。値購読・再接続・自動pollを所有しない。

`lib/catalog-session.ts`はProject所有者・payload検証・immutableな候補・旧delivery拒否を担当し、`designer/controllers/catalog.svelte.ts`は任意CatalogSourceの購読寿命を担当する。`tag-catalog.ts`はmetadata階層と型互換、`TagPicker.svelte`は検索・確認・明示選択、InspectorPanelとEquipmentLibraryは現在の配置／機器／slotと入力要素の再確認を所有する。適用・保存・履歴は既存フォームに残す。

関連検証はRust `tests/catalog.rs`、`catalog-session.test.ts`、`e2e/catalog-selection.spec.ts`と既存tag-picker／equipment系。製品transportと資格情報は[P3b](../design/runtime/transport-boundary.md)に残し、通常entrypointはsourceを渡さない。

## Historian／Trendの設計入口（P5、未実装）

[Historian／Trend契約](../design/runtime/historian-trend-contract.md)と[ChronoGazer固定版の共通利用調査](../reviews/chronogazer-historian-reuse.md)を後続実装の入口にする。現行の`ReadHost`／`ReadDisplayStream`とSDK watchは最新snapshotの表示用であり、全変化の永続記録には使わない。記録設定・系列identity・History API・liveとの接続・障害分離は新契約の実装を必要とする。共有crateの切出しやアプリの取込みはこの文書工程に含めない。

## Historianの純粋契約（H1）

`crates/scada-historian/schema/history-contract.schema.json`が版付きquery／sampleBatch／resultの構造を規定する。`scada-historian::validate_history_contract`と`lib/history-contract.ts`は同じSchemaの検査後、期間・点数・identity・record／segment参照・Quality／sourceと値・順序・coverage・watermarkの関係を検査する。JSON整数の1／1.0を同じ意味で扱い、unsafe整数は構造検査で拒否する。

`examples/history-contract-cases.json`の110 fixtureをRust／TS／実ブラウザで共有する。`crates/scada-historian/tests/contracts.rs`、`history-contract.test.ts`、`e2e/history-contract.spec.ts`が検証入口。通常Appはこのmoduleをimportせず、UI／ネットワーク／DBへ接続しない。[H1の保証範囲](../design/runtime/historian-contract-fixtures.md)と[H2の保存設計](../design/runtime/historian-storage-decision.md)を混同しない。

## Historianの原子append adapter（H2a）

`crates/scada-historian/src/store/mod.rs`の`SqliteStore`が専用directoryのOS writer lock、format／deployment照合、固定session開始・終了・interrupted検出、1tickのtransactionとreceipt再送を所有する。`store/types.rs`がRust入力型、全member・同周期・H1意味規則・同Hub世代の照合、型付きlogical payloadの正規化を所有し、source世代のu64は内部canonicalで10進文字列として保持する。

`store/schema.sql`は独立DB format 4のDDLとidentity／record FK・値CHECK・時刻索引を規定する。`lib.rs`のprivate identity検査はH1 canonical定義を再利用し、空のsampleBatchへ変更しない。`store/tests.rs`は使い捨てDBとprivate fault hook／child processで原子性・冪等性・型・世代・排他・再openを確認する。H2a自体は保存コアに限定し、検索・coverage生成・保持は下記H2b／H2c1が担当する。UIのDB直読は追加せず、容量運用・常時recorderは後続へ残す。

## Historianのraw snapshot検索（H2b1）

`crates/scada-historian/src/store/query/mod.rs`の`HistoryReader`が専用READ_ONLY接続、同一snapshot内のmetadata／raw／watermark投影、H1 result検査、typed error、transaction終了を所有する。`query/control.rs`は共有取消token・単調deadline・VM／decode行／結果bytesの有限予算を所有し、SQLごとの端数も保守的に計上する。公開factoryは`SqliteStore::reader()`で、最大2個のidleを含むreader leaseがwriter lockを共有し、全接続の終了まで排他を維持する。

`query/tests.rs`が競合・取消・処理量・cleanupのunit試験、`store/test_support.rs`がH2a／H2b共通の一時DB・型付き入力fixtureを担当する。`tests/query_fixtures.rs`が`examples/history-query-cases.json`の実SQLite出力を照合し、TS `history-contract.test.ts`と実ブラウザ `e2e/history-contract.spec.ts`も同じ期待resultを検証する。coverageと期限除去は下記H2b4／H2c1で追加した。通常Appからの利用・容量運用は後続へ残し、UIのDB直読は追加しない。

## Historianのmin/max集約（H2b2）

`store/query/mod.rs`の`query_minmax`はrawとsnapshot・metadata・watermark・予算・cleanupを共有し、`query/minmax.rs`が整数共通grid・SQL要約の検査・bin状態・空binのmetadata根拠を所有する。`query/minmax.sql`はbound parameterの有限descriptor対応表と既存時刻索引を使い、SQL内で値／無値／破損・domain混在・極値・件数をbinへ集約する。Rustへ全rawを展開しない。

`query/minmax/tests.rs`が具体的な境界・ピーク・件数、混在・破損・NUL・取消、9,001tickの集約とH1 sample理由の一致を確認する。`tests/query_fixtures.rs`が新しい`examples/history-minmax-cases.json`の6成功／1失敗を実SQLiteと比較し、成功resultは既存TS／ブラウザ契約テストでも共有する。公開JSON SchemaやDB formatを緩めて通さない。[H2b2設計・残り](../design/runtime/historian-minmax-query.md)を参照する。

## Historianの記録期間と欠測証拠（H2b3）

`store/evidence.rs`がPlanRef／TimedStart／ClockStamp／GapEvidenceと、timed begin／close・interrupt・gap保存・session_evidence照会を所有する。`store/mod.rs`は既存begin／closeと原子transactionを共有し、新tickのreceipt再送判定後に証拠frontierを同transactionで進める。SQL／I/O失敗のNeedsReopenとwriter／reader所有を維持する。

`store/schema.sql`のDB format 2はimmutable plan snapshot、sessionの時刻根拠、局所gap ledgerと索引・FKを追加する。format 1や版不一致はopenで拒否し、自動migrationしない。`evidence/tests.rs`は一時DBとエラー／process終了で、根拠・状態・counterの原子性、再送、clock規則と区間矛盾、非変更拒否を確認する。証拠保存と公開coverage投影を分け、後者は以下のH2b4で同snapshotから検証する。

## Historianの証拠からのcoverage投影（H2b4）

`store/query/coverage.rs`がsession／plan／永久descriptor／gapの参照・状態検証、他domainの可能期間を除く区間演算、残存欠測内recordのSQL EXISTS確認、結合・unknown補集合・最大256区間を所有する。`query/mod.rs`はraw／minmaxから同じ関数をsnapshot内で呼び、EvidenceLimit／CoverageLimitを公開する。`query/control.rs`は既存予算に加えて証拠JSON本文64 KiB／要求入力合計8 MiBをparse前に検査する。入力合計は利用者が下げられる出力bytesとは独立し、全系列で共有する。

`query/coverage/tests.rs`が他session・未確定終了・untimed、snapshot競合、端点、上限、破損参照・永久descriptor照合と取消後cleanupの14単体試験を担当する。`tests/query_fixtures.rs`はtimed開始／gap／終了を組み立て、`examples/history-coverage-cases.json`の6成功出力を実SQLiteと比較する。TS `history-contract.test.ts`とブラウザ `e2e/history-contract.spec.ts`も同じ期待resultを共有する。[H2b4設計](../design/runtime/historian-coverage-projection.md)を参照。保持・容量・復旧・recorder・製品API／画面接続は後続。

## Historianの原子trimとexpired（H2c1）

`store/retention.rs`がTrimRequest／TrimReceipt、記録停止中のCAS付きcutoff、全member tick単位の候補・receipt照合、ledger／削除／fenceの原子commit、有限予算を所有する。cleanupは以下のmaintenance共通guardで、失敗時はpanic中もwriterをNeedsReopenへ固定する。同moduleのfence検証をappend／trim／queryで共有し、`store/mod.rs`は既存tick receipt再送の後で新tickのcutoffを検査する。`next_commit`は同transaction内のConnectionを受け、呼出側がSQLごとの予算を課金する。

`schema.sql`のformat 3はretention_state／retention_operations／expired_samplesと全store時刻・tick member検索の索引を追加する。`query/coverage/expired.rs`が同snapshotの実削除timestampの検証と優先overlay、`coverage.rs`が全証拠の最終coalesce／256区間・残存record確認を所有する。`query/control.rs`のBudgetはstore内部で共用し、公開APIを増やさない。

`retention/tests.rs`の13単体は原子性・receipt再送・fence・上限・異常時刻・SQL failure・process終了・取消／panic cleanupを担当する。`query/coverage/expired/tests.rs`の5単体がsnapshot競合とcoverage・上限・破損を検証する。`tests/query_fixtures.rs`は`examples/history-retention-cases.json`の6ケースを実SQLiteから照合し、TS／ブラウザも期待resultを共有する。自動保持・物理消去・receipt GC・容量運用は[後続](../design/runtime/historian-retention.md)。

## Historianの容量診断と明示checkpoint（H2c2）

`store/maintenance.rs`のStorageDiagnostics／CheckpointReportとSqliteStoreの2 APIが、SQL page snapshot・filesystemの別sample・reader lease数、64 MiB事前guard、一度だけのPASSIVE結果分類を所有する。DB fileは両APIのSQL開始前に検査し、diagnosticsは後段でもfile長をsampleする。Complete／Incomplete／Busy／NoWalを区別し、成功後のlate cancellationではreportを捨てない。内部I/Oのhard deadlineは保証しない。

同moduleの`Operation`がprogress handler解除→rollbackと直接needs_reopen保持を共通化し、retentionもこのguardを使う。`maintenance/tests.rs`の15単体（child worker含む）が診断・free page・上限・各失敗とprocess終了後の整合を担当する。`query/tests.rs`の追加1単体がreader snapshot pin中のIncompleteと旧query維持、解放後Completeと所有を確認する。既存ブラウザ契約5件も回帰する。公開History JSONやTS/UIへ新DTOを接続せず、[H2c2設計](../design/runtime/historian-maintenance.md)のlibrary境界を維持する。

所有者不在を前提とする`store/test_support.rs::reopen_unowned`は、並列process試験のFD寿命と整合する一時的なlock競合に備え、Busyだけを最大1秒retryする。TempStore::openと、形式／identityなどの非Busy結果を検証するfixtureで共用する。他のエラーは即失敗する。Unixの複製FD回帰で待機と製品の即時Busy拒否を確認し、所有競合の試験は製品APIを直接使い続ける。

## HistorianのSQLite FULLと復旧（H2c3）

`store/maintenance.rs::sqlite_failure`がSQL原因と協調取消の境界を所有し、retention／maintenanceが共用する。primary OperationInterruptedかつ対応control失敗の場合だけControlへ変換する。FULL／I/O等を隠さず既存after_writeでwriterをNeedsReopenにする。公開error型とformat 3は維持する。

`store/write_failure_tests.rs`の6単体が、通常append自然増大のFULL、TEMP triggerでのappend／plan／gap／close／trimの実FULL、rollbackとreceipt／session／fenceの復旧を担当する。pressure table／trigger／max_page_countはprivateな使い捨てDBだけへ適用する。`maintenance/tests.rs`が同writerのFULL＋取消と期限切れでの分類、`retention/tests.rs`がaux SQLiteの実FULLをhookから渡す取消併発を検証する。両者を本writer trimのFULL試験と混同しない。既存process終了とブラウザ契約5件を回帰し、[H2c3設計](../design/runtime/historian-write-failure-recovery.md)の未検証境界を維持する。

## Historianの永続保持job（H2c4）

`store/retention/jobs.rs`がJobRequest／JobStepRequest、begin／step／status、連番とstable receipt、quiescent gate、pendingから公開証拠への移動、完了fenceを所有する。`retention.rs::validate_ticks`は単発trimとjobで対象member／receiptの照合を共有する。begin／appendはreceipt再送を先に判定し、active jobがあれば新規操作を拒否する。共通run_maintenance／Operationで有限予算・取消・rollback・NeedsReopenを維持する。

format 4のretention_jobs／retention_job_steps／retention_job_pending／job_expired_samplesが進捗を保存する。`query/coverage/expired.sql`は単発／job両sourceの参照・最新step／累積件数・重複を検証し、連続msを最大256 islandへ集約する。`expired.rs`は有限行の検査とoverlayを担当し、最終coverage256区間と残存rawの拒否は既存coverage.rsへ残す。

`retention/jobs/tests.rs`の18単体（child worker含む）が1025集中／連続、入場・再送・破損・FULL・process終了・取消とcleanupを確認する。`query/tests.rs`の追加1単体が途中stepとsnapshotを確認し、`tests/query_fixtures.rs`が`examples/history-retention-job-cases.json`の6ケースを実SQLiteと照合する。TS／ブラウザも同じ期待resultを共有する。[H2c4設計](../design/runtime/historian-retention-jobs.md)の後続範囲を維持する。

## Historianの復旧状態照会（H2c5）

`store/recovery.rs`がStoreRecoveryState／RetentionFence／FenceSource／ActiveJobRecovery／StepRecoveryと`SqliteStore::recovery_state`を所有する。最初のlast_commit readでsnapshotを固定し、fenceの最新出典と同率重複、active session／jobの小件数照会、active sessionの型付きspec・sequence・最新receipt headerを検査する。論理状態を更新せず、内部commit位置をH1 snapshotIdへ混ぜない。

`retention/jobs.rs`はJob::into_statusを既存statusと共用し、recover_active／validate_completed_source／check_headで型付きjob・最新step・実MAX stepとfenceの整合を検証する。共通run_maintenance／Operationで予算・read transaction cleanup・poison規律を維持する。

`recovery/tests.rs`の15単体（child worker含む）が初期状態・active session・IDなし再起動発見・途中／完了・正確な再送・出典更新・stale値・同snapshot・読取専用性・破損・失敗とcleanupを確認する。既存ブラウザ契約6件も回帰する。新APIはRust library内に限定し、自動driver・製品transportは[後続](../design/runtime/historian-recovery-state.md)。

## Historianの保持候補の時刻安全判定（H2c6）

`store/retention/clock_guard.rs`がRetentionClockPolicy／ClockSample／GuardStateと純粋関数`assess_retention`を所有する。full policy snapshot、2 sampleのwarmup、wall／monotonic連続性、sticky Suspendedと明示rearmを扱い、候補上限・既存job・記録停止待ちからactionを返す。OS時計やtimezoneを読まず、job ID生成・DB操作をしない。

`clock_guard/validate.rs`はpolicy／保存guard／recovery DTO／safe cutoffの構造・相互関係を検証する。jobの直近receiptを差し引いた過去tick・観測数の範囲もu128で検査する。新sampleの不正はInvalidInputへ逃がさず停止状態に残す。proposalは判断時点の説明で、実行tokenではない。

`clock_guard/tests.rs`は状態・優先順位・算術境界、`tests/invalid.rs`は不正入力と累積件数、`tests/integration.rs`は隔離DBの無変更性・明示job実行・記録close・stale拒否を担当する。新規22単体のうちDB統合4件、既存ブラウザ契約6件を回帰する。自動host・製品policy／信頼時計・recorder調停は[後続](../design/runtime/historian-retention-clock-guard.md)。

## Historianの一回分の保持coordinator（H2c7）

`store/retention/coordinator.rs`がCoordinatorInput／Intent／Report／Outcome／Errorと`SqliteStore::coordinate_retention_once`を所有する。recoveryを一回、assessを一回、明示beginまたはstepを最大一回呼び、観測と適用を別transactionのまま接続する。Beginはproposalとのcutoff／fence一致、ContinueExistingはactive job ID一致を確認し、正確なrequestを既存APIへ渡す。

reportは評価済みのnext_state／assessment／recoveryを操作エラーでも保持する。InvalidInput時だけrearm_required=true。既存job／maintenanceの予算・cleanup・poisonを再利用し、同controlのdeadline／tokenを渡す。自前loop・retry・ID生成・次step選択・session終了は追加しない。

`coordinator/tests.rs`の9単体がread-only観測、開始条件、再送・発見、時計停止と明示継続を、`tests/failures.rs`の7単体が取消・予算・入力不正・競合・SQL／実FULLとreport保持を担当する。既存ブラウザ契約6件を回帰する。製品scheduler／信頼時計／recorder協調は[後続](../design/runtime/historian-retention-coordinator.md)。

## Historianの明示duration policy（H2c8）

`store/retention/policy.rs`がCutoffRule／DerivedCutoff／CutoffErrorと純粋`derive_cutoff`を所有する。elapsed msをreference UTC msから広い整数で引き、safe範囲を検査する。policy検証は`clock_guard/validate.rs`を共用し、default・丸め・timezone・DB操作を持たない。

`clock_guard.rs`はcutoff_ruleを全policy snapshotに含め、ExplicitCandidate／SomeとElapsed／Noneのmodeを検査する。clock評価・active job・非stable待機の後、安定した新候補だけを内部導出し、失敗はCutoffComputationFailedへ停止を保持する。`coordinator.rs`はOptionをそのまま渡し、従来のproposal一致とreport保持を使う。

`policy/tests.rs`の7単体が整数・policy／mode・時計停止・rearmを、`tests/integration.rs`の5単体が実DBの停止待ち・canonical Begin・削除境界とraw／expired・上限・既存job継続を担当する。既存Explicit guard／coordinator試験は明示mode／Someへ移行し、ブラウザ契約6件を回帰する。暦日保持・製品policy／短縮プレビューは[後続](../design/runtime/historian-retention-duration.md)。

## Historianの保持変更の実データ影響preview（H2c9）

`store/retention/preview.rs`がRetentionPreviewRequest／RetentionPreview、policy影響・差分・件数DTOと`preview_retention_change`を所有する。elapsed policyを同referenceで導出し、提案／比較／非空差分側の最大3集約とtick／observation partitionを検証する。比較policyをappliedと扱わず、削除や適用を行わない。

`preview/validate.sql`はmax cutoffで選択されたtickの全memberを検査し、member集合・時刻／clock／commit・session／参照・ASCII IDとNULを照合する。spec／receipt JSON本文や値の全監査は実stepへ残す。`counts.sql`はrawをRustへdecodeせず、tick／observation／distinct seriesとsample extremaを集約する。単一Budgetで部分countを返さない。

`recovery.rs::read_snapshot`へ既存復旧照会のtransaction内部読取を抽出した。既存`recovery_state`とpreviewが同じhelperを使い、各callerがBEGIN／ROLLBACKを所有する。last_commit初回readのsnapshot pinと既存hook／予算・cleanup・poisonを維持する。

`preview/tests.rs`の6単体が件数・差分・境界・active／partialを、`tests/failures.rs`の8単体がreadonly、同snapshot、破損／NUL、1025tick／有限予算、取消・panic・SQLfailure／rollback poisonを担当する。既存recovery15単体とブラウザ契約6件を回帰する。永続policy適用・製品管理口は[後続](../design/runtime/historian-retention-preview.md)。

## Historianの保持policy原子適用（H2c10）

`retention/application.rs`がAppliedRetentionPolicy／PolicyPreparationRequest／Preparation／PolicyApplyRequest／Receiptと実applied比較preview・原子適用を所有する。同request再送を先に照合し、新規要求ではapplied revisionとpreview snapshotをCAS、active job拒否、同transactionのfresh preview、immutable定義／operation／current pointerを保存する。削除やguard rearmは行わない。

`application/read.rs`がdefinition起点、current pointerと最新世代／commit、型付きrequest／receipt／保存previewを検証する。直前世代はmetadataだけで比較し、前receiptを再帰decodeしない。`recovery::read_snapshot`は実appliedを同snapshotで返す。`preview::build_preview`と`validate_saved_preview`は新規集約と保存結果の意味検証を共有する。

format 5のpolicy定義／適用／stateとjob.policy_applied_revisionが永続根拠を所有する。`jobs.rs`はcoordinator専用bound beginのwrite transaction内で現在appliedの世代・全文を再照合し、内部StoredJobRequestと列のoriginを一致させる。`coordinator.rs`は新Beginの未適用／不一致をNoWriteとし、Observe／固定job継続と直接保守APIを維持する。policy／preview／recovery保存DTOのDeserializeを追加し、GuardState復元は増やさない。

`application/tests.rs`の5単体が適用・実比較・CAS・記録／job・再送・bound source、`tests/failures.rs`の10単体（child worker含む）が容量不足・取消／fault・破損・旧format・origin・非再帰・SQLpoison・process5境界を確認する。coordinatorの新1単体が判定とbegin間のpolicy変更を検証する。既存coordinatorの正常Begin試験は適用済みElapsedへ移行し、counterは適用commitを含める。ブラウザ契約6件を回帰し、[製品統合](../design/runtime/historian-retention-policy-application.md)は後続とする。

## Historianの位相固定周期recorder（H3a）

`src/recorder.rs`がRecorderのstart／step／stop、固定anchorとslot計算、clock連続性、capture後のslot再評価、実UTC tick、missed gap、terminal cleanupを所有する。最大一capture／一gap／一tickで同期実行し、source／DB処理完了を次anchorへ加算しない。予定slotと連続commit sequenceを分離し、horizon外にtickを押し込まない。

`recorder/types.rs`が明示Config、Clock／Source trait、counter／ObservedSlot／Report、停止原因とcleanup結果を所有する。`recorder/clock.rs`はInstant originと実SystemTime、取消確認付きabsolute waitを担当する。無制限のイベントvector・背景task・queue・実SDK接続は追加しない。

`store/types.rs`の既存ID／SessionSpec／Tick検証をcrate内で共用し、検査を複製・弱体化しない。test_supportのcrate内可視性とconnection accessorはcfg(test)のfixtureだけに限定する。製品のwriter lock／再open規律は維持する。

`recorder/tests.rs`の5単体が仮想1h／各系列3600点・相対sleep対照、overrun／gap／raw・minmax、capture境界／horizon、無値・固定source・sourceTime、early wakeを担当する。`tests/failures.rs`の11単体が取消・clock／epoch／source異常・overflow・実FULL／gap成功後失敗・std時計待機を担当する。ブラウザ契約6件を回帰する。専用SDK所有・永続slot台帳・複数group／queue・保持協調は[後続](../design/runtime/historian-periodic-recorder.md)。

## Historianの専用SDK入力（H3b）

`crates/scada-runtime/src/recorder_source.rs`がUIに依存しないSDK handleとSnapshotSource実装、sticky error、世代の前進、shutdown／取消／再呼出しの結果保持を所有する。SDK状態を一度cloneし、別pumpや表示watch cacheを挟まない。正常joinが未確認なら終了再呼出しでも成功へ変えない。

`recorder_source/plan.rs`がSessionSpecと選択時catalog／binding pinを検証し、固定groupの要求を生成する。`projection.rs`が件数上限、同世代metadata、identity／値側source、Quality／無値・sourceTime／SourceEpochを検査する。catalog収集周期をHistorian記録周期へ読み替えず、identity変更時はwholegroup停止する。

`scada-historian/src/store/types.rs`の公開`SessionSpec::validate`が既存内部検証へ委譲する。SDKの依存方向はruntime→historianとし、HistorianコアにSDK／tokioを持ち込まない。DB format 5・H1・周期計算は維持する。

`recorder_source/tests.rs`の8単体がpin・epoch・Quality／source・値の境界とsnapshot上限を担当する。`crates/scada-runtime/tests/recorder_source.rs`の9統合がloopback Hub→SDK→spawn_blocking上のH3a→実SQLite、exact replayによるepoch保存、raw／minmax、未解決／切断／再接続、source変更、UI寿命独立、Unauthorized・shutdown取消／再呼出し・Dropを検証する。[設計・SDKの限界・後続](../design/runtime/historian-sdk-source.md)を参照する。

## Historianの単一group実行Host（H3c）

`crates/scada-runtime/src/recording_host.rs`がwriterと一つのblocking JoinHandleを所有し、start／request_stop／取消安全join／take_storeを提供する。開始は受理、FinishedUnjoinedは未join、Joinedは結果付きのidleとして区別する。Dropは取消要求だけで、blocking workerの完了・lock即時解放を偽称しない。

`recording_host/types.rs`がoptions、opaque run token、phase、sanitized progress／status、詳細completionを所有する。`worker.rs`がH3a反復・専用SDK shutdown・writer返却を担当する。status更新は同runへ限定し、StoppingをRunningで上書きしない。最新観測／各receiptを固定個数で残し、観測とreceiptが別stepである可能性を維持する。詳細エラーを監視statusへ流さない。

`scada-historian/src/recorder/types.rs`のRecorderConfig検証と`store/evidence.rs`のPlanRef検証を公開し、既存start／TimedStartでも同じ検証を共用する。保存形式と位相固定周期は変更しない。

`recording_host/tests.rs`の6単体が制御gate、取消・Drop中writer所有、panic／Faulted、開始前取消、旧run／phase、receiptと診断を担当する。`crates/scada-runtime/tests/recording_host.rs`の7統合がcurrent-thread SDK→Host→実SQLite、有限終了／raw照会、再join／差替え、開始／SDK終了失敗を検証する。既存source統合と共有するloopback fixtureは`tests/support/recorder_hub.rs`。実FULL／時計異常はH3aから継承し、Host固有試験の範囲と[後続](../design/runtime/historian-recording-host.md)を区別する。

## Historianの記録pauseと保持協調（H3d）

`crates/scada-runtime/src/recording_host/retention.rs`がturn入力／token／completion、Host所有guard snapshot、保持workerと取消安全joinを所有する。既存coordinate_retention_onceを一回呼ぶだけに限定し、予算・applied照合・exact step再送は既存store契約へ委ねる。

`recording_host.rs`が記録workerとの相互Busy、clean pause、新session／直前epoch差、job_pending／rearm_requiredによる再開拒否を適用する。保持中も元のclean completionを維持し、join時にwriter・next_stateを必ず回収する。Dropは両workerの取消を要求し、完了前のlock解放を偽称しない。新recording開始で過去turn completionを無効化し、guard／停止状態は消さない。

`recording_host/retention/tests.rs`の7単体がguard／失敗停止状態、全clean拒否条件、保持join取消・Drop／panicを担当する。`crates/scada-runtime/tests/recording_retention.rs`の5統合がmock Hub→記録→実applied保持job→step再送／expired→明示再開、異常・未適用／再利用拒否を検証する。既存Host差替え試験もfresh epochへ揃えた。[設計・状態の意味・試験範囲](../design/runtime/historian-recording-retention.md)を参照する。

## Historianの非同期History読取Host（H4a）

`crates/scada-runtime/src/history_host.rs`が一つのHistoryReaderと一つのblocking JoinHandleを所有し、start_query／exact tokenのcancel・join／take_readerを提供する。結果watchや無制限queue、暗黙fallback／再試行は作らない。未join Busy、通常エラー後再利用、ReaderUnusableとpanicの停止、Drop中lease保持を担当する。

`history_host/types.rs`がopaque要求token、軽いphase、H1結果またはQueryErrorを持つcompletionを所有する。coreの`store/query/mod.rs`に共有validate_query_request／HistoryQueryModeを抽出し、受理前8KiB／H1検証と既存readerのmode一致検査を共用する。QueryControlは同じdeadline／token／予算をworkerへ渡す。

`history_host/tests.rs`の7単体が拒否・token・取消join・待機中deadline・reader再利用・Drop／panic分類を担当する。`crates/scada-runtime/tests/history_host.rs`の5統合がraw／minmax・無値・unknownSeries、2lease、結果不変性、mock Hubの記録中検索から保持後expiredまでを検証する。製品transport／画面接続とは分けて[設計と試験境界](../design/runtime/historian-history-host.md)を参照する。

## History配送と共通Trend表示（H4b1）

`apps/banto-scada/src/lib/history/presentation.ts`が差替え可能なHistorySourceとcontrollerを所有する。一実行＋最新一待機、opaque token、query全文照合、Abort後のquiescence待ち、旧結果／sourceの拒否、状態通知の再入を扱う。`owned-json.ts`がaccessorを評価しないplain JSON所有とbyte／depth／node制限・凍結を担当する。H1 moduleは公開type aliasだけを追加し、validatorを複製しない。

`history/trend-model.ts`がvalidated H1から観測／bin／coverageを変えずにsegment別laneへ投影し、有限値scaleとUTCms fallbackを提供する。`TrendView.svelte`はraw点、numeric range、bool離散、無値／混在とcoverage別帯を描画する。raw線やbin中点は生成しない。

2単体fileの新規36件が配送・所有・再入・budgetと既存SQL結果projectionを担当する。`history/__fixtures__/HistoryPresentation.svelte`はe2e entry差替えだけでmountし、`e2e/history-presentation.spec.ts`の6件で両テーマと表示・取消・旧応答を受け入れる。既存H1 browser6件も回帰した。通常main／App／Projectは変更せず、[次の接続と限界](../design/runtime/historian-history-presentation.md)を分ける。

## 通常Appの履歴検索workspace（H4b2）

`lib/history/workspace-model.ts`がinprocess HistoryService／context契約、1MiBのplain JSON所有、H1 ID grammarを共用するAJV検証、Project ID／revision照合、canonical UTCとform予算からのH1 query生成を担当する。Hub tag名や最新metadataから系列IDを推測しない。

`lib/history/HistoryWorkspace.svelte`がModalの外に一つのcontrollerを保持し、Project object／workspaceGeneration／service identity／openのtupleと即時derived guardで表示・取得の寿命を扱う。form編集・close・差替えはsourceを一度undefinedにして旧結果を退役するが、未終了Promiseの物理slotは維持する。Appはoptional historyService、open flag、Project採用時closeと編集shortcut遮断を所有する。`designer-actions.ts`の表示menuに共通actionを追加し、常設menuも同じ入口を使う。

`workspace-model.test.ts`の新規39件がcontext所有・制限・UTC・選択とquery予算を検証する。`e2e/history-workspace.spec.ts`の新規8件は通常Appを保ちテストentryでserviceだけを注入し、両テーマ・未接続・寿命・検索・Project書出し不変を受け入れる。既存History／menu／Projectの24件も回帰した。正式wire API／adapter、永続Trend shape、Project schemaはこの工程で変更しない。[設計と限界](../design/runtime/historian-history-workspace.md)を参照する。

## 永続Trend定義・画面参照の設計入口（H4c）

[採用設計](../design/runtime/historian-trend-definition.md)が、独立した共通SchemaとRust／TS validator、ProjectのTrend原本とscreen参照shape、描画actionから既存HistoryWorkspaceへ渡す境界、接続namespaceの照合と寿命、copy／Undo／Symbol制限、受入・PR分割を定める。H4c1の独立契約とH4c2のProject 0.36.0保存・静的参照shapeを以下に実装する。保存定義からの履歴取得は下記H4c3へ分ける。

## 独立Trend定義の共通契約（H4c1）

`crates/scada-model/schema/trend-definition.schema.json`はstandalone文書と再利用するdefinition／penを所有する。H1のcanonical ID resourceへ外部参照し、Rust `scada-model/src/trend_definitions.rs`とTS `lib/trend-definitions.ts`が同梱schemaをローカル登録する。nativeは未登録retrieverを拒否し、ネットワーク取得へfallbackしない。crate依存を増やさない。

nativeの`validate_trend_definitions(&Value)`／`TrendDefinitions::from_value`／`as_value`と、TSの`validateTrendDefinitions`／`parseTrendDefinitions`が有限走査・Schema・意味検査・owned snapshotを担当する。JSON byte計数では有効な整数値の表記を揃え、TSだけに存在するaccessor／prototype／cycle等は既存`history/owned-json.ts`で拒否する。新しいscalar検査はTrend側に閉じ、H1や既存HistoryContextの受理を変えない。

`examples/trend-definition-cases.json`85件をnative `trend_definitions/tests.rs`、TS単体、`e2e/trend-definitions.spec.ts`で受け入れる。大きい入力はTS `lib/__fixtures__/trend-definition-cases.ts`とnative test helperの同じrecipeで生成し、fixture本体へ1MiBの値を重複保存しない。新規native4単体・TS96件・Chromium2件が所有／Unicode／予算／H1参照を担当し、既存History browser14件も回帰する。fixtureはテスト専用であり、validatorはH4c2のProject経路から呼び出す。[Projectへの組込み条件](../design/runtime/historian-trend-definition.md)を残す。

## ProjectのTrend定義と静的参照配置（H4c2）

`project.schema.json`のoptional trendsとtrendInstance、TS `project.ts`とnative `lib.rs`がProject 0.36.0を所有する。Trend／H1 resourceのローカル登録、H4c1 wrapperによる意味検査／予算再利用、内部参照存在・Symbol禁止を担当する。`trend_definitions::schema_options`がnativeの同梱resourceと外部取得拒否を共用する。global UUIDとTrend原本のID poolは分ける。

`editor/trend-handler.ts`がsave-trend／remove-trend、`single-object-handler.ts`がmake-trend-uniqueと参照変更を扱う。finish／recordEditが候補検証・no-op・revision・Undoを維持する。`TrendDefinitionsDialog.svelte`はlocal draftと有限pen編集、AppはProject object／generation／screenを捕捉したownerとcallback、Inspectorは参照とdraft baselineを所有する。メニューは既存action生成を共用する。

`TrendPainting.svelte`は値・queryを持たないSVGカード。metadataをApp→CanvasWorkspace／Minimap→Renderer→ObjectPainting／ScreenViewと、PreviewWindow→ScreenPaintingへ渡す。`clipboard.ts`はTrendを含むsystem clipboardを依存screenまで含めて拒否する。通常のduplicate／array／screen duplicateは原本参照を維持する。

`examples/trend.project.json`と`trend-placement-cases.json`18件をTS `__fixtures__/trend-placement-cases.ts`・`project-trends.test.ts`、native `trend_project_tests.rs`で受け入れる。新規TS26／native1が原子性・意味検査・参照・共有／独立化・拒否経路を検証する。`e2e/project-trends.spec.ts`の新規6件は通常Appの保存・再読込・Undo・draft・全投影とsystem clipboard拒否を担当する。H4c3の[検索接続と寿命](../design/runtime/historian-trend-definition.md)は下記の単一workspace側で担当する。

## 保存Trendの検索と接続宣言（H4c3）

`history/workspace-model.ts`がcontext v1／v2の同じ所有・予算検証、v2必須namespaceと全pen解決、共通Trend validatorによる定義snapshot、明示終了UTCからの安全な差引・四桁年roundtrip、定義順H1 query生成を担当する。namespaceはH1へ追加せず、このservice宣言の照合に限る。`saved-preset.test.ts`18件と既存context39件が純粋境界を検証する。

`App.svelte`がProject／世代／起点画面・配置／openごとのtokenを持つpreset要求を所有し、現在Projectから配置・定義を再取得する。`HistoryWorkspace.svelte`は既存のcontroller一つを維持し、preset identityも即時guardへ含め、未完了Promiseを残したまま条件・結果をclearする。preset中は終了UTCだけを編集でき、明示解除で手動formへ戻る。`TrendView.svelte`は検証済みpen presentationをseriesIdで対応させ、aliasとsegment metadataを区別する。

`TrendPainting.svelte`の任意SVG actionを`ObjectPainting`→`Renderer`／`CanvasWorkspace`ではpreviewだけ、`ScreenPainting`／`PreviewWindow`では独立Popupだけに接続する。`ScreenView`と`Minimap`へcallbackを流さない。`PreviewPopups.svelte`は画面targetと別にinstance tokenを持ち、close／destroyでAppの当該presetを退役する。Inspectorは編集時の同じ入口を呼ぶ。SVG focusはBanto公開Modal fallbackで戻す。Rendererのroleは操作可能な可視Trendがあるpreviewだけgroupとし、通常画像・非表示Trend・editのimgを維持する。`project-trends.spec.ts`でroleとkeyboard／focusの切替を受け入れる。

`e2e/saved-trend-history.spec.ts`は通常Appにテストentryだけからserviceを注入し、両テーマ・raw／minmax・namespace／系列不足・v1 gate・unknownSeries・保存不変・起点寿命・別preset／service差替え・Abort非協力時active1・色／別名・keyboard／focusを検証する。実adapter、Project版、H1、native、記録Hostはこの工程で変更しない。

## 記録計画の管理・適用の設計入口（H5）

[記録計画管理の設計](../design/runtime/historian-recording-plan.md)は、P5のdesired／deployment／applied分離、有限な独立JSON契約、永続適用のCAS／receipt、単一group supervisorと復元・失敗境界を定める。設計PR #42は文書のみの変更で、以下H5aから工程ごとに実装・検証責務を追加する。H5a〜H5cの台帳・activation・supervisorの実装責務は下記へ分離している。[H5d詳細設計](../design/runtime/historian-recording-project.md)のd1でProject保存を実装し、編集・管理画面はd2〜d4へ分ける。

現行の`scada-historian/src/store/evidence.rs::PlanRef`はID／revisionのsession根拠で、計画本体・hash・配布台帳ではない。`scada-runtime/src/recorder_source/plan.rs::SdkRecorderPlan`が一つのHub・周期と固定member／SDK pinを検証する。`recording_host.rs::RecordingHost`はwriterとworkerを所有し、startの受理とRunning、停止要求とjoin完了を区別する。新しい管理層はこれらの契約とH3d保持gateを迂回しない。

## 独立desired記録計画の共通検証（H5a）

`crates/scada-model/schema/recording-plan.schema.json`が版付きDesiredRecordingPlanの構造とcanonical H1 ID参照を持つ。native `recording_plan.rs`とTS `recording-plan.ts`が予算・member/name一意性・blank/scalarを含む受理、owned wrapper／frozen snapshotを所有する。未知fieldを全階層で拒否し、順序・文字列・disabled設定を保持する。ProjectのSchemaへはまだ組み込まない。

native `json_contract.rs`がTrendと記録計画のcompact JSON byte・node・depth walkとblank定義、TS `json-text.ts`がbounded owned JSONのscalar／blankを共有する。`history/owned-json.ts`はH5a用node上限引数を受け、従来callerの既定250,000を維持する。予算計数や名前の判定を各契約に再実装しない。

`examples/recording-plan-cases.json`139件をnative `recording_plan/tests.rs`、TS `recording-plan.test.ts`、`e2e/recording-plan-contract.spec.ts`で共用する。TSの`__fixtures__/recording-plan-cases.ts`とnative test helperが大きな不正入力のrecipeを同じ値へ展開する。browserは通常Appを保ちmoduleを評価し、remote schema取得なし、所有／member順、Project書出し不変、未知Project fieldの拒否を確認する。通常mainへテスト用serviceやvalidator画面を追加しない。

## 記録計画の永続台帳（H5b1）

`scada-historian/src/store/recording_plan/types.rs`は管理APIのowned型、`canonical.rs`はH5a再利用・mapping検証・member順／整数表記の正規化・SHA-256・完全な解決照合を持つ。`mod.rs`はQueryControlを保持する同期API、`write.rs`はreceipt先行のCASと一つのapply transactionを担当する。

`read.rs`は必須singleton／head／count、直前commit、canonical request・receipt、desiredの初利用、過去mapping／保持版の有限検証を行う。applied／desired／mapping／previous commitはindexed JOINで取得し、standalone readと共通の純粋validatorへ渡す。保持applicationのreadも定義／previousを同様に結合し、本文bytesとSQL／VM課金を維持する。`reservations.rs`は恒久metadataと検索非公開の予約を照合し、first-use applicationのenabledな解決内容を非再帰で検証する。同一apply transactionのread区間でfirst revision単位のEvidenceCacheを旧applied／新mappingの両検証へ共有し、過去全receiptへの再帰と重複decodeを避ける。256行上限・予約検証・使用時のcommit境界は維持する。format6の`schema.sql`は台帳・予約・適用member索引を所有し、`store/mod.rs`の共通begin入口が過去session再送後にmanagedな新規開始を拒否する。

`query/control.rs`の`bounded_text`は新管理本文128KiBまでの共有8MiB計数を持ち、既存`evidence_text`は64KiBを維持する。新APIはdecoded rowsを最大256に絞り、既存maintenanceの取消・VM・rollback・poison／writer所有を共有する。`recording_plan/tests.rs`と`tests/validation.rs`／`failures.rs`がCAS／再送・8member・identity・job・容量・破損・FULL・各境界のprocess exitを一時DBで検証する。H1出力と通常Appの既存browser契約を回帰し、SDK／supervisor／UI／製品transportは追加しない。

## 停止前の記録計画チェック（H5c2a）

[採用設計](../design/runtime/historian-recording-supervisor.md)に従い、`store/recording_plan/preflight.rs`が既存HistoryReader上のmapping／apply候補検査を公開する。`prepare.rs`はwriteとread-only snapshotで共有するReplay／候補判定、CAS、immutable本文、容量、解決、予約identity検査を所有する。writerはactive session／jobを引き続き拒否し、preflightだけがactive sessionを候補に含める。

`query/management.rs`は管理StoreErrorを保つread-only snapshot実行と既存guardの共有を担当する。HistoryReaderのhealthy fieldはpanic時のcleanup失敗も保持し、Historyと管理の双方で再利用を拒否する。新connection／lease枠／writer転送は作らず、2reader上限、元deadline/token、256行・文書128KiB・入力8MiB・VM/出力上限を維持する。

`preflight/tests.rs`と`query/management.rs`の14新規テストが、稼働中の検査、writerとのsnapshot一貫性、Replay／競合、予算、readonly authorizer、取消／panic／cleanup失敗、SQL障害、2leaseとlockを確認する。既存validationへ4,096mapping版と32 origins／異なる保持版／8memberの稼働中・停止後チェックを追加した。Host停止・管理turn・SDK再解決・再開supervisorはc2b/cである。

## 記録開始の原子的bindingと復元照会（H5b2）

`store/recording_plan/activation/types.rs`は専用要求、immutable receipt、mutable SessionStatusとlatest snapshotを所有する。`mod.rs`はQueryControl付きAPI・必須head/countと索引によるmanaged session/evidence/永久metadataの関係検査、`write.rs`は現在版CAS／fence／新session・epochと同commit保存、`read.rs`は過去applied・開始receipt・session member・最新tick receipt・timed evidence・recording_plans初利用の有限照合を担当する。

`evidence::save_start`はconnectionと任意Budgetを受ける共通helperへ一般化し、独自transactionや採番を行わない。manual beginは従来のgateと検証順を維持し、activationは同transactionで予約／恒久metadataを照合後に未存在metadataと全member/sessionを保存する。`types.rs`のSessionState／SessionStatusへSerializeを追加したが、H1や製品transportの契約は変更しない。schema.sqlはDB7のactivation ledger/stateとepoch／first-use索引を所有する。

`activation/tests.rs`と`tests/failures.rs`はnative20件（process worker含む）。通常開始・再apply・旧再送・restart、異なる8予約元の8member、4,096件上限、metadata欠落、FULL＋取消、cleanup拒否、各COMMIT境界を一時DBで検証する。既存query/manual/保持/hostを回帰し、browserはH1／desired契約を維持する。worker開始とSDK fresh pin、Runningの管理はH5cに残す。

## managed計画からのRecorder開始（H5c1）

`scada-historian/src/recorder/managed.rs`がManagedRecorderStartの純粋検証、既存activation拒否、同writer上の保存spec/PlanRef照合、clock anchorとnative activationを担当する。`recorder.rs`のmanual/managedは有限horizonとfrom_anchorを共用し、stepの絶対deadline・実測時刻・欠測／close／interruptを変更しない。新RecorderStartErrorはAlreadyActivated／ManagedBindingMismatch／ActivationUnconfirmedを区別する。

`recording_host.rs::start_with`は両開始戦略で同じ所有・latch・clean-pause guardを使い、DB処理をblocking Workerへ渡す。`worker.rs::Start`が専用開始を選び、managed controlの取消tokenをrun全体へ共有する。成功receiptはRecordingCompletionへだけ保持し、watchの開始診断は有限固定文字列とする。SDK shutdown/join、取消中の所有とFaulted経路は共通である。

`recorder/tests/managed.rs`の12件と、activation側の`tests/managed_recorder.rs`の実FULL1件がnative境界を受け入れる。32 originsの既存回帰は最大8memberの専用開始も確認する。runtime unit2件が開始前取消とlatch/純粋検証、integration6件がmockHub/実値保存・executor・shutdown・join取消/Busy・新domain・Drop/reader leaseを検証する。`tests/support/managed_recording.rs`は両runtime試験で使うnative計画fixtureだけを持ち、製品初期化へ流用しない。

## 正常pause後の計画適用（H5c2b）

`recording_host/plan_turn.rs`がprocess-local操作token、元RecordingRun照合、mapping/applyの一回turn、borrowed join、Drop時取消、結果と各種最新成功record、sticky recovery要求を所有する。`RecordingHost::writer_busy`でrecording／retention／planの実worker所有を共通に検査し、正常pauseと保持latchの検査を共有する。`types.rs`へManagingPlanと安全な入口error分類を追加した。詳細StoreErrorはcompletionに限定する。

`recording_plan/types.rs`のrequest.validateは既存canonical／pure validatorのwrapperで、runtimeへ型・文書予算規則を複製しない。新しいDB transaction、schema／依存は追加しない。`plan_turn/tests.rs`の12unitと`tests/recording_host/plan_turn.rs`の3integrationで、exact token、gate、元control、join取消、Drop/reader lease、latecancel／応答喪失／I/O注入、成功receipt保持、同HostのmockHub→SQLite→raw/minmaxを受け入れる。actual FULL／rollback拒否は既存native回帰で確認する。

## 単一supervisorの候補検査・明示停止・適用（H5c2c1）

`recording_host/supervisor.rs`が同storeのHost/reader factory、記録開始と安全停止の委譲、検査候補のrun/session束縛、pause/join確認、同一intentの一回実行・consume、回復時のstore返却を所有する。公開host_mut/任意callbackを設けない。`supervisor/preflight.rs`が専用readerの物理一枠、元QueryControl、borrowed join、exact token、終了後結果とreader障害を保持する。`supervisor/types.rs`は操作token、typed report、有限stateとstoreを失わないInitErrorを担当する。

`supervisor/tests.rs`と`supervisor/preflight/tests.rs`の15unitで、factory/2lease、古いtoken、同期拒否、元control、join取消、consumeの復活拒否、CAS再検査、reader障害とDrop lock、候補破棄・開始時の結果無効化を確認する。`tests/recording_host/supervisor.rs`の3integrationはmockHub録画継続、Replay/Conflictのno-stop、自然完了、pause/join/map/applyとcaller-confirmed再録画・raw/minmaxを受け入れる。nativeのread APIやDB schema、SDKfresh解決を追加したことにはしない。

## 同snapshotの復旧診断と明示再開（H5c2c2）

`store/recording_plan/resume.rs`が専用複合readとRecordingResumeStateを所有する。`read::state_from_heads`と`activation::latest_with_cache/load_with_cache`は同snapshot/Budgetで再利用する。`EvidenceCache`はfull applicationとfirst-use証拠を分け、cache hitでもledger/revision/snapshot条件を保つ。新APIだけ768行、既存API256行・VM・8MiB・期限は不変である。

`recorder_source/resolution.rs`のSdkRecorderPlan::from_generationはSDK行数と文字列総8MiBを先に検査し、最大8pinsの抽出と既存projectionを再利用する。大きなsnapshot全体をコピーせず、提供snapshotの値を記録しない。`recording_host/supervisor/resume.rs`は既存readerをloanするinspection worker、diagnosticとresume gateの分離、inspection/prepare/resume token、owned plan/options/bindingと受理時consumeを担当する。

native7新規（`recording_plan/resume/tests.rs`）・SDK4新規（`recorder_source/resolution/tests.rs`）・resume単体10新規・mockHub統合3新規を追加する。実SDK handleで取得したsnapshot→別ownerの新記録→raw/minmax、reopen/interrupted、新SDK世代変更停止、元control/lease/Drop/latch、32 origins disjointの複合768行境界と古いreceipt破損を検証する。readerのactual cleanup拒否とSQL FULLは既存native回帰を維持する。

## Project記録希望設定の保存（H5d1）

[Astra詳細設計](../design/runtime/historian-recording-project.md)に従い、`project.ts`と`scada-model/src/lib.rs`がProject0.37.0のoptional単一`recordingPlan`を受け入れる。Project schemaは同梱H5a resourceを参照し、両parserはH5a semantic validatorを呼ぶ。独立64KiB/4096node/depth32予算と文字列判定を複製せず、省略とnullを区別する。既存text本文だけの正規化は維持し、externalNameへ作用させない。

`recording_project_tests.rs`／`project-recording.test.ts`／`__fixtures__/project-recording-cases.ts`は独立H5a139とProject共通16ケースを扱う。`e2e/project-recording.spec.ts`はbrowserの共通受入・通常App保存再読込と不正replacement時不変を担当する。`project-package.test.ts`はwhole packageでのdesired保持を含み、部分clipboardの非同伴もTSで検証する。0.37へ揃えたJSONと画像同梱サンプルの原本整合を維持する。編集commandはH5d2で追加し、管理serviceはd3以降へ分ける。

## 記録希望設定のローカル編集（H5d2）

`recording-plan-edit.ts`はH5aの再利用、raw整数文字列の検査、固定fieldの全比較とmemberId順の意味比較、同IDのdesired増版、編集対象全文照合を担当する。`editor/recording-plan-handler.ts`と`commands.ts`がsave/removeをProject commandへ登録し、`project-handler.ts`から一回の既存editor transactionへ委譲する。Project revision／Undo／Redoの責務は既存editor/historyから移していない。

`designer/RecordingPlanDialog.svelte`はowned draftとdirty保護、最大8member、数値の明示入力と外部名の無操作保持を持つ。AppはrequestにProject object/世代/画面/modeを束縛し、各callbackの元requestを照合する。論理資格を閉じた後もfocus復帰用viewを一枠だけ保持し、Bantoのopen→closed遷移を通す。次のopenで新しいdraftを作り、Project置換でviewも破棄する。`designer-actions.ts`がFile menuと常設メニュー、AppのProject設定がsidebar入口を提供する。`recording-plan-edit.test.ts`の27件は増版/no-op/対象/Undo/数値・文字列を、`e2e/recording-plan-editor.spec.ts`は通常Appの編集寿命・両theme・原子保存と入力保護を検証する。

## 記録管理状態の共通契約（H5d3a）

設計は[管理状態の読取契約](../design/runtime/historian-recording-management.md)。共有schemaは`crates/scada-model/schema/recording-management.schema.json`で、H1 ID／H5a desired resourceをローカル登録する。Project schemaとは独立している。Rustの公開入口は`recording_management`で、private Value wrapperとpure validator、`semantic.rs`のDB内整合、`comparison.rs`のdesired比較・全文request一致に分ける。

TSの公開入口は`lib/recording-management-contract.ts`。`recording-management/types.ts`はreadonly DTO、`semantic.ts`はschema検査後のDB整合、`recording-plan-comparison.ts`は編集とも共用する固定field本文比較。`history/owned-json.ts`が有限JSONを所有し、root／nested request・contextとH5a desiredへ独立予算を使う。Host／SDKは別時点であり、DBとのsession一致やRunningから接続状態を導出しない。

`examples/recording-management-cases.json`は受理447・比較18・全文request9を共有する。Rust `recording_management/tests.rs`、TS `recording-management-contract.test.ts`と`__fixtures__/recording-management-cases.ts`、`e2e/recording-management-contract.spec.ts`で同じ期待値、H5a139のネスト、予算端点・所有権を確認する。TS比較はunknownを再検証し、Rust比較は検証済みwrapperのみ。このpure moduleから副作用を呼ばない。service／controller／通常App管理表示はd3bで追加し、native projectionは後続。

## 記録管理状態のworkspace（H5d3b）

`lib/recording-management/service.ts`はreadonly `RecordingManagementService`とProject対象照合、context／desiredのsnapshotとinspect関数の捕捉を所有する。`controller.ts`は一実行・最新一待機の物理枠、論理token／取消、絶対単調deadline、応答のowned検証と要求全文一致を担当する。`RecordingManagementWorkspace.svelte`はApp常設で、openOwner／Project object／generation／service identityによるeffect前のrender／action資格を守る。`RecordingPlanView.svelte`は希望／適用設定のreadonly表示、`labels.ts`は有限状態の表示文言である。`summary.ts`は最後の照会結果から「記録中／記録停止中／記録中断／記録要確認」の一行を導き（DBのactive sessionが基準、Hostが記録できないphaseなら要確認）、ダイアログ先頭とAppヘッダーのバッジが使う。照会の自動実行はせず、照会時刻を添える。記録の停止は重ねたModalで確認してから実行する。

`App.svelte`はoptional `recordingManagementService`、明示openの新ownerとProject採用時のclose、背後shortcut保護を接続する。`designer-actions.ts`の表示menuが入口。`main.ts`には注入やmockを追加しない。応答でProject・Undo・writer ownerを変更しない。`controller.test.ts`が再入・期限・cleanup／物理枠を、`e2e/recording-management-workspace.spec.ts`が通常Appの両theme・寿命・保存不変を検証する。既存Historyとは別controllerで、別App間の物理制限は将来adapterのgate責務である。

## 記録計画の明示操作契約（H5d4a共通検証実装）

[Astra詳細契約](../design/runtime/historian-recording-operations.md)が登録済みmappingのapply workflowと、d3 read serviceから分離するoptional操作capabilityの基準である。現在あるnative実装は`recording_host/supervisor.rs`の`start_preflight`／`request_pause`／`join_pause`／`execute_candidate`と、`plan_turn.rs`のcancel／join／guard。opaque run／candidateはnative所有で、文字列IDから再構築しない。

`scada-historian/src/store/recording_plan/mod.rs`の`recording_plan_receipt`はstoreのread-only照会であり、同APIのbrowser serviceやlatch下のsupervisor経由reconciliationが既に完成しているとは扱わない。d4aのpure DTO検証は実装済み。d4bの外部owner／monitorと通常App注入操作UIは実装済み、d4cのnative投影・結果照会は未実装であり、新契約をProject保存やd3 inspectionへ組み込まない。

共有schemaは`crates/scada-model/schema/recording-operations.schema.json`。Rust公開入口は`recording_operations`、`semantic.rs`は検証後のreceipt・stage・回復整合、`equality.rs`はprivate wrapper同士の数値表記を無視する全文一致を担当する。TS公開入口は`lib/recording-operations-contract.ts`で、`recording-operations/types.ts`と`semantic.ts`に分ける。種類別のrootとnested envelopeの128KiB／4096node、resultの256KiB／8192node、H5a desiredの64KiBを維持する。

`examples/recording-operations-cases.json`の受理925・全文一致102と、H5aネスト695・d3 target447をRust `recording_operations/tests.rs`、TS `recording-operations-contract.test.ts`／`__fixtures__/recording-operations-cases.ts`、`e2e/recording-operations-contract.spec.ts`で共有する。pure検証は過去receipt／latchの記憶やnative実行の証拠を持たない。通常Appの保存不変と既存d3管理表示もbrowserで確認する。

## 記録計画の操作workspace（H5d4b）

`lib/recording-operations/service.ts`はd3と独立したoptional操作service、opaque handle／cached owner view、未dispatch同期拒否とProject対象bindingを定義する。`view.ts`はbounded JSONだけの所有検証、元request／receiptの一致、単調な結果統合を担当する。`monitor.ts`はApp寿命の一workflow（最大3stage）と一read、発行前の同期gate、期限表示、明示取消、旧ownerの保持と安全な明示discard／再接続を担当する。nativeの物理gate・run所有とregistryはproviderの責務であり、ここで実装しない。

`RecordingOperationsWorkspace.svelte`は即時render／action資格、期待版入力、三段階の独立button、元対象ラベルと手動reconcileを所有する。`labels.ts`は有限error／phaseの表示文言である。`App.svelte`の別prop・常設workspaceと`designer-actions.ts`の表示menuだけに接続し、通常`main.ts`は未接続のまま。`__fixtures__/recording-operations-service.ts`はUIから独立して受理handleとcompletionを保持するtest-only provider。`monitor.test.ts`と`e2e/recording-operations-workspace.spec.ts`で再入、逆順通知、旧対象、安全な破棄、期限後結果、手動照会とremountを検証する。d4aのpure validator、d3 inspection、Project保存を拡張解釈しない。

## 元apply全文に対するnative receipt読取（H5d4c1）

`scada-historian/src/store/recording_plan/receipt.rs`は`HistoryReader::recording_plan_receipt_for_request`と`RecordingPlanReceiptSnapshot`を公開する。元QueryControlの検証後に既存256行capと`query/management.rs`のsnapshot guardを使い、`read::heads`／`find`／`read::application`で同snapshotの保存証拠を検証してからcanonical要求全文を照合する。native member順の意味同値と、d4a元owned要求の表示順echoは別の責務である。writer API・latch・supervisorの所有を変更しない。

`receipt/tests.rs`と`receipt/tests/failures.rs`は過去receipt、現在CASとの分離、並行commit、実FULL／応答喪失、保存証拠の破損、予算・取消・panicと既存leaseを検証する。`query/management.rs`の既存authorizer／cleanup試験でreadonlyとpoisoned readerを確認し、`recording_plan/tests/validation.rs`の8member／32origins試験で同じ256行上限を確認する。共有native ownerとregistryはc2、owner内read統合はc3で提供し、browserへDB照会を直接公開しない。

## 記録操作の共有native owner（H5d4c2）

公開入口は`scada_runtime::recording_operations`、実体は`recording_host/supervisor/operations`。`mod.rs`が共有gateとcached state、四枠予約後の受付、同期discard／handoffを担当し、`types.rs`がopaque token・immutable完了watch・有限errorとevidenceを定義する。`registry.rs`は役割付きID4096件と未使用credit、`projection.rs`はU1/nullのchecked変換・全文echo・d4a結果検証・typed error対応、`driver.rs`は一stageだけのSupervisor loan・native start/join・返却後の結果確定とDrop guardを所有する。

`supervisor.rs`はinitとstart_preflightの純粋gateを`recording_operations_context`へ共有し、true方向だけの`latch_recording_operations_recovery`でowner-only blockをnativeへ伝える。Historianの`QueryControl::validate`を公開し、元予算の検査をruntimeへ複製しない。c3 read統合も実装済みで、JS clockとのbridgeは後続。

`operations/tests.rs`と`registry.rs`の単体30件、`tests/recording_host/operations.rs`の公開API／SDK loopback2件で所有・期限・競合・失敗と履歴保持を確認する。既存native候補／worker起動のprivate seamを試験で共有し、runtime dev-dependencyだけで既存pinのrusqliteを使う。Historianの実FULL／rollback試験とownerの型付きFULL注入は区別する。公開test-support featureやproduction fault APIを設けない。

## 同owner内の明示結果照会（H5d4c3）

公開入口はc2と同じ`scada_runtime::recording_operations`。`supervisor/receipt_read.rs`が既存readerの限定read gate・spawn_blockingとborrowed join・返却を担当する。`operations/reconciliation/mod.rs`は元apply Arc照合、read用4096 IDと受付、`types.rs`は有限completion／read phase、`driver.rs`はSupervisor loan・read実行・元completionを変えないDTO投影／最新結果統合を所有する。mutation用gateは緩和せず、private helper以外へ回復時の読取例外を広げない。

`reconciliation/tests/outcomes.rs`は実commit後の応答喪失／panicと同snapshotの元receipt、不在・破損・全文echo・投影失敗を扱う。`lifecycle.rs`は実blocking worker中の取消／期限／Drop・Runtime終了・poison、`gates.rs`は全caller・ID上限・opaque identity・既存leaseを扱う。`tests/recording_host/operations.rs`には実SDKで出力予算rollback→同owner notFound→非再開・履歴不変の公開API試験を追加した。通常AppのJS bridge、回復latch解除と製品transportは実装しない。

## 非同期admissionの共通JSON（H5d4c4a）

`scada-model/schema/recording-admission.schema.json`は独立v1の五rootと閉じたfield／errorを定める。`recording_admission.rs`はowned wrapper・ローカルschema登録・既知document相互照合、`recording_admission/semantic.rs`は全nested d4aの独立検証とstage／ref／全文echo、`capacity.rs`は受付前の最大返信九分岐を担当する。native `json_contract.rs`のadmission profileだけが外側の保守計数を使用し、既存compact予算は維持する。

TSの`recording-admission-contract.ts`と`recording-admission/{types,semantic,capacity}.ts`は同じ境界を持つ。`history/owned-json.ts`へadmission opt-inを追加し、既定のcompact／depth32を変えない。`json-equality.ts`は既存d4aと共有するowned JSON比較で、配列順を保持する。

`examples/recording-admission-cases.json`とtest-only `__fixtures__/recording-admission-cases.ts`をRust `recording_admission/tests.rs`、TS `recording-admission-contract.test.ts`、`e2e/recording-admission-contract.spec.ts`で共有する。予算境界、最大reply、再帰closure回避、nested契約、所有・Unicode・外部取得なしと通常App保存不変を確認する。c4bのasync monitor／UIは下節、実lease／registry／IPC／製品hostは未実装で、pure JSON受理をnative実行の証拠にしない。

## 非同期の記録操作monitor／UI（H5d4c4b）

[詳細設計](../design/runtime/historian-recording-async-monitor.md)に沿い、`recording-async/port.ts`は同realm test-only port、`state.ts`はclient／ViewLeaseと独立した受付・native・read・呼出状態を定める。`coordinator.ts`はAppより長寿命の外部管理root、一枠のlease→admit、元要求照合、既受理refの観測、sticky recoveryと証拠保持を担当する。closeは新送信を閉じるだけでnative取消ではない。

`ids.ts`は五role各4096のchecked counter、初回workflowのmutation4／callerOperation2予約、retryの追加予約とread独立枠を持つ。`local-validation.ts`はlease／cancel metadataと完全frameを安全にowned検証する。`history/owned-json.ts`のlocalMetadata（128KiB・4096node・depth32）とlocalFrame（1MiB・32768node・depth64）は保守計数を使い、c4a admission（depth48）と既定compact（depth32）は維持する。

`recording-async/monitor.ts`は一つの旧clientと現在選択を保持し、Project object／generation／openOwner／raw選択clientが変わったviewを退役させる。Workspaceからlive propsのqualificationを渡し、effect前のlease後着もcoordinatorの送信直前gateで拒否する。旧clientが正常終端になるまで自動切替せず、App disposeでもrootをcloseしない。選択clientの撤去後、閉じて安全に終端した旧clientだけは`releaseFinished`で手放し、未接続へ戻す（`monitor.test.ts`と`e2e/native-recording-operations.spec.ts`）。`AsyncRecordingOperationsWorkspace.svelte`は三段階操作・受付照会・元apply結果照会・切断／不明の閉集合表示を担当する。

`recording-operations/RecordingOperationsEntry.svelte`は最初の有効な単独注入でsync／async modeを固定し、二重注入と異mode交換を拒否する。両Workspaceは常設し、旧monitorをunmountしない。既存同期`RecordingOperationsWorkspace.svelte`のblocked guardは新送信だけを制限する。`App.svelte`の `recordingAsyncOperations` は任意注入で、通常entryは未注入のまま。

`__fixtures__/recording-async-port.ts`は制御Promiseとmock native lease期限を持つtest-only provider。`recording-async/{coordinator,monitor}.test.ts`は正常unknown復帰／fault停止、通知再入、frameと元Promiseの順序、close／再読込／service交換／unmount、実4096上限・後続予約・read独立性を検証する。`e2e/recording-async-workspace.spec.ts`は両theme、三段階操作・照会・寿命・mode固定・安全なerror表示・Project保存不変を通常Appで確認し、`recording-operations-workspace.spec.ts`で同期回帰を維持する。実native／wire／認証・製品transportは後続。

## 記録操作wireの純粋契約（H5d4c4c-prep1）

`scada-model/schema/recording-wire.schema.json`は独立wire v1の14rootとscope／OwnerSnapshotを定め、c4a／d4aのlocal resourceを参照する。`recording_wire.rs`はローカルschema登録・有限のnested検証・owned wrapper・既知文書照合、`recording_wire/semantic.rs`は新旧scopeの区別、全文echo、branchとsnapshotの独立検査を担当する。`capacity.rs`は未知snapshot／結果の保守上界と固定envelopeから最大replyと元call照会包絡を計算し、公開validatorを呼ばない。

TSの`recording-wire-contract.ts`と`recording-wire/{types,budget,semantic,capacity}.ts`も同じ責務を持つ。`history/owned-json.ts`とRust `json_contract.rs`はopt-inの保守会計・node／depth計数を提供し、既存compact／admission／local profileの既定上限は変えない。raw bytes受信・registryの空き容量と認可はこの純粋境界に含まない。

`examples/recording-wire-cases.json`とtest-only `__fixtures__/recording-wire-cases.ts`をRust `recording_wire/tests.rs`、TS `recording-wire-contract.test.ts`、`e2e/recording-wire-contract.spec.ts`で共有する。14root、最長ID、独立nested契約、自己照会排除、容量のexact／1不足byte・node・depth、会計上限、所有と通常App保存不変を検証する。実lease発行、registry adapter、native配送・認証・製品hostは後続で、c4b local portへ透過的に接続しない。

## 記録操作registryの純粋状態モデル（H5d4c4c-prep2a）

`scada_runtime::recording_registry_model`は仮想時計・単一scopeとprincipal binding・役割別有限資源を保持する決定的モデル。`types.rs`はcheckedなsession／limitsと非Deserializeのinstance-bound SimulationTicket、`lease.rs`は一admission一lease・仮想期限・exact replay、`admission.rs`は原子登録とproof／元terminalの独立保持を担当する。`inspection.rs`は現在知識のsnapshotと元call照会のID bindingを保持し、未登録の元callを実行しない。実clock・native owner／SDK・DB・executor・transportを参照しない。

保守bytesは`scada-model::recording_wire::conservative_recording_json_bound`が既存JsonBudgetから計数する。最大profileより大きいcaller limitを拒否し、schema-validやnative実行資格の判定には使わない。raw session scopeも複製前に同walkerで打ち切る。admissionのrequest＋二返信・completionの要求由来予約とread別枠はモデル終了まで維持する。

`recording_registry_model/tests.rs`は`examples/recording-registry-model-cases.json`の55シナリオを実行して期待DTOへ照合する。`tests/boundaries.rs`はraw scope・instance ticket・ID／lease4上限と原子性を検証する。TSのtest-only `__fixtures__/recording-registry-model-cases.ts`、`recording-registry-model-contract.test.ts`、`e2e/recording-registry-model-contract.spec.ts`は同じtranscriptの既存validator適合・所有・App保存不変を確認し、第二のregistryは実装しない。Accepted後の新mutation停止、後続prep2bとP3bのgateを維持する。

## 記録registryモデルの結果観測（H5d4c4c-prep2b1）

`recording_registry_model/handle.rs`はAccepted refとmodel instance／元admission sequenceの束縛、readの元apply全文照合、予約済み容量内の不変completionを担当する。`observation.rs`はread-only requestのID binding、未知refの不変unavailable、operation/read独立ID・pending slotと明示terminal回収を担当する。結果は既存wire DTOへ投影するだけで元call終端・受付知識・業務phaseを変えない。`types.rs`のSimulatedHandleTicketは非Deserializeで、JSON refから発行しない。

`admission.rs`は要求由来のknowledge／元terminal／completion保持予約を受付前に確保し、Accepted保存とhandle登録を原子的に行う。rootのModelStatsはhandle数・観測数・未回収slot・模擬native recoveryのsticky ORを表示する。実時計／native owner／DB／SDK／transportは引き続き参照しない。

`examples/recording-observation-model-cases.json`の48シナリオ480ステップを既存Rust scenario driverへ追加し、`tests/observation_boundaries.rs`でinstance固有ticket・ref競合・上限・二重回収の境界を確認する。test-only `__fixtures__/recording-observation-model-cases.ts`、`recording-observation-model-contract.test.ts`、`e2e/recording-observation-model-contract.spec.ts`は期待DTOの既存validator受入と通常App保存不変を確認する。既存prep2a fixtureの容量期待値は追加予約へ合わせる。schemaや第二のTS registryは追加しない。

## 記録registryモデルの取消（H5d4c4c-prep2b2）

`recording_registry_model/cancel.rs`は受理前のscope／ID／slot／最大reply予約、登録時target binding、handleごとの模擬通知一回性、不変decisionと元call終端を担当する。`types.rs`のModelCancelTicketはinstance＋sequence＋cancelIdに束縛する非Deserializeの型であり、native tokenではない。`inspection.rs`はCancel originalを未登録notFound／未終端pending／保存済みreplyへ照合し、notifyやfinishを呼ばない。

rootはCancelRecordと4096 ID・未終端1枠、`handle.rs`はcancel_notifiedのfalse→trueだけを追加する。通知・ackは既存operation/read completion・admission・観測slot・recoveryを変更しない。JSONの論理completionから返すalreadyCompletedを実native task静止の証拠にしない。

`examples/recording-cancel-model-cases.json`の41シナリオ415ステップをRustの共通driverで実行し、`tests/cancel_boundaries.rs`でticket所有・改変・counter overflow・受付拒否原子性・他軸不変を検証する。test-only `__fixtures__/recording-cancel-model-cases.ts`、`recording-cancel-model-contract.test.ts`、`e2e/recording-cancel-model-contract.spec.ts`は既存JSON契約と通常App保存不変だけを確認する。prep2aのoriginal fixtureはprep2b3で未登録AttachのnotFoundへ更新し、取消の第二のTSモデルを作らない。

## 記録registryモデルのsnapshotと購読（H5d4c4c-prep2b3）

`recording_registry_model/projection.rs`は三つの独立head、不変snapshot descriptor、受付前の将来投影上界とrevision credit、core変更前のcandidate検証、最新一件slotへの公開を担当する。admission／handle側はproof・completionを保存する前に同じ投影を検証し、失敗時にcoreやslotを変更しない。元call terminalや取消・観測だけではrevisionを進めない。

`subscription.rs`は原子的attach、request全文へ束縛した不変attach／control返信、明示detachとlive slotだけの一回返却、state／controlの独立takeを担当する。rootは単一ownerのinitial descriptor 1KiB、typesは縮小専用limitsとstatsを追加する。`inspection.rs`は保存済みAttach／Controlを再構築し、未知originalを実行しない。

`examples/recording-subscription-model-cases.json`の48シナリオ293ステップをRust共通driverで実行し、`tests/subscription_boundaries.rs`で三次元投影容量・revision／ID境界・不変返信・返却一回性と既存schema分岐の上界を検証する。TSのtest-only `__fixtures__/recording-subscription-model-cases.ts`、`recording-subscription-model-contract.test.ts`、`e2e/recording-subscription-model-contract.spec.ts`は141期待DTOの独立validator適合・所有・既知document対応とApp保存不変だけを確認する。第二のregistry／受信state machineは作らない。既存三fixtureのread予約期待へ初期descriptor 1KiBを加算した。

## 記録registryの単一workflow（H5d4c4c-prep2b4a）

`recording_registry_model/reservation.rs`は既知requestから独立reply二個とcompletionのlifetime上界を算出し、保存前の実測も検査する。Standalone／Workflowで共有し、既存rootやlegacy compact予算を変更しない。`admission.rs`は独立reconciliation IDと256bytesをread admissionの予約へ原子的に含める。

`workflow/mod.rs`はprivate instance ticket、元changeへの束縛、lease／beginの明示入口とnative identity登録planを担当する。`workflow/escrow.rs`は4stageの将来request／lease上界、projection high-water、11revision＋close1の予約・移管と未発行stageだけの返却を担当する。`workflow/state.rs`は元call／knowledge／immutable completionに基づくphaseとread gateを判定し、sourceを実行しない。通常mutation入口からWorkflow modeの予約を迂回できない。

`examples/recording-workflow-model-cases.json`の47シナリオ597ステップと`tests/workflow_boundaries.rs`の10境界試験をRustの共通driverで実行する。test-only `recording-model-budget.ts`は独立した要求由来の会計oracle、`__fixtures__/recording-workflow-model-cases.ts`、`recording-workflow-model-contract.test.ts`、`e2e/recording-workflow-model-contract.spec.ts`は92期待DTO・全入力の既存validator受入とApp保存不変を確認する。既存四fixtureの会計を同期した。TS registry／workflow実行機構やnative接続は追加しない。

## 記録registryの次workflow受入（H5d4c4c-prep2b4b）

[次workflow受入](../design/runtime/historian-recording-registry-workflow-renewal.md)の`workflow/renewal.rs`は初回／専用次予約API、creationとpredecessorの再送束縛、履歴台帳の累積予約と各1024bytes管理費用、全静止gate、current accepted apply限定の新read検査を担当する。`workflow/mod.rs`はrecordsとcurrentを分離し、旧ticketによる新操作を防ぎ、proofを元recordへ保存する。caller／native IDのcollisionは全履歴attemptへ検査する。`state.rs`／`escrow.rs`は累積used／reservedと正常終了時の未発行枠だけの返却を維持する。`handle.rs`は正常paused保存時のsticky ever_clean_joinedを更新する。

`examples/recording-workflow-renewal-cases.json`の50シナリオ947ステップと`tests/renewal_boundaries.rs`の10境界試験を共通Rust driverで実行する。test-only `__fixtures__/recording-workflow-renewal-cases.ts`、`recording-workflow-renewal-contract.test.ts`、`e2e/recording-workflow-renewal-contract.spec.ts`は154期待DTO・全入力の契約、累積保持会計、App保存不変を検査する。既存47workflow fixtureへ初回管理費用だけを加算した。複数scopeの全量予約は次節のdomainへ追加済み。受信frame順序／矛盾の検査は後述prep2cの純粋TS receiverへ分離し、実接続は後続である。

## 記録registryの複数scope資源（H5d4c4c-prep2b5a）

[複数scope資源のAstra設計](../design/runtime/historian-recording-registry-global-budget.md)に沿い、`recording_registry_model/domain/mod.rs`は有限登録・resource／ownerRefの寿命中一意束縛・容量と購読枠の全量予約・opaque ticket・共通仮想時計・seal・予約統計を担当する。`domain/facade.rs`は25の既存typed APIを転送する。独立advance／DerefMut／modelの持ち出しを提供せず、既存scopeの各gate・結果保持を再利用する。

`domain/tests.rs`の14境界試験とcompile-fail2件は予約と実使用の区別、32scope／購読と16MiBの上限、回復read・将来completion、再送・帰属・clock・Dropを検証する。`tests.rs`の共通driverは既存289シナリオを単独／domain両経路で実行し、全domainケース後の登録再送も照合する。TS／browserの既存wire契約試験を再利用し、新しいwire／schemaや第二のTS registryを追加しない。実adapter／hostの共有native gateと物理資源の保証、受信frame検査は別工程である。

## 記録wireの受信frame（H5d4c4c-prep2c）

[Astraの採用設計](../design/runtime/historian-recording-wire-receiver.md)に沿うpure TS receiver。公開入口`recording-wire-receiver.ts`はfactory・全mutationの再入guard・直前commit済みpoll状態を提供する。`recording-wire-receiver/types.ts`はopaque AttachGeneration/ControlCallとreadonly結果、`core.ts`は固定Scope・有限台帳・資格/予約・公開view、`calls.ts`はexact登録と元reply保存/表示昇格の二段階、`frames.ts`はparse前の世代資格・state/control別slot、`snapshots.ts`は全文履歴と昇順の原子的promotionを担当する。既存`recording-wire-contract.ts`と`json-equality.ts`の検証・同値判定を再利用する。

`examples/recording-wire-receiver-cases.json`の59シナリオはtest-only `__fixtures__/recording-wire-receiver-cases.ts`を通じて実receiverへ入力する。これはtest command DSLで、第二のserver registryではない。`recording-wire-receiver.test.ts`は共有シナリオに加え、独立予算oracle・全mutationへのProxy再入・ownership・terminal保持・容量exact/1不足を検査する。`e2e/recording-wire-receiver.spec.ts`も同じreceiverと全シナリオをChromiumで実行し、通常Appの保存不変・外部送信無しを確認する。

callback／Promise終端／I/Oやnative registryの複製は含めない。`recording-async/port.ts`とcoordinatorは同realm test-only契約のままで、wireのownerEpoch／closed／ControlFrameを捨てた透過接続を作らない。snapshot64件/8MiBとcall8MiBは返却しない有限保持で、長時間運用を保証しない。通常Appへの投影契約と実host・P3bは別工程である。

## 記録wireのclient境界（H5d4c4c-prep2d1）

[Astraのclient境界設計](../design/runtime/historian-recording-wire-client-boundary.md)に沿い、`recording-wire-receiver.ts`へ`currentDisplay()`／`attachTerminal()`／`controlTerminal()`を追加した。`recording-wire-receiver/readout.ts`はcommit済みstateからの純粋表示と、元recordの不変参照を共有する小wrapperを担当する。`types.ts`は独立したRecordingWireDisplay／StoredTerminalを公開する。読取は既存guardを共有しつつ再publishせず、更新中はbusy、表示だけは直前のcommit済みcacheを返す。新ledger／copy／quota返却は追加しない。

`examples/recording-wire-readout-cases.json`の19追加シナリオは既存test-only receiver driverで実行する。同driverは既存59シナリオ全stepでも元配送のACK全文・pending／terminal・read後のcache identity／旧poll不変を照合する。`recording-wire-readout.test.ts`と既存receiver testの拡張はforeign／wrong-kind token、参照共有、全入力mutationのProxy再入、getter反復と容量停止後の回収を確認する。`e2e/recording-wire-receiver.spec.ts`は両fixtureをChromiumで実行し、通常App保存bytes・外部送信無しを確認する。

`recording-async/coordinator.ts`／`state.ts`／`port.ts`は変更しない。表示をLocalOwnerFrameへcastせず、Promise完了・native操作資格を生成しない。元call配送台帳の具体型と上限、local-v2、通常App注入は次の詳細設計・実装へ分ける。

## 記録wireの元call配送台帳（H5d4c4c-prep2d2a）

[Astraの採用設計](../design/runtime/historian-recording-wire-delivery-ledger.md)に沿うpure TS実装。公開入口`recording-wire-delivery-ledger.ts`はfactory・全mutation/getterのguard・dirty時だけのpoll commitを担当する。`recording-wire-delivery-ledger/types.ts`はopaque元call/query/attempt tokenとreadonly状態、`core.ts`は固定Scope・有限台帳・未回収枠・pool/credit・options、`validation.ts`は既存parser・kind別scope/ID/roleとQ/R/I、`original.ts`は原子的登録と不変元reply、`inspection.ts`はquery/attempt・初回credit移管・repeat・正規化返信の二段階保存を担当する。

`examples/recording-wire-delivery-ledger-cases.json`の61シナリオをtest-only `__fixtures__/recording-wire-delivery-ledger-cases.ts`経由で実台帳へ流す。driverは正常DTOを既存wire/c4a validatorへ照合し、元返信・attempt全文と旧poll結果を確認する。`recording-wire-delivery-ledger.test.ts`は共通シナリオと独立Q/R/I oracle・exact/1不足・credit/未回収枠・ownershipを確認する。`recording-wire-delivery-boundaries.test.ts`は全parse入口のprototype/descriptor再入とR/I故障注入、`e2e/recording-wire-delivery-ledger.spec.ts`はChromiumの実module・App保存bytes不変・外部送信無しを確認する。独立oracleは既存receiver fixtureの保守計数を再利用し、production walkerを参照しない。

元replyは元record、query/attemptは専用recordへ保持する。inspection包絡全体は永続複製せず、query request・closed outcome・元reply参照へ正規化する。mutation6MiB/read2MiB内で元begin時に初回probeも先取りし、履歴/creditを返却しない有限モデル。getterは新たな内部cacheを増やさない。既存receiverのAttach/Controlと本文を二重所有せず、Observationは次節へ分離する。通常App／coordinator／port／Promise adapter／実transport／nativeは未接続である。

## 記録wireのObservation配送台帳（H5d4c4c-prep2d2b）

`recording-wire-delivery-ledger/observation.ts`が既存台帳内にAccepted由来のtarget、論理query、正常返信ごとのattemptを保存する。公開入口と`types.ts`はopaque tokenとgetterを追加し、`core.ts`は独立4MiB pool・各4096 ID・未回収attempt最大1を管理する。元Admission返信やCallInspectionの保存内容は変更せず、target結果とquery terminalを別に保持する。返信喪失・malformed時は未回収枠を消さず、retire／dispose／sticky停止後も登録済みattemptの正常後着返信を保存する。pendingで終わった2回目以降のattemptは件数と管理bytesを返す（C6）。

`examples/recording-wire-observation-ledger-cases.json`のoperation／reconciliation／unavailable共通シナリオを`__fixtures__/recording-wire-observation-ledger-cases.ts`でNodeとChromiumへ流す。`recording-wire-observation-ledger.test.ts`はさらにAdmissionInspection、pending→terminal、同一ID、参照衝突、容量、二段階保存、再入を検証する。`e2e/recording-wire-delivery-ledger.spec.ts`はChromium実moduleで同じ進行とProject保存bytes不変を確認する。local-v2、Promise adapter、実transport、native ownerはこのpure台帳の外に残る。

## 記録wireのlocal-v2配送（C4）

[採用設計](../design/runtime/historian-recording-wire-local-v2.md)に沿い、`recording-wire-local-v2.ts`が実factory由来のledger／receiverのopaque tokenを六経路の同realm Promiseへ結ぶ。`recording-wire-delivery-ledger.ts`と`recording-wire-receiver.ts`のprivate WeakSetがsource instanceを検査する。明示`pump()`は元getterに保存済みの正常返信だけを一度配送する。`recording-async`、通常App、native owner、transportへの接続は後続工程である。

`examples/recording-wire-local-v2-cases.json`と`__fixtures__/recording-wire-local-v2-cases.ts`はNode／Chromium共通の配送経路を実moduleで実行する。`recording-wire-local-v2.test.ts`はforeign source／token、未配送、Observationのattemptとquery、後着、有限容量を確認し、`e2e/recording-wire-local-v2.spec.ts`はProject保存bytes不変も確認する。

## 記録wire coordinator-v2（C4、test-only）

[採用設計](../design/runtime/historian-recording-coordinator-v2.md)に沿い、`recording-wire-coordinator-v2.ts`が実ledger／receiver／local-v2とtest-only portを固定scopeで束縛する。source単位の一回claim、token帰属・容量、元返信Promiseと個別transport ticketの終了、Observation queryとattempt、close後の後着回収を別に保持する。`recording-wire-local-v2.ts`のprivate source brandは同scopeでも別ledger／receiverの組合せを拒否する。test portの同期lifecycleは開始前に終了したticketを送信へ流さず、元返信やnative workerの静止を偽装しない。

`examples/recording-wire-coordinator-v2-cases.json`と`__fixtures__/recording-wire-coordinator-v2-cases.ts`をNode／Chromiumで共通実行する。`recording-wire-coordinator-v2.test.ts`はreply／taskの全順序、CallInspection、Observation pending、Attach／Control、有限容量、source再claim、再入・後着を検証する。`e2e/recording-wire-coordinator-v2.spec.ts`はProject保存bytes不変を確認する。既存`recording-async`／通常App／Tauri／native ownerはこの区切りで接続しない。

## native registryへのowner引渡し（C4、seed）

[採用設計](../design/runtime/historian-recording-native-registry-adapter.md)の最初の安全gate。`scada-runtime/src/recording_registry.rs`は非Cloneの`RecordingRegistryOwnerSeed`へ実`RecordingOperationsOwner`を消費し、失敗時は理由と元ownerを返す。`recording_host/supervisor/operations/mod.rs`は公開clientの発行履歴と未使用Coreを照合し、`registry.rs`と`reconciliation/mod.rs`は各台帳のpristine判定を持つ。seedからのhandoffは既存の静止・回復gateへ委譲する。Rust `operations/tests.rs`は未使用成功、drop済みclient拒否、ロック競合後再試行、handoff済み拒否を確認する。seedはscope、認可、lease、admission、native結果配送をまだ持たない。

## 記録registryの純粋予算kernel（C4）

`scada-runtime/src/recording_registry/kernel/budget.rs`は検証済みAdmission一件のrequest／受付証拠reply／不変元reply／completionの生存期間上界をbytes・nodes・depthで計算する。`recording_registry_model.rs`は計測不正と容量不足を既存`ModelError`へ写し、`admission.rs`、`workflow/escrow.rs`、`projection.rs`が同じkernelを使う。simulationの時計・principal・判定・completionはkernelへ入れず、native受付資格も生成しない。既存`recording_registry_model`の境界・共有scenarioとRust全体試験で意味を保つ。

## 記録registryの実時計lease（C4、native root）

`scada-runtime/src/recording_registry/lease.rs`の非Clone `RecordingRegistryRoot`は排他的seed、固定scope、実`Instant`の期限、role別の有限lease台帳を保持する。factoryはnative ownerのcontext全文を照合し、失敗時にseedを返す。`recording_host/supervisor/operations/mod.rs`のcrate内context読取はこの照合専用。sessionはroot identity・scope・principal・roleを束縛するopaque capabilityで、issuerはRust unit testだけに置く。lease再取得は元replyと期限を保持し、別principal／scope／epoch／roleや同ID別本文を拒否する。handoff成功は新規lease受付を閉じる。`operations/tests.rs`で実ownerを使い、失敗時返却、再取得、期限後の同時枠、role、異rootを確認する。native admissionと製品session発行は後続。

## 記録registryの初回workflow予約（C4）

`recording_registry/kernel/workflow.rs`は四段階の最大ID・最大lease時間を使い、Admissionの生存期間保存bytesとlease往復bytes、snapshotのbytes／nodes／depth上界を純粋計算する。`recording_registry_model/workflow/escrow.rs`も同じstage templateを使う。`recording_registry/workflow.rs`は実ownerの既存Supervisor資格を確認し、同一principal・changeの初回ticketを一件だけ登録して保持bytesを先取りする。再取得は再課金せず、以前の汎用mutation leaseがあれば期限後も予約しない。予約後は汎用mutation leaseの新規発行を止める。`operations/tests.rs`はsimulationの予約増分とnative rootの確保量を比較し、容量exact／1不足・別caller・handoffを検証する。この段階ではstage別creditとrevisionの実使用、lease消費、元Admission、native呼出しは未接続。

## 記録registryのpreflight原本登録（C4）

`recording_registry/workflow.rs`の`issue_preflight_lease`は初回の予約済みlease保持量を移管し、期限切れretryだけ別のID・保存量・revision枠を追加予約する。`register_preflight`はroot／principal／workflow ticket、元change全文、lease refと期限、Admissionの生存期間上界を確認し、commit直前の実`Instant`で期限を判定する。成功時だけlease消費と元request・登録sequenceを同じ更新で確定する。登録済み同一要求の再取得は時計もnativeも使わず`Existing`を返す。read履歴はmutation件数に算入しない。`dispatch_preflight`は登録済み原本とleaseの絶対期限から実ownerを一度だけ呼び、実handleを保持して元replyを固定する。`preflight_reply`は同じ元返信、`preflight_completion`は保存済みhandleの完了を読む。`operations/mod.rs`のcrate内clientは排他的seedの所有下でのみ使い、外部へ公開しない。`lease.rs`は不確定dispatch時のhandoffを拒否する。`operations/tests.rs`は期限境界、retryのexact／1不足、role分離、別caller／別root、受理と同期拒否・同一reply再取得・完了を実ownerで確認する。後続native stageと製品session issuerは後続。

## 記録registryの実preflight受付照会（C4）

`recording_registry/inspection.rs`はread roleの同一root・principal・workflowと元Admission全文を照合し、保存済み実handleから現在の受付証拠を投影する。同じinspection IDの初回replyは固定し、新しいIDだけが後着証拠を読む。元dispatcher replyの`unknown`は書き換えない。Accepted証拠はread容量の確定後に登録recordへ保存し、後の投影障害でも後退させない。照会request＋replyを2MiB read枠へ原子課金し、最大4,096件に制限する。`workflow.rs`のAccepted投影helperはnative初回返信と受付照会で共有する。`operations/tests.rs`は未登録NotFound、登録後Unknown、実handle Accepted、panic後の証拠分離、容量exact／1不足、replayと権限を確認する。pause/join leaseの資格確認は次の区切り、製品session issuerは後続。

## 記録registryの初回pause/join lease（C4）

`recording_registry/pause.rs`は元preflightのAccepted証拠、保存済み実handleのCandidate完了、confirmed quiescence、回復不要、元request全文を照合してから、予約済みpause/join leaseを一件発行する。callerのoperation IDをworkflowへ固定し、preflightと同じleaseRequestId／admissionIdを拒否する。同一pause要求の再取得は元replyと期限を保つ。`operations/tests.rs`は実Candidate・受付照会で回収したAccepted・未完了・容量境界・ID再利用・別principalを確認する。native pause実行と元pause Admission登録は次の区切りで扱う。

## 記録registryの実pause/join配送（C4）

`recording_registry/pause.rs`はpause専用ticketを発行して元Admission全文と実期限を検査し、lease消費と登録を同時に確定する。登録済みticketから保存済み実change handleへ一回だけnative pause/joinを配送し、元受付replyとjoin completionを別に保持する。元`unknown`や`Calling`ではhandoffを止める。`recording_host/worker.rs`の試験専用shutdown gateは停止要求後のcleanup待機を作り、`operations/tests.rs`がRunning recorderの期限超過中もjoinを打ち切らないことをmock Hub・一時SQLiteで確認する。discardと製品session issuerは後続。

## 記録registryの初回apply lease（C4）

`recording_registry/apply.rs`は同一root・principal・scopeとpause専用ticketを照合し、保存済みpreflight Accepted、元pause Accepted、実pause handleの`paused / confirmed / recoveryRequired=false`完了、ownerのPaused状態から初回apply leaseを発行する。preflight／pauseとoperation ID、leaseRequestId／admissionIdの再使用を拒否し、既予約apply枠を移管する。同一全文の再取得は期限後も元replyを返す。`operations/tests.rs`はRunning cleanup待機中の拒否、正常join後の発行、preflight元unknownの独立Accepted回収、pause元unknownの停止、容量と別root／scope／principalを確認する。

## 記録registryの実apply Admission（C4）

`recording_registry/apply.rs`はapply専用ticketに元Admission全文・lease・実change handleを束縛し、登録とlease消費を一度に確定する。登録ticketから実native applyへ一回だけ配送し、元受付replyと実apply handleの完了を別に読む。元`unknown`と配送中はhandoffを止める。`operations/tests.rs`は一時SQLiteの適用revisionと試験専用native apply呼出回数を別々に確認し、commit後の応答喪失・投影失敗・SQLite FULL・期限切れを検証する。製品session issuerは後続。

## 記録registryの初回reconcile（C4）

`recording_registry/reconciliation.rs`はread roleの同一root・principal・workflow・元apply ticketを照合する。保存済み実apply handleと完了の全文一致、回復対象の結果、独立read lease・ID／2MiB容量を登録前に検査し、lease消費と元Admissionを一度に確定する。絶対期限でnative `reconcile`を高々一回呼び、実read handleを先に保存して元replyを固定する。`reconciliation_delivery`はそのhandleからのみ結果／readUncertainを読み、元applyのreply・completion・recoveryを変更しない。retryは新しいread leaseとadmissionIdごとに登録し、全先行readが確定返信（acceptedなら実handle完了）に達するまで`Busy`とする。同admissionId同本文は既存ticket、別本文はProtocolViolation。readはroot内の配列に順に保持し、Observation／cancelはreadRefで引く。`lease.rs`のhandoffはいずれかの不確定readを拒否する。`operations/tests.rs`は実SQLiteのcommit後応答喪失／FULLをreceiptFound／notFoundへ分け、元applyの投影失敗、期限と容量1byte不足、二重配送を検証する。`operations/tests/registry_read_retry.rs`は進行中readへのretry拒否とlease未消費、新readRefでの再読、使用済みIDの`consumed`、`readUncertain`後の停止を検証する。製品session issuerは後続。

## 記録registryのObservation（C4）

`recording_registry/observation.rs`の`observe_result`はread roleの同一root・principal・scopeを照合し、kindとrefで保存済み実handle（preflight／pause／apply／初回reconcile）を引いて元request全文を比較する。各段階の`completion()`／`delivery()`は`workflow.rs`／`pause.rs`／`apply.rs`／`reconciliation.rs`の登録recordに置き、ticket付きの既存読取とObservationが同じ照合を使う。照会はwatchの現在値を読むだけで、native task・待機・再配送を追加しない。未知refと実handleのない同期拒否はIDごとに不変の`unavailable`、新IDはrequest bytesだけをread枠へ課金し、各kind4096件・pending2枠とする。Rust `operations/tests/registry_observation.rs`で、一時SQLiteとmock Hubを使うpreflight→pause/join→apply→Observationの完走、pending→terminal、早期unknown ref、role・principal・epoch・同ID別本文の拒否、同期拒否・handle保存前panic・投影panic後のunknown・SQLite FULL後のfailedとreconcile delivery、受理後に期限を越えてowner処理へ入らなかったapply／pause/joinのfailed・`notDispatched`（元Accepted不変、native apply呼出し一回、SQLite不変、Blocked、handoffでのrecovery証拠引継ぎ）を確認する。

## 記録registryの元cancel call（C4）

`recording_registry/cancel.rs`の`request_cancel`は、operation対象をmutation role、reconciliation対象をread roleの同一root・principal・scopeで受ける。cancelIdは登録時にkindとrefで保存済み実handle（preflight／pause／apply／初回reconcile）へ一度だけ束縛し、未知refは不変の`rejected`とする。副作用なしの判定（pause/joinは`notSupported`、完了済みは`alreadyCompleted`、通知済みは`requested`）の後、残りだけ実handleの`request_cancel`を一回呼ぶ。通知済みhandleはrootの`cancel_notified`集合で全IDを通じて一回に限る。request＋reply上界をread枠へ一回課金し、4096件まで保持する。同ID同本文はclose後も元replyを返す。Rust `operations/tests/registry_cancel.rs`で、gate中applyへのcancelと重複・別ID・late結果後の`alreadyCompleted`、Observation pendingの明示再照会、pause/joinの`notSupported`と停止継続、完了済みpreflight、namespace分離、role・principal・epoch・容量exact／1不足、handoff後のreplayとClosed、read cancelが元applyのfailedとrecoveryを変えないことを確認する。

## 記録registryの初回discard（C4）

`recording_registry/discard.rs`は保存済みpreflight Accepted、対応する実handleのCandidate完了とownerのCandidate／Paused状態を照合し、discard専用leaseとAdmissionを原子登録する。pause／applyの有効な意図と配送中・不確定な結果は競合として止める。登録ticketから実native discardへ一回だけ配送し、元返信を固定する。`completedDiscard`時だけ未発行のpause／apply枠を一度返却し、元preflightのunknownが独立Acceptedへ回収済みならhandoffを許す。discard自身のunknownはhandoffを止める。`operations/tests.rs`はRunning recorder、Paused、apply拒否、期限切れ、応答喪失、呼出回数、SQLite不変、予約返却を確認する。

## 記録registryの容量poolと境界試験（C4）

`recording_registry/lease.rs`の`CountLimits`はrootの件数上限（AdmissionInspection・CallInspection・cancel・kind別Observation・pending Observation・live購読・attach・control）をまとめ、本番値は`CountLimits::DEFAULT`に固定する。試験専用の`test_set_count_limit`は上限を下げるだけで、bytes枠より先に件数枠の境界へ届かせる。`operations/tests/registry_capacity.rs`は全poolのexact／1不足を一つの表で確認し、`CountPool`の追加は網羅matchで表への追加を強制する。最大長IDの一workflowで元返信が予約上界内に保存されること、同ID別leaseと配送待機中の期限も同じファイルで確認する。
