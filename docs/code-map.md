# コードと検証の対応表

状態: **現行構造の案内**。基準は画像crop接続後の`e04e44c`。責務や関数の移動時はこの対応表を更新する。[現在の実装状況](implementation-status.md)、[構造整理の計画・結果](maintenance-refactoring-plan.md)、[作業規則](../AGENTS.md)を併読する。

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
| Runtime読取              | `lib/tag-presentation.ts`、`crates/scada-runtime/src/{lib,slots,projection}.rs`                                                                                                   | 現在値・QualityをProject定義と分ける。Hub／PLC機能を複製しない                 |
| テスト                   | `lib/*.test.ts`、`examples/*-cases.json`、`e2e`、`.github/workflows/ci.yml`                                                                                                       | 単体の契約とブラウザ操作を併用し、既存の拒否ケースを保持                       |

`lib/`は`apps/banto-scada/src/lib/`を指す。現在の依存方向は「UI → 編集／履歴 → Project検証」。純粋計算・モデルからDOMやAppをimportしない。

## 機能を変更するときの対応表

変更対象の行を入口に、対応する契約・実装・関連検証を読む。

| 変更内容                     | 実装・契約                                                                    | 追加で読む設計                                                                                                       | 主な検証                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 塗り・線・α・一括属性        | Primitive、ShapePaint、Selection系、editor、project                           | [塗り](shape-paint-design.md)・[線種](line-style-design.md)・[α](color-alpha-design.md)                              | shape-paint・gradient・pattern・selection・numeric関連                       |
| 画像配置・差替え・背景・取込 | image-assets／frame／crop、Project、描画、image-import controllerとAppの接続  | [画像保存](image-assets-design.md)・[配置と差替え](image-placement-design.md)                                        | image-assets・placement・replacement・background、開始時に追加済みのcrop関連 |
| コピー／切取／貼付           | clipboard controller、clipboard、image-clipboard、editor、資産lease           | [画像clipboard](image-clipboard-design.md)                                                                           | clipboard・image-paste・asset-clipboard                                      |
| 画面・Symbol・フォルダー     | editor、screen-references、layer-tree／drag、使用先集計                       | [埋込](embedded-screen-design.md)・[配置ドラッグ](layer-drag-design.md)・[フォルダードラッグ](folder-drag-design.md) | screens・symbols・screen-view・layer／folder関連                             |
| 選択・viewport・数値         | Renderer、CanvasWorkspace、geometry、drafts、numeric-properties               | [選択表示](selection-view-design.md)・[回転](object-rotation-design.md)・[UX](frontend-ux-design.md)                 | numeric・range・rotation・resize・viewport・wheel・placement                 |
| 保存形式                     | TS Project、JSON Schema、Rust Project、生成処理、examples、package／clipboard | [保存基盤](image-assets-design.md)・[統合設計](scada-integrated-design.md)                                           | TS／Rust共有ケース、JSON／package往復、copy／paste、Undo                     |

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

`apps/banto-scada/scripts/benchmark-editor.mjs`はViteのSSR loaderで現行ドメイン関数を読み込み、100／1,000／5,000配置の編集・履歴・Undo・保存と各処理の独立probeを計測する。ブラウザ描画や入力から表示までの遅延は測らない。実行方法・fixture・解釈・結果は[編集性能の計測](editor-performance.md)を参照する。通常のunit／E2Eに時間閾値を追加するものではない。

## 幾何グループ（0.22.0）

- `lib/geometric-groups.ts`：所属の意味検証、選択全体の検査・展開、操作単位、bounds・90度回転。UI状態・履歴を持たない。
- `lib/editor/group-handler.ts`：作成／解除／名前／回転／状態／描画順。候補だけを変更し、共通finish・Undoは入口側。
- `lib/editor/group-arrangement.ts`：groupを含む整列・等間隔。子の間隔を保ち単位を移動する。
- `object-handler.ts`：部分指定と内部の書式変更を拒否。`selection-handler.ts`：複製／削除の所属処理。`model-helpers.ts`：画面複製のID対応。
- `clipboard.ts`／`asset-clipboard.ts`／`paste-handler.ts`：明示v3、画像原本・所属・配置ID再採番。旧v1／v2でgroupを受理しない。
- `examples/geometric-group-cases.json`をTS／Rust双方で使用。`geometric-groups.test.ts`は原子性・Undo・幾何・再利用・Proxy・名前と状態の境界。`geometric-group-contract.spec.ts`は実ブラウザの読込・v3コピー・保存／Undoと不正読込保持。

G3でDesignerも接続した。`App.svelte`の選択・キー・mode境界を純粋なgroup単位へ接続し、`layer-tree.ts`／`LayerTree.svelte`が検索可能な1行を表示する。`layer-drag.ts`は全メンバーの所属変更を扱う。`GroupInspector.svelte`と`forms/group-name.ts`は名前の世代・対象・draft・IMEを保護し、共通操作は`designer-actions.ts`のtoolbar／メニュー／右クリックへ置く。`geometric-groups.spec.ts`は両テーマ・F2・IME・Undo後のdraft・使用先・状態・ドラッグ／方向キーを確認する。現在の機能提供段階は[実装状況](implementation-status.md)を参照する。

型付き読取slotの契約・現在値の非永続化・後続Equipmentとの境界は[初回設計](typed-read-slots-design.md)を参照。`slots.rs`が機器contextとplan、`projection.rs`が既存Textと共通のmetadata／値検証を所有し、`tests/sdk_projection.rs`で実SDKのloopback投影を確認する。

Equipmentは`lib/equipment.ts`と`crates/scada-model/src/equipment.rs`が保存後の意味検証、`editor/equipment-handler.ts`が原子的な候補編集を担当する。初期UIは`EquipmentLibrary.svelte`、対象世代とFormDataの解釈は`forms/equipment.ts`。共通契約は`examples/equipment-cases.json`、UIの回帰は`e2e/equipment.spec.ts`。[契約と検証](equipment-register-design.md)を参照する。

[機器とSymbolの関連付け](equipment-symbol-association.md)は`equipmentUsages()`が非永続の全画面参照索引を生成し、同じ意味検証をTS／Rustで実行する。`single-object-handler.ts`と既存objectフォームが関連付け、`equipment-handler.ts`が使用中削除拒否、`clipboard.ts`が機器移入の明示拒否を担当。`e2e/equipment-association.spec.ts`と共通`equipment-reference-cases.json`で検証する。

共有Symbolの読取宣言は`project.ts`と共通schema、意味検証・機器contextの取得前状態解決は`lib/symbol-slots.ts`が担当する。`symbol-handler.ts`は宣言＋Textの原子的追加、既存objectフォームは宣言選択、`ObjectPainting`／`Primitive`は値を代用しない描画を担当する。`EquipmentContext`はメイン／minimap／埋込／小窓へ明示伝搬し、global stateを作らない。共通`symbol-slot-cases.json`、`symbol-slots.test.ts`、`e2e/symbol-slots.spec.ts`で確認する。[実装範囲](symbol-read-slots.md)を参照する。

読取DTOの構造は`crates/scada-runtime/schema/read-slot-view.schema.json`、TSの受入・plan照合・世代／frame所有は`lib/read-slot-session.ts`が担当する。`equipmentReadContext()`がcurrentProjectと返却frameを表示contextへ接続し、`symbol-slots.ts`が保存設定を優先して解決する。`TextPrimitive`はSIM・Quality・由来の文字／属性を描画し、接続やQuality判定を所有しない。共通`read-slot-view-cases.json`とRustの実投影、`read-slot-session.test.ts`、`e2e/read-slot-session.spec.ts`で確認する。[受入契約](read-slot-presentation.md)を参照する。

Symbol宣言のCRUDは`editor/symbol-handler.ts`、全Text参照の導出は`symbolSlotUsages()`。`designer/SymbolSlots.svelte`は左の宣言UIと使用保護の説明、`forms/symbol-slot.ts`は世代・定義・元のslot名を照合し、成功した追加フォームだけ初期化する。既存`add-symbol-readout`は宣言行からの操作では存在を再確認する。`symbol-slot-editing.test.ts`／`e2e/symbol-slot-editing.spec.ts`で検証する。[編集契約](symbol-slot-editing.md)を参照する。

読取表示結果の判別共用体・欠測文言・SIM判定・boolのtrue／false／unknownへの純粋な変換は`lib/slot-presentation.ts`が担当する。Goodだけに型付きvalueを持たせる。`read-slot-session.ts`は所有コピーを返し、`TextPrimitive`はinvalid理由も表示する。`slot-presentation.test.ts`と既存session／ブラウザ検証で確認する。[動的配色への前段と残り](bool-slot-state.md)を参照する。

状態別文字色はTextの`boolColors`として`project.ts`と共通schemaに保存し、`symbol-slots.ts`／Rustの意味検証でbool宣言へ制限する。`Primitive`が型付き状態を色へ接続し、`BoolColors.svelte`と`forms/bool-colors.ts`が独立した編集フォームを持つ。`object-form.ts`は静的／number変更時の同時解除、Appのdraft事前検証は二重入力の競合拒否を担当する。[提供範囲と検証](bool-text-colors.md)を参照する。

図面外の読取状態は`lib/slot-status-summary.ts`が現在の可視配置経路・使用roleを収集し、既存resolverへ状態解決を委譲する。`SlotReadStatus.svelte`は件数・20件ページング・開閉のみを所有し、Appと`PreviewWindow`が描画と同じcontextを渡す。`slot-status-summary.test.ts`、`e2e/slot-status-summary.spec.ts`、既存の同一mount検証で確認する。[範囲と後続](slot-status-summary.md)を参照する。

`studio.css`は取得状態一覧がある画面に限り図面タイトルを通常配置へ戻し、一覧との重なりを防ぐ。状態一覧のブラウザ検証で、折畳み時／展開時にタイトル・一覧・canvasが重ならないことを確認する。

状態色追従は`lib/state-color.ts`が参照・塗り条件の検証と色解決、`designer/StateColor.svelte`と`forms/state-color.ts`が編集入力を担当する。`Primitive.svelte`は動的な塗り／線と静的枠線を分離する。`model-helpers.ts`の`remapStateColor`を定義複製・複数選択複製が共用する。`state-color.test.ts`、共通`examples/state-color-cases.json`、`e2e/state-color.spec.ts`と同一mount読取試験が回帰入口。[契約](state-color-following.md)。

機器の読取詳細は`equipment-read-details.ts`が全採用slotの導出、`EquipmentReadDetails.svelte`が20件ずつの表示を持つ。`symbol-slots.ts`の`resolveEquipmentSlot`をSymbolと共用する。`preview-popups.ts`の`kind + targetId`を画面／機器小窓が共用し、枠・フォーカス・前後順は既存PreviewWindow／PreviewPopupsが担当する。`equipment-read-details.test.ts`・`preview-popups.test.ts`・`e2e/equipment-read-details.spec.ts`と同一mount試験を変更時の入口にする。[詳細](equipment-read-details.md)。

Symbolからの読取詳細の起動はInspectorの`onopenequipment`をAppの`openSelectedEquipment`へ渡す。draft解決後の機器再取得とmode遷移・tick後の世代照合はApp、直接起動と既存窓の再前面化はPreviewPopupsの`showEquipment`が担当する。`e2e/equipment-read-entry.spec.ts`で適用／破棄／キャンセル／関連付け解除・ロック中・履歴不変を確認する。

TextPrimitiveの非表示計測の再試行はResizeObserver通知中にprobeへ書き込まず、requestAnimationFrameへ集約する。破棄時に予約を取り消す。隠れた部品パネルからの計測復帰はtext-style、mode／Modal切替でのResizeObserver配送エラー不在はequipment-read-entryで検証する。

機器種別の編集は`EquipmentTypes.svelte`が構造draftと採用数表示、`forms/equipment-type.ts`が入力・世代・種別の検査を持つ。`EquipmentLibrary.svelte`が機器割付との切替をdraft経路へ通す。既存`equipment-handler.ts`と最終Project検証が参照保護・原子性を維持する。`equipment-type-editing.test.ts`と`e2e/equipment-types.spec.ts`が回帰入口。[詳細](equipment-type-editing.md)。

機器台帳の検索と20件ページングはEquipmentLibrary内の一時UI状態。番号・名前・種別名をNFKCと大小文字の正規化で検索し、選択とフォームを検索結果から独立させる。`e2e/equipment-search.spec.ts`の55件台帳でDOM行数・ページ境界・検索・draft保持・保存不変を確認する。

機器小窓の図面使用先は既存`equipmentUsages`を`PreviewWindow`から`EquipmentReadDetails`へ渡し、独立した20件ページで表示する。移動は`App.openPreviewEquipmentUsage`から既存`openSymbolUsage`を呼び、世代・呼出mode・Symbol／機器参照の再確認と編集復帰、グループ選択を共用する。`e2e/equipment-usage-navigation.spec.ts`が非表示／ロック・別画面・グループ・ページ境界・保存不変を確認する。

別機器登録は`EquipmentLibrary`が登録元IDと新規入力を保持し、`forms/equipment.ts`が現行Projectの元機器から採用slotを未割付にして既存`create-equipment`へ渡す。戻る処理はクリック時のID・世代を固定し、登録後の自動選択と競合させない。`e2e/equipment-copy.spec.ts`で両テーマの独立登録・元機器と配置の不変・重複拒否・Undo／Redoとdraft分岐を確認する。

Symbolと機器の候補確認は`symbol-equipment-check.ts`が実使用slotを既存resolverで保存設定だけから導出する。`SymbolEquipmentCheck.svelte`は親フォームの現在値を読取専用で監視し、モデル反映後のtick・フォーム同一性・対象keyを保護する。`InspectorPanel`はobjectの世代key内、編集fieldset外へ置く。`symbol-equipment-check.test.ts`と`e2e/symbol-equipment-check.spec.ts`がhidden・未使用・設定状態と未適用／破棄／Undo・ロック・ページ境界を確認する。[詳細](symbol-equipment-check.md)。

選択Symbolから機器台帳への移動は`App.openSelectedEquipment`のsettings分岐で読取詳細のdraft解決・機器再取得を共用する。`EquipmentLibrary.showEquipment`が一覧への切替とID選択を行い、tick後に同じ世代・対象・接続中のformだけを返す。Appが再照合してツリー展開・focusを担当する。`e2e/equipment-settings-entry.spec.ts`がpanel／種別view復帰とdraft全分岐を確認する。

機器のcontext操作は`designer-actions.ts`の`selectionContext`が単一・画面Symbolだけに二つの入口を追加し、hostの`openEquipment`へ委譲する。Appの既存起動関数を共用し、メニュー側に別の対象解決・draft処理を作らない。`e2e/equipment-context.spec.ts`でcanvas／レイヤーのShift＋F10・プロパティ非表示・ロック・未関連・複数選択・未適用割付を確認する。

配置画像の表示方式は`image-fit.ts`の閉じた型／SVG対応と、既存image handlerの`set-image-fit`が担当する。`ImageFitSettings`／`forms/image-fit.ts`が独立draft・実枠比率の見本と対象世代照合を持つ。`ObjectPainting`から共通`ImagePainting`へfitを渡し、crop矩形とviewportのclipを共用する。`image-fit-cases.json`をTS／Rustで検証し、`image-fit.test.ts`と`e2e/image-fit.spec.ts`・cropの全fit共通描画試験を変更時の入口とする。[具体設計](image-fit-design.md)。

背景cropは`BackgroundImage.crop`と共通schema、TSの`imageCropViewBox`とRustの`validate_image_crop`で配置と同じ数値契約を使う。`ImageCrop`のbackgroundモードを背景設定へ置き、`forms/background-crop.ts`が対象世代とassetを照合して既存`set-background-image`へ渡す。`screen-handler`でProxy由来のcropをplain dataへコピーし未知属性は最終schemaへ残す。`ScreenBackground`はcrop時だけ共通`ImagePainting`を使い、originalの元画素配置とopacity一回を担当する。

`image-import.svelte.ts`の背景epochはasset＋cropの変更・往復を失効させ、fit／opacityだけは確定時の最新値を保持する。同hashではcropをコピーし別hashでは解除する。`background-crop.test.ts`／Rust共通fixtureと`e2e/background-crop.spec.ts`・既存background-imageが数値、Proxy、実画素、原本往復、遅延取込、全描画入口を検証する。[設計と実画面](background-image-crop-design.md)。

### 原本プレビュー上の切出し操作

`designer/image-crop-gesture.ts`は原本内の移動・四辺／隅・範囲指定の幾何、`ImageCropSelection.svelte`はpointer候補・capture・取消・矢印操作、`ImageCrop.svelte`は数値欄とdraft保護への接続を担当する。Projectの更新は従来のcropフォーム／commandへ戻す。`image-crop-gesture.test.ts`と`e2e/image-crop-gesture.spec.ts`で境界・1画素・取消・保存とUndoを確認する。設計は[切出し操作](image-crop-pointer-design.md)。

### 埋込Viewのclipboard

`clipboard-dependencies.ts`はView参照画面・Symbol・画像原本の閉包収集、`clipboard.ts`は必要データだけのv4 envelopeとsnapshotを担当する。`paste-handler.ts`は現行画面再利用を先に決め、実取込配置から定義・資産の対応表を作り、内部ID更新と外部参照を再配線する。`asset-clipboard.ts`のlease／decodeとcontrollerの所有者・切取保護は共用する。`screen-view-clipboard.test.ts`、`asset-clipboard.test.ts`、`e2e/screen-view-clipboard.spec.ts`で参照・原本・失敗時を確認する。[設計](screen-view-clipboard-design.md)。

### 放射グラデーション

`project.ts`と共通schema／RustはradialGradientの中心・半径・有限描画範囲を検証し、`paintBaseColor`は始点色を返す。`Primitive.svelte`はinstanceごとのSVG IDとobjectBoundingBox描画、`designer/radial-gradient-fields.ts`は％入力・未変更値の往復、`ShapePaint.svelte`は種類別draftと未適用見本を担当する。既存shape-paintフォームで1回の編集へ戻す。共通`shape-paint-cases.json`、`radial-gradient.test.ts`、`e2e/radial-gradient.spec.ts`が検証入口。[設計](radial-gradient-design.md)。

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
