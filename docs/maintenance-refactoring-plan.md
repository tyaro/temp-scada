# 保守性・AIコーディング向けリファクタリング実行計画

作成日: 2026-10-20（日本時間）。対象: temp-scada本体のコード・テスト・ドキュメント。Solが実装を担当する際の作業順、境界、検証、完了条件を定める。作成時点ではリファクタは未着手。現在の進捗は[§9](#refactoring-progress)で管理する。

機能仕様の基準は[統合設計](scada-integrated-design.md)、進捗の入口は[開発計画](development-plan.md)、作業規則は[AGENTS.md](../AGENTS.md)。本書は既存機能の振る舞いを保って構造を整理する計画で、Equipment・Faceplate等の新機能の実装計画ではない。

## 1. Solの開始手順

1. `git status --short`と最新コミットを確認する。作成時のHEADは`871920b`（画像トリミングの計算基盤）。同時に画像トリミングのモデル・描画の未コミット変更が存在し、作業ツリーではschema 0.21.0への更新が進行していた。
2. メインで進行中の機能を、その機能の検証・保存まで仕上げてから本計画へ入る。既存変更を破棄・巻き戻し・無関係なコミットへ混入させない。開始時点のHEAD・保存形式・作業中の差分を本書§9へ記録する。
3. §3の責務と§4の不変条件を読む。対象機能の詳細文書とテストだけを追加で読む。上流スナップショット全体を毎回読む必要はない。
4. **R0 → R1 → R2 → R3 → R4 → R5**の順で進める。R6は性能計測で必要性が確認された場合だけ実施する。各工程内も下記の小区切りで保存する。
5. 各区切りで対象差分と必要なテストを確認し、§9を更新する。実装の移動と新機能・保存形式変更を同じ差分へ混ぜない。

最初の実装作業はR0の基準確認、次にR1の現在情報の整理。Appの全面移動から始めない。実ファイルが移動済みなら関数名・型名で検索して対応表を更新し、同じ責務の別実装を作らない。

## 2. レビュー結果と根拠

| 優先度 | 確認事項                                                                                      | 保守上の影響                                                         | 対応工程 |
| ------ | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------- |
| 高     | `App.svelte`はレビュー時約5,400行・119関数。画像、clipboard、フォーム、画面・レイヤー等を所有 | 1機能の変更でも広い文脈と多くの暗黙の依存を読む必要がある            | R3・R4   |
| 高     | `formCommand`／`acknowledgeForm`が子フォームのname・datasetを解釈                             | 子の項目変更と親の解析・確定処理がずれても型検査だけでは検出しにくい | R3       |
| 高     | 開発計画の「現在の実装状況」にschema 0.16.0・古い検証件数が残る                               | AIや保守担当が過去の制約・形式を現在仕様として採用するおそれがある   | R1       |
| 中     | `editor.ts`約1,300行。`isObjectCommand`の分類リストと処理分岐を手動更新                       | コマンド追加時の分類・処理漏れをコンパイラで保証できない             | R5       |
| 中     | E2Eの27ファイルが`.sheet > svg`を参照し、10ファイルが`/src/lib/`等を参照                      | DOM構造・モジュール移動に伴う修正範囲が広い                          | R2       |
| 計測後 | `applyCommand`・`finish`・history・保存状態比較がProject全体を処理                            | 大規模図面で編集時間・メモリに影響する可能性。遅延の実測は未実施     | R6       |

数値は前回レビュー時点の観測で、上限や完成判定ではない。前回レビューでは型チェックがエラー・警告なし、TS単体609件が成功した。この結果は当時の作業ツリーに対するもので、現在のHEADや進行中の画像トリミング全体の合格を保証しない。Rust・全E2Eはそのレビューでは再実行していない。

維持する強みは、厳格なTS型検査、編集コマンドと履歴の分離、TS／Rustが共有するJSON Schemaと契約ケース、描画の再利用、Banto共通基盤、既存CI。これらを新しい独自基盤へ置き換える作業は本計画に含めない。

## 3. 現在の責務と読む場所

[コードと検証の対応表](code-map.md)へ集約した。App、編集・履歴、モデル・画像、入力保護、読取Runtimeの責務をここへ重複記載しない。移動時はcode-mapを更新する。

## 4. すべての工程で守る条件

| ID  | 条件                                                                                                           | 主な確認先                                                            |
| --- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| I1  | 変更失敗・取消でProject、選択、原本の整合性を失わない。複数対象の拒否で部分変更しない                          | editor・multi-edit・clipboard・画像関連テスト                         |
| I2  | 内容変更のない適用ではUndoを増やさない。不正入力を同値比較で捨てない                                           | history・save-state・paint関連テスト                                  |
| I3  | Undo／Redoは内容を復元し、編集revisionは過去へ戻さない。UI選択・倍率や実値を履歴に混入させない                 | `history.test.ts`・`save-state.spec.ts`                               |
| I4  | 数値のEnter／blur確定、IME、無効入力、他の未適用フォームを保護する。既存の全フォーム事前検証と適用順を維持     | numeric-properties・range-input・inspector・tag-picker                |
| I5  | Project・画面・定義・モード等を離れて戻っても、古い非同期結果を復活させない                                    | image-replacement・image-paste・asset-clipboard・interaction-snapshot |
| I6  | 編集ロック、非表示、プレビューの制約をUIだけに任せずコマンドでも検証する                                       | edit-lock・visibility・editor                                         |
| I7  | 同じ描画規則を編集・表示プレビュー・ミニマップ・埋込・小窓で使う                                               | screen-view・minimap・preview-popups・画像描画                        |
| I8  | 未接続・Bad・Staleを正常値、0、停止へ置換しない                                                                | tag-presentation・binding・screen-view                                |
| I9  | 保存内容、ID、配列順、参照先をリファクタの都合で変更しない。保存先ファイルへの書込完了をブラウザから断定しない | Project往復・package・save-state                                      |
| I10 | 原本は現在ProjectとUndo／Redo・処理中leaseから必要な間保持し、不要になった時点で回収する                       | image-assets・image-clipboard・image-replacement                      |

複数フォーム適用時の履歴は現行のフォームごととする。R3で一括Undoへ変えない。入力適用後にドラッグを再操作させる等の既存仕様も、構造整理の途中で変更しない。

## 5. 工程と完了条件

### R0：開始時の基準を確保

- 開始時HEAD、作業ツリー、保存形式を記録する。進行中機能の検証結果と、リファクタ開始後の結果を分ける。
- §7の型チェック・単体を実行し、最初に触る領域のE2Eが通ることを確認する。同じ内容で直前に成功した記録がある場合はそのコミットと範囲を利用できる。
- 既存失敗はテスト名・条件・症状を記録し、その失敗と無関係な構造変更を同時に積まない。新たな失敗を既存扱いにしない。
- **完了条件**：以後の差分の基準と、開始時の既知の問題が説明できる。

### R1：現在仕様・履歴・変更案内を整理

対象: `README.md`、`AGENTS.md`、`docs/development-plan.md`、本書、関連設計書。

1. `docs/implementation-status.md`を新設し、現在の実装状況・保存形式・未実装範囲の唯一の要約とする。schemaと実装を照合して埋める。本書の0.20.0／0.21.0という観測をそのまま転記しない。
2. 開発計画は今後の工程と進捗へ整理。日付付き実装記録は`docs/implementation-history.md`へ移す。既存リンクがあるanchorは、元ファイルに移動先への案内を残す。
3. READMEは起動・検証・機能ガイドへの入口を優先し、詳細操作は`docs/user-guide.md`へ整理する。現在状況やテスト件数を複数文書で複製しない。
4. `docs/code-map.md`に§3と§6を移して、責務・機能別の変更箇所・テストの対応を保守する。本書は実施計画と結果へ絞り、対応表の二重管理を残さない。
5. 各設計文書の先頭で「現行仕様／採用済み設計／提案／履歴」を識別できるようにする。未実装の計画を現行仕様へ昇格させない。上流スナップショットは編集しない。
6. ローカルリンクの存在、anchor、Git収録予定を確認する。`docs/prototypes/`は操作試作であることを保持し、`scratch`の絶対パスを再現手順の前提にしない。

上記の新設ファイル名は作業先の指定であり、R1前には存在しない。分割作業は「状況と履歴」「利用者ガイド」「コード対応表」の区切りで保存してよい。

**完了条件**：README→現在状況→対象設計／コード／検証へ辿れる。古いschemaや件数を現在情報として記載しない。移動前のリンクも失われない。文書整理だけではアプリコードを変更しない。

### R2：小さなテスト補助を先に揃える

対象: `e2e/helpers/designer.ts`、画像関連spec、`playwright.config.ts`、必要ならCI。

1. 既存helperを使い、主キャンバス取得・Project読込／書出し待機・画像fixture生成を関数単位で共通化する。新しい巨大なPageObjectや独自テスト基盤は作らない。
2. 最初は`image-placement.spec.ts`・`image-replacement.spec.ts`・`background-image.spec.ts`の共通準備へ適用する。その後、実際に変更する領域のspecへ段階的に広げる。
3. 主キャンバス・埋込・ミニマップを明示的に区別するselectorを1か所で管理する。通常操作にはrole／labelを使い、SVG構造の検証が必要なケースは意図を残す。
4. `/src/lib/` importは用途を調べる。純粋なpackage読込の検証は単体側へ寄せる。ブラウザ内の描画・障害注入に必要なものはhelperへ集約し、意図をコメントする。故障注入を本番の公開APIへ追加しない。
5. E2E失敗時のtraceとレポートを取得できるようにし、CIで失敗時成果物を残す。テストの実行対象・判定・待機条件を緩めて通さない。

**完了条件**：対象specが同じ操作と期待結果で成功する。固定sleepを増やさない。テストとアプリの大きな移動を同じ区切りへ入れない。

### R3：フォームの文字列契約を局所化

対象: Appの`formCommand`・`acknowledgeForm`・`validateDrafts`・`submitForm`、`designer/drafts.svelte.ts`、各フォーム。

**最初の一単位はShapePaintだけ。** その後にSelectionOutline、SelectionLine、SelectionColor、SymbolColorMode、背景画像、画像crop、通常Object／Screen／Project・移動の順で移す。追加済みの画像cropも対象に含める。

- `lib/designer/forms/`へフォームごとの入力解析とコマンド作成を置く。数値解析は`numeric-properties.ts`、patternは既存の`pattern-fields.ts`を使う。
- フォームのname、種類の列挙値、未指定の意味はそのフォームのadapterに閉じる。親Appが子の入力名を列挙してresetしない。
- adapterの責務は「型付き対象情報の確認・入力からEditCommandを作成・適用成功後の固有入力確定」。Appがkindでfactoryへ委譲する。既存DraftGuardのdirty登録と適用／破棄／取消を維持し、新しいcallback登録機構や別のdirty台帳を作らない。エラー通知・不正欄への誘導も既存経路を維持する。
- 対象情報はProject世代、画面／定義ID、必要な配置IDで明示する。変更前の対象を保持し、適用時に現在対象と照合する。
- 入力解析はProjectを変更しない。全dirtyフォームのコマンドを候補Projectへ順に適用して検証し、成功した後だけ現行のsubmit経路で確定する。
- `commitNumber`・IME・`beforeAllow`・`acceptField`の呼出順を維持する。dirtyのDOM保存方式を全廃する作業は今回に含めない。
- Appにはkindの振分け、現在対象の型付き情報の供給、全体の候補検証、submit順序、共通`drafts.submitted`を残す。個々の`input[name=...]`解析と固有resetをadapterへ移す。動的callback登録が必要になれば別工程として検討する。

**完了条件**：移した既存フォームの項目追加が、そのフォーム／adapter／テストで完結し、Appの解析・reset変更を要しない。新しいkindの委譲追加はAppに残してよい。無変更適用、未指定の一括編集、無効値、取消、対象切替、数値確定と別欄の保留を保持する。各フォームの移動ごとに§7の該当E2Eを通す。

### R4：Appの機能単位を抽出

抽出先は`lib/designer/controllers/`。Svelteの反応性が必要な場合だけ`.svelte.ts`を使う。Project・history・workspaceGenerationは当面Appが一元所有し、controllerは必要なsnapshotのgetterと編集・通知callbackだけを受け取る。各controllerへAppの全状態を渡す構成や、別のProjectコピーを持つ汎用storeは作らない。

| 小区切り | 抽出先案                             | 移す責務                                                               | Appに残すもの                                          |
| -------- | ------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------ |
| R4a      | `image-import.svelte.ts`             | `prepareImage`、配置・背景・差替えの取込要求、仮Storeの破棄、専用epoch | file inputの描画、現在状態の供給、共通edit接続         |
| R4b      | `clipboard.svelte.ts`                | `clipboardAction`の非同期要求、snapshot、lease、成功後のcut、取消      | nativeイベントの受付、入力欄へ横取りしない判定との接続 |
| R4c      | `project-files.svelte.ts`            | 読込候補、置換要求、書出し、busyと保存状態                             | Project採用の一元処理、画面・履歴の一括初期化          |
| R4d      | `LayerTree.svelte`と必要なcontroller | レイヤーの一覧描画・検索・展開・drag・folder dialogの接続              | 選択と編集コマンドの共通入口                           |
| R4e      | `designer-actions.ts`                | メニュー・toolbar・contextの共通action定義                             | キー／クリックイベントの受付と現在contextの供給        |

`LayerTree.svelte`は`lib/designer/`配下。名前は既存との衝突がなければ上記を使い、変更した場合はcode-mapを同時更新する。CSSは所有するmarkupと一緒に移し、Svelteのstyle scope変化を両テーマで確認する。

R4bではブラウザのユーザー操作境界も維持する。native clipboardの読取りはイベント中に同期取得し、Promise付き`ClipboardItem`の`write()`は最初の`await`前に開始する。controller化でこの順序を変えず、snapshot・原本lease・切取成功後の削除と合わせて検証する（Astraの読取レビューによる補足）。

非同期の取消条件は操作ごとに異なる。画像差替えは選択配置・元asset・ロック、cutは元snapshotと編集世代、保存は書出し開始時の内容を保つ。既存条件を一覧にしてから移し、すべてを一つのepochへ統合しない。離れて戻るケース、拒否、失敗、資産解放を受入対象にする。

**完了条件**：Appの該当機能のstate・effect・処理が抽出先にまとまり、相互importが循環しない。共通edit／draft／history境界は維持。Appの行数だけを成果指標にせず、変更に必要な知識が機能内で閉じたかを確認する。

### R5：編集コマンドを分類し、追加漏れを型で検出

対象: `lib/editor.ts`、`lib/history.ts`、対応する単体テスト。

1. `lib/editor/commands.ts`にEditCommand等の型を移す。既存`editor.ts`は公開入口として再exportし、import先の一斉変更を避ける。
2. `isObjectCommand`の分類を型で全種類照合できる定義へ変更する。例えば全`EditCommand["type"]`をキーとする`Record`でscopeを宣言し、未分類を型エラーにする。
3. `lib/editor/`配下でproject／screen／symbol／folder／image／objectのhandlerへ処理を分ける。外側の`applyCommand`がmode確認・候補作成・handler選択・検証・同値判定・revision更新を所有する。
4. handlerは候補だけを変更し、元Project・history・DOM・通知を触らない。`finish`の検証・同値判定・revision更新の順序を維持する。
5. 分岐の最後で未処理のコマンドが残れば`never`相当の網羅性確認で型エラーにする。未知の処理をno-opとして成功させない。
6. lock・preview・非対応型の拒否を保持する。ObjectPatchの型別厳密化やTS型のschema自動生成は別工程とし、この分割に混ぜない。

**完了条件**：新しいコマンド型を追加して分類・handlerを省くと型検査が失敗する。既存の全単体と編集・履歴の関連E2Eが通り、保存JSONとUndo単位が変わらない。

### R6：性能最適化は測定結果から選ぶ

大きなProjectで、1回の編集、連続移動確定、Undo、保存の処理時間とメモリを計測する。Project全体の検証・canonical比較・履歴serialization・資産回収の比重を分ける。

実際のボトルネックが確認された箇所だけ改善する。差分Undo、正規化DB、大域cache、全型自動生成を先行導入しない。検証を省略する場合も、同等の拒否条件をどこで保証するかと回帰ケースが必要。**性能保証や最適化完了は測定なしに記載しない。**

## 6. 機能を変更するときの対応表

[コード対応表の機能別入口](code-map.md#機能を変更するときの対応表)へ集約した。フォームと画像の現行境界も同文書を使う。

## 7. 検証コマンドと選び方

作業ディレクトリはリポジトリルート。まず環境を設定する。

```sh
source scripts/cloud-env.sh
pnpm check
pnpm test
```

各コード区切りで型チェックと単体、関連E2Eを実行する。完了済みの同一差分を理由なく繰り返さない。ブラウザ対象は開始時に存在するspecを確認し、進行中機能の追加分も含める。

| 区切り             | 関連E2Eファイル（すべて`e2e/`配下）                                                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2・R4a            | `image-placement.spec.ts`、`image-replacement.spec.ts`、`background-image.spec.ts`、`image-assets.spec.ts`、追加済みcrop関連                         |
| R3最初のShapePaint | `shape-paint.spec.ts`、`gradient-paint.spec.ts`、`pattern-paint.spec.ts`、`numeric-properties.spec.ts`、`inspector.spec.ts`                          |
| R3他のフォーム     | 移したフォームのspecに加え`range-input.spec.ts`、`tag-picker.spec.ts`、`save-state.spec.ts`、`selection-outline.spec.ts`、`selection-line.spec.ts`等 |
| R4b                | `clipboard.spec.ts`、`asset-clipboard.spec.ts`、`image-paste.spec.ts`、`save-state.spec.ts`                                                          |
| R4c                | `project.spec.ts`、`new-project.spec.ts`、`save-state.spec.ts`、`image-assets.spec.ts`、`preview-popups.spec.ts`、`preview-fullscreen.spec.ts`       |
| R4d                | `layer-folders-ui.spec.ts`、`layer-drag.spec.ts`、`folder-drag.spec.ts`、`selection-context.spec.ts`、`interaction-snapshot.spec.ts`                 |
| R4e                | `menubar.spec.ts`、`edit-toolbar.spec.ts`、`selection-context.spec.ts`、`standard-names.spec.ts`、`continuous-placement.spec.ts`                     |
| R5                 | `editor.spec.ts`、`history.spec.ts`、`multi-edit.spec.ts`、`edit-lock.spec.ts`、`visibility.spec.ts`、移したhandlerの機能spec                        |

例えばR3最初の区切りは次のように実行する。

```sh
pnpm e2e e2e/shape-paint.spec.ts e2e/gradient-paint.spec.ts e2e/pattern-paint.spec.ts e2e/numeric-properties.spec.ts e2e/inspector.spec.ts
```

R3・R4・R5の工程完了時には、本番ビルド・全E2E・CI所定のチェックを通す。進行中の別変更を含む場合は、その結果であることを記録する。

```sh
pnpm build
pnpm e2e
pnpm format:check
cargo fmt --all --check
cargo clippy --workspace --locked --all-targets -- -D warnings
cargo test --workspace --locked
```

CIの正確な追加チェックは[workflow](../.github/workflows/ci.yml)を参照する。自分の変更ファイルは`pnpm exec prettier --write <変更したファイル>`で整形し、他の作業中ファイルを一括整形しない。文書だけの区切りは対象Markdownの整形・差分・リンク／anchor確認でよい。

UIを移した区切りでは、両テーマ・1920×1080・1536×864の表示領域で、パネル／メニュー／入力欄の見え方を確認する。E2Eの件数だけを完了根拠にせず、I1〜I10の該当条件を満たしたか記録する。

## 8. 追加しない仕組みと判断規則

- ファイル行数を揃えるための分割や、全コンポーネントの一斉改名は行わない。機能の所有者と依存を明確にする。
- 汎用イベントバス、独自DI、万能form engine、別の認証・テーマ基盤は導入しない。既存のBantoとSvelteの仕組みを使う。
- Runtime設備操作をDesignerの入力確定に統合しない。EquipmentやFaceplateは整理後の契約へ別途接続する。
- 単体HTMLは操作試作として保存する。本体導入時は本体のモデル・入力保護・編集コマンド・共通描画へ接続し、試作内の簡易modelやUndoを製品の別経路にしない。
- 既存仕様と違う挙動を発見したら、再現条件と期待値を記録し、修正を機械的な移動から分ける。合格させるために拒否ケースや入力保護の期待値を削らない。
- 通常の抽出先名・小区切り・テスト選択はこの計画に沿って担当者が決めて進める。製品の振る舞い・保存契約・新規機能の採否が変わる判断は、リファクタ完了に紛れ込ませない。

<a id="refactoring-progress"></a>

## 9. 進捗・引継ぎの記録

| 工程            | 状態         | 完了コミット／検証                                                      |
| --------------- | ------------ | ----------------------------------------------------------------------- |
| 本書作成        | 文書化済み   | コードのリファクタは未着手                                              |
| R0 基準確認     | 基準確認済み | `e04e44c`、0.21.0、開始時clean。下記参照                                |
| R1 文書整理     | 完了         | 状況・履歴・利用者ガイド・コード対応表、旧リンクと文書状態を整理        |
| R2 テスト補助   | 完了         | 画像3specの準備を共通化。型・TS630件・関連ブラウザ33件・整形成功        |
| R3 フォーム契約 | 完了         | 各adapterへ解析・固有確定を移行。型・TS636件・関連56件・build／整形成功 |
| R4 App機能分離  | CI確認待ち   | R4a〜R4e実装・ローカル検証完了。全509ケースを確認、最終CI確認待ち       |
| R5 編集コマンド | 未着手       | 分類・handlerの網羅性、保存／履歴保持                                   |
| R6 性能         | 計測後に判断 | 計測条件・時間・メモリ・採否理由                                        |

各小区切りの記録は、次の項目だけを残せば再開できる。

```text
工程・小区切り:
基準HEAD / 保存したコミット:
変更した責務と移動先:
守った条件（I1〜I10）:
実行したチェック / 成功・失敗・未実行:
残っている既存処理 / 既知の問題:
次に読むファイル・着手する処理:
```

コミット単位はR3のフォーム1種類、R4のa〜e、R5の型分類とhandler群など、変更前後を説明できる大きさにする。差分を確認し、自分の区切りに属する変更だけを保存する。日本語Conventional Commitsの例: `refactor: 塗りフォームの入力解析を専用adapterへ分離する`。

### R0：画像機能保存後の基準（2026-10-20・日本時間）

基準HEADは`e04e44c`、Project0.21.0。開始時の作業ツリーはclean。画像機能の検証記録は[履歴](implementation-history.md#image-crop-progress)に保存した。同一差分のTS全630件・Rust30件・型チェック・ビルド・Clippy・整形成功を引き継ぐ。I1〜I10の振る舞いを構造整理で変更しない。

過去`871920b`のCI（run39308411288）は499件中495成功・4失敗。メニューは操作待機、回転は読込直後のdownload待機、左ツリーは検索時の展開、ホイールはプレビュー切替直後のfit寸法で失敗した。現行で4ファイルの関連29件を再実行して全成功し、上記失敗は再現していない。タイミング依存の可能性を残し、全508件の追加確認中。失敗を無関係な構造変更で隠さず、再現時は原因調査と修正を別区切りにする。

次はR1aの現在状況・履歴と移動リンク、R1bの利用者ガイド、R1cのコード対応表。Appやフォームの抽出はまだ行わない。

### R1a／R1b：現在情報・履歴・利用者ガイドの整理

R1aで`implementation-status.md`を現在仕様の要約とし、日付付き記録を`implementation-history.md`へ分離した。開発計画には今後の工程と旧リンクからの案内を残す。旧ファイルの明示anchor48個と見出し107個を維持し、リンク先の存在を確認した。機能基準は引き続き`e04e44c`で、アプリコードは変更していない。

R1bではREADMEの入口を起動・検証・状況／計画／ガイドへ整理し、詳細操作を`user-guide.md`へ移した。画像・入力保護・Symbol・viewport等の説明と、旧READMEの見出しからの移動案内を保持する。現在の保存版をREADMEへ重複記載しない。次はR1cのコード対応表と文書状態の識別を行う。

追跡: 後続`3b3031e`のCI（run39309595152）はブラウザ全499件に成功し、整形5ファイルだけで失敗した。整形は`edf0f3e`で修正済み。過去4件のブラウザ失敗はこのCIでも再現していない。cropを含む現行の全508件は別に確認中。

### R1c：責務対応表と設計文書の状態

責務と機能別の変更・検証表を`code-map.md`へ移し、本書§3／§6には案内だけを残した。crop・原本付きclipboard・フォームの現在境界を追記した。root設計文書の先頭で採用済み設計・提案・履歴を識別し、導入時の版を現在仕様と混同しない案内を加えた。上流スナップショットとアプリコードは変更していない。

R1完了。I9（保存内容不変）を維持した文書整理のみで、Markdown整形、リンク先・旧見出し・明示anchor、Git収録を確認する。次はR2の小さなテスト補助。コードの大規模移動は行わず、画像関連の準備・保存待機・主キャンバスを先に揃える。

R0の全体確認: `e04e44c`の[CI run39310221559](https://github.com/tyaro/temp-scada/actions/runs/39310221559)が全508ブラウザ・型・TS単体・ビルド・整形・Rust・CLI検証に成功した。アプリとテストを固定した同一コードの結果として扱う。追加のローカル全体検証はCI成功確認後にSIGINTで途中停止し、その中断を製品失敗や全件成功として数えない。過去4件は関連29件・後続499件・現行508件で再現していない。R2へ進む基準を確保した。

### R2：画像テストの準備と失敗診断

`e2e/helpers/images.ts`へ実ブラウザのPNG生成、`project-files.ts`へ成功読込・download／bytes、既存`designer.ts`へ主キャンバスrootを集約し、画像配置・差し替え・背景の3specから利用した。原本の色・寸法・透過、操作、期待値は保持する。成功読込は古い成功文言だけに依存せず、ファイル入力のクリアとenabled、確認が残っていないことも待つ。

I1・I5・I7・I10に関わる元の23件と、native画像／cropの10件、TS全630件、型チェック（エラー／警告なし）、対象整形が成功。App・Project・履歴・原本処理は変更していない。失敗／取消／遅延を試す手順は明示したまま。ブラウザ内package importはネイティブdecodeと原本復元の確認に残し、一般的なpackage契約は単体で検証する。

Playwrightの失敗trace・screenshotとCI用HTML report、workflowでの失敗成果物7日保持を設定した。設定を確認したもので、故意にCIを失敗させてuploadまで試験した記録ではない。timeout・retry・拒否条件は緩めていない。次はR3のShapePaintだけを対象に入力解析・対象照合をadapterへ移し、他フォームと汎用dirty台帳は維持する。

### R3a：ShapePaintの入力解析と対象照合

`4bd0914`を基準に、AppのShapePaint分岐を`designer/forms/shape-paint.ts`へ移した。adapterはFormDataの読取と世代・所有先・定義／画面・配置の照合からEditCommandを返し、Project・履歴・DOM・dirty台帳を変更しない。pattern／数値／角度／線種は既存helperを再利用する。固有の成功resetがないフォームなので、共通のacknowledgeFormとDraftGuardの確定を維持する。

I1〜I4・I6・I9を保持し、同値paintと任意の既定stroke属性を実体化しないこと、古い対象の拒否、不正フォームの原子的拒否を3件で確認した。TS全633件、型チェック（エラー／警告なし）、本番ビルド、対象整形、ShapePaint／gradient／pattern／数値／Inspectorの関連ブラウザ38件が成功。Appのmarkup・CSS、保存形式、Undo単位、他フォームの入力解析は変更していない。R3全体の完了ではない。

後続の文書だけの`3bffc53`のCI（run39311557328）でwheel-navigationのプレビューfit測定1件が再現した（507件成功）。プレビューの補助ペイン縮小に伴うResizeObserver前の寸法を採っている可能性を確認中。次のadapter移動より前に、レイアウト確定待ちを独立した区切りで確認する。

### CIタイミング修正：プレビューfitの基準採取

文書だけのCIで再現したwheel-navigation 1件は、プレビューでInspectorが隠れてviewport幅が増えた後、AppのResizeObserverが新寸法を反映する前のfitを基準としていた。プロダクトのズーム処理は変更せず、テスト側の`settleCanvasLayout`でviewportのResizeObserver通知と後続描画フレームを待ってから基準を採る。

wheel関連7件と問題ケース20回の反復が成功。20回を別の機能ケース数として数えない。Ctrl-wheelが消費されないことと、確定済みfitが厳密に不変であることの期待値は維持した。fixed sleep、retry、許容誤差、アプリのテスト専用APIは追加していない。次は予定していたR3のSelectionOutlineへ戻る。

### R3b：SelectionOutlineの解析・適用後の確定

`e93c0e3`を基準に、枠線一括フォームの解析と固有のpatch欄resetを`forms/selection-outline.ts`へ移した。世代・所有先・定義／画面・選択IDsの照合は`selection-target.ts`へ分離し、移行済みフォームだけが使う。Appはフォームkindと型付きの対象情報を渡し、固有の入力名を解釈しない。

I1〜I4・I6・I9を維持。空欄の未指定、空patch全体の拒否、全対象への明示作成と同値再適用、不正／矛盾patch・古い選択の原子的拒否を確認した。TS全636件、型チェック（エラー／警告なし）、ビルド、対象整形と関連ブラウザ35件が成功。数値・タグ・保存・別フォームの候補事前検証、ロック・非表示・共有定義・IMEも既存の期待値で成功した。

固有欄のreset後に共通DraftGuardへ確定する順序、全dirtyフォームの検証とフォームごとのUndoは変更しない。SelectionLine／SelectionColor、Symbol配色、背景・crop、通常Object／Screen／Project等は未移行。Astraの読取レビューにより、後続も同じfactory委譲を採用する。callback登録の追加はteardown・古いclosure・数値確定順の変更範囲を広げるため今回に含めない。R3本文とcode-mapをこの境界へ合わせた。

### R3c：SelectionLineの解析・適用後の確定

`f07c808`を基準に、線種一括フォームの入力解析と固有resetを`forms/selection-line.ts`へ移した。対象照合は既存の`selection-target.ts`を再利用する。Appはkindで委譲し、現在の世代・所有先・定義／画面・選択IDsを供給する。

I1〜I4・I6・I9を維持。空欄は変更なし、矢印の列挙値と数値・線種の解析、固有欄resetから共通draft確定への順序は移動前と同じ。全体事前検証、数値確定、共有定義への適用、Undo単位、保存形式、markup・CSSは変更しない。SelectionColor以降は未移行。

TS全636件、型チェック（エラー／警告なし）、本番ビルド、対象整形と線種・数値・タグ・保存の関連ブラウザ25件が成功。既存のJS bundle 500kB警告は継続する。次はSelectionColorの解析と成功後resetを同じ境界へ移す。

### R3d：SelectionColorの解析・適用後の確定

`9080b94`を基準に、一括色変更の入力解析と固有resetを`forms/selection-color.ts`へ移した。対象照合は`selection-target.ts`を再利用し、Appは現在対象の供給と共通処理だけを担当する。

I1〜I4・I6・I9を維持。定義色Symbolの単色化は既存の明示checkboxに従い、色と変換指定は成功後だけresetする。空欄・不正色の拒否、候補全体の事前検証、非表示／ロックと共有定義、Undo単位、保存形式、markup・CSSは変更しない。次はSymbolColorModeを移す。

TS全636件、型チェック（エラー／警告なし）、本番ビルド、対象整形、一括色・Symbol配色・数値・タグ・保存の関連ブラウザ34件が成功した。

### R3e〜g：Symbol配色・背景画像・画像cropの解析

`ad65b4a`を基準に、SymbolColorMode、背景画像、画像cropの3フォームをそれぞれ`forms/symbol-color-mode.ts`、`background-image.ts`、`image-crop.ts`へ移した。Appはkindの振分けと現在対象の型付き情報の供給を残し、cropの資産探索は読取専用の資産metadata一覧を渡す。原本bytesとAssetStoreは渡さない。

I1〜I4・I6・I9を維持。各フォームに既存の世代・所有先・定義／画面の拒否条件を移し、cropは配置とassetも照合する。配色モードの列挙値、背景opacityの百分率、cropの数値・正規化helper、固有resetなしの共通確定は維持する。画像の非同期要求・lease・crop epoch、候補検証・Undo単位・保存形式、markup・CSSは変更しない。通常Object／Screen／Project・移動は未移行。

TS全636件、型チェック（エラー／警告なし）、本番ビルド、対象整形、Symbol配色・背景・crop・差し替え・数値・タグ・保存の関連ブラウザ54件が成功した。

### R3h：通常配置・画面・Project・移動の解析

`3f20545`を基準に、通常配置・画面／共有定義・Project名・選択移動を`forms/object-form.ts`、`screen-form.ts`、`project-form.ts`、`move-form.ts`へ移した。配置名とProject名の成功後確定も各adapterへ移し、Appは編集後モデルの現在名を供給する。

I1〜I4・I6・I9を維持。入力のNumber／厳密数値parserの使い分け、Text書式とbinding・Symbol／View参照・polyline頂点、定義編集時の分岐を変更しない。対象guardや数値規則を追加する工程ではない。通常数値の`commitNumber`と`acceptField`、フォームのDOM保持、共通の候補全体検証・submit順序・履歴所有は既存のまま。Appのフォーム解析・固有resetから入力名の列挙を除いた。

TS全636件、型チェック（エラー／警告なし）、本番ビルド、全体整形と通常数値・Inspector・文字書式・Project／画面／共有定義・保存・タグ・範囲選択の関連ブラウザ56件が成功した。

R3完了。既存フォームの項目解析と固有確定は各adapterへ閉じ、Appにはkind・現在対象の供給と共通の適用経路を残した。新しいcallback登録やdirty台帳は作らず、markup・CSS・保存JSON・Undo単位を維持した。途中の`f07c808`も[全体CI](https://github.com/tyaro/temp-scada/actions/runs/39314185119)が成功している。今回の最終差分の全体CIとは区別する。次はR4aで画像取込の取消条件を一覧にしてからcontrollerへ移し、Projectと履歴の所有はAppへ残す。

### R4a：画像取込の要求・取消・仮Store

基準は`484f794`、開始時clean。画像配置・差し替え・背景・画像pasteで共通だった`prepareImage`、chooser intent、busy、要求番号、3つのscope effectを`designer/controllers/image-import.svelte.ts`へ移す。背景削除も同じ機能にまとめた。Appにはfile inputのDOM、Project／履歴／workspaceGeneration／共有AssetStoreの所有と参照回収、現在状態のgetter、共通edit／transition／draft・通知・reveal接続を残す。

取消条件を移動前コードと照合した。3つのepochは統合せず、同じprimitive文字列の`$derived`とeffectの`untrack`を保つ。

| 要求／境界           | 維持する条件と時点                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 共通owner            | Project世代・画面・edit／preview・定義有無・busy・Project置換の変化でread要求を無効化し、配置chooser intentとbusyを解除    |
| 配置chooser          | 開いた時のowner・世代とviewport／画面寸法をコピー。change時にintentを消費し、transition後もowner・mode・busy・置換を再照合 |
| 差し替えchooser      | 選択IDs・shape型・元asset・lock・visibleとownerのscopeでepoch更新しintent解除。change前にcrop epochも照合                  |
| 差し替えdecode       | 未適用cropを承認して適用した後のcrop epochを再取得。decode中のcrop変更と戻しも無効化。配置geometryだけの変更は取り消さない |
| decode完了／適用直前 | 最新read番号とownerを再確認。差し替え時は選択配置・元asset・lockと専用epochも照合                                          |
| 成功時               | 最新共有Storeへimportし、同一hash assetと背景fit／opacityは適用時点で読む。edit後に仮Storeをdisposeして参照回収            |
| 未適用入力の確認     | 保留callbackが仮Storeを保持する。外側finallyで一律disposeしない。古いreadのfinallyで新しいbusyを解除しない                 |
| 配置後の表示         | edit成功時だけ配置ツールを止め、tick後にcurrentと選択IDsを確認してreveal                                                   |

I1〜I4・I6〜I10を維持する構造整理。Astraの読取レビューでgetterの読取時点、同期chooser、3つのscope、保留candidateの寿命、crop再取得とrevealを確認した。effect宣言の集約だけで同値を保証せず、関連ブラウザでProject切替・離れて戻る・連続要求・crop適用前後を確認する。取消条件の強化、原本管理改善、schema変更は混ぜない。

R4a完了。型チェック（エラー／警告なし）、TS全636件、本番ビルド、対象整形と既存の画像6spec48件が成功した。native画像原本の1件と、decode待ち中の座標変更を維持して差し替えと別Undoで戻せる追加1件も成功し、計50件。新規1件はgetterによってgeometryまで取消依存へ広げていないことを確認する。期待値・timeout・retryは緩めていない。Astraの実差分レビューでも修正要求なし。

共有Project・履歴・原本Storeの所有と保存契約は維持した。画面配置・画像の見え方は変更しない。既存のJS bundle 500kB警告は継続。次はR4bでclipboardの同期取得／write開始とsnapshot・lease・取消条件を一覧にしてから移す。

### R4b：クリップボード要求・snapshot・原本lease

基準は`102c0bf`、開始時clean。`clipboardAction`、session ID、busy、owner epoch／scope effect、連続pasteのoffset記録を`designer/controllers/clipboard.svelte.ts`へ移した。Appにはnativeイベント受付、入力欄・menu・dialog等の除外、非表示canvas変更判定、Project／履歴／原本Storeの所有と共通edit／draft接続を残す。controllerはcopy snapshotと事前model検証のため現在Projectの読取getterを受けるが、Projectの別コピーや履歴を所有しない。

| 境界             | 維持する取得・確認・解放の順序                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| native paste     | event中にtext／filesからpayloadを同期取得。draft確認の後へDataTransferの読取を遅らせない                                     |
| native copy／cut | 同期経路では`setData`をevent内で実行。draft確認が保留ならnative参照をnullにしてイベント後の再利用を避ける                    |
| 画像copy／cut    | 同期でcopy snapshot→予算検証→encode開始・原本pin→Promise付きClipboardItemのwrite開始。最初のawaitを前へ追加しない            |
| cut事前検証      | OSへ書く前にremove commandを候補モデルで検証。実Project／履歴は変更しない                                                    |
| owner取消        | Project世代・画面・mode・定義ID・busy・置換の同じprimitive文字列でepoch更新。離れて戻っても旧要求を復活させない              |
| 非同期paste      | 読取後と原本decode後にowner／revision／dirty／pendingを再確認。画像payloadはR4aのprepareへ同じviewportとawaitで接続          |
| paste配置        | 開始時のviewportとcenterを保持し、連続pasteのkeyには元と同じ適用時scaleを使う。成功時だけoffset記録更新・配置ツール終了      |
| cut完了          | write成功後にowner／revision／dirty／pending／選択IDsを再照合。不一致ならコピーだけとして元配置を残す                        |
| 原本解放         | encodeは既存helperのfinallyでlease解放。paste candidateは成功・拒否ともfinallyでdispose→参照回収。OS失敗で切取元を削除しない |

I1〜I10を維持する構造整理。API対応・許可拒否の案内、予算、保存形式、Undo単位を変更しない。busyはgetterで公開し、Appで値だけ分割取得しない。Astraの実差分の読取レビューでは、同期取得／write開始・native参照解除・cut再確認・candidate解放・App接続の移動漏れに修正要求なし。

R4b完了。型チェック（エラー／警告なし）、TS全636件、本番ビルド、対象整形、clipboard・原本付きclipboard・画像paste・保存入力保護の関連ブラウザ32件が成功した。失敗時の切取元保持、非同期write中の選択／編集変更、定義の最終子削除拒否、画像の遅延応答、draft確認前のpayload取得を既存の期待値で確認した。移動そのものを写すテストは追加せず、timeout・retry・拒否条件は緩めていない。

保存契約・画面配置・Undo単位は維持し、既存のJS bundle 500kB警告は継続。R3最終`484f794`の[全体CI](https://github.com/tyaro/temp-scada/actions/runs/39316570142)も成功した。今回のR4bローカル検証とは区別する。次はR4cでProject読込候補・置換要求・書出しsnapshot・busy／保存状態の境界を一覧にし、Project採用と編集状態の一括初期化はAppへ残す。

### R4c：Projectファイル・置換候補・保存基準

基準は`d5fbf0f`、開始時clean。読込request／busy、置換候補、保存baseline／source／lastExport、書出しsnapshotとexportingを`designer/controllers/project-files.svelte.ts`へ移した。AppにはProject・履歴・共有AssetStoreの所有と`adopt`、編集画面の一括初期化、file inputのDOM接続、ネイティブの離脱確認を残す。Appで使うbusy・置換候補・保存表示はcontroller getterへ`$derived`で追従する。

| 境界             | 維持する条件と処理順                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| chooser／新規    | busy・draft確認中・置換確認中は開始しない。chooser clickは同期。入力なし／未接続inputなら読込を開始しない                         |
| 読込             | File・Project世代・単調増加requestを捕捉しbusyを立てる。parse／原本検証後に最新request・同一世代・input接続を再確認               |
| 古い読込／失敗   | 古い成功候補Storeをdisposeし、古い失敗は通知しない。最新requestだけbusy解除。接続中のinputだけ元と同じfinallyでクリア             |
| 置換候補         | 不正ファイルはdraftへ触れる前に拒否。世代不一致は候補Storeを破棄。draft確認後、未保存の内容があれば置換確認へ進む                 |
| 採用             | AppでStore交換→旧Store破棄→Project代入→`adopted`で保存基準確定→履歴・画面状態初期化→世代更新→通知。旧baseline更新の位置を変えない |
| 置換確定／取消   | 候補参照を外してからApp採用へ渡す。取消は候補Storeをdispose。書出しだけで自動採用しない                                           |
| 書出し開始       | 同時exportを拒否し、開始時のProject／世代／Storeと名前を捕捉。JSON／原本付きpackageの既存writerを使用                             |
| ダウンロード要求 | object URLを作成してlink click。1秒後revokeも既存のまま。要求成功と保存先での実ファイル確認を区別                                 |
| 保存基準         | 成功時、同一世代なら書出しsnapshotをbaselineにする。書出し開始後の編集は未保存として残し、別Projectへ旧baselineを適用しない       |
| 書出し失敗       | baselineを変更せず名前付きエラーを通知。finallyでexportingと表示名を解除                                                          |

I1〜I10を維持する構造整理。read targetはinputの接続getterとclear callbackだけを受け取り、controllerはDOM描画や入力の再生成を所有しない。Astraの実差分レビューで、候補の寿命・busy・input接続・write snapshot・世代照合・baseline通知順に修正要求なし。候補破棄や保存形式の改善を同時には行わない。

R4c完了。型チェック（エラー／警告なし）、TS全636件、本番ビルド、対象整形とProject・新規・保存入力保護・native画像・小窓・全画面・背景・clipboardの関連ブラウザ48件が成功した。古い読込より新しい要求が優先されること、原本付き書出し中の後続編集が未保存として残ること、失敗時の現在Project保持、Project置換時の小窓／全画面終了を確認した。

保存形式・採用順序・Undo単位は維持し、既存のJS bundle 500kB警告は継続する。次はR4dのレイヤー分離。先に一覧markupと所有CSSを`LayerTree.svelte`へ移し、Appの状態・編集接続を維持した表示の区切りで検証する。その後に検索・展開・drag・folder dialogの状態を移し、R4d全体の完了と区別する。

### R4d-1：レイヤー一覧のmarkupと所有CSS

基準は`d68aad6`、開始時clean。レイヤー一覧・検索欄・drag guide・folder／object行のmarkupと所有CSSを`designer/LayerTree.svelte`へ移した。Appは検索・展開・drag・folder dialogの状態と処理、共通選択／編集・context menu接続を維持し、feature単位のgetter／既存callbackを`LayerTreeBindings`として供給する。この一時的な表示接続を汎用state busに広げない。状態移動は次の小区切りで、R4d全体の完了ではない。

I1〜I10を維持。DOM構造・aria／data属性・イベントの同期処理・query／openの更新順は元のまま。drag actionも同じrootへ置き、hoverの2状態更新を1callbackへまとめただけ。共有していたscreen-row／layer-entry CSS selectorは両所有先へ分割し、既存button・p等の基礎規則も一覧へ必要な分だけ同じ相対順で移す。Appに残る画面一覧の規則は維持する。

移動前後で既存の実画面撮影手順を使い、両テーマ・1920×1080／1536×864のProject／layer各画面、計8枚がpixel完全一致した。比較画像は`/tmp/scada-r4d-before`と`after`の作業用成果物で、製品の差分や新しいデザイン画像を追加するものではない。型チェックはエラー／警告なし。検索・展開・drag・folder dialogの状態はまだAppにある。

R4d-1の表示分離を完了。TS全636件、本番ビルド、対象整形、レイヤーフォルダー・配置／フォルダーdrag・context・操作snapshot・sidebar・表示／ロックの関連ブラウザ78件が成功した。AstraのUX読取レビューでもDOM・イベント引数・focus復帰・getter・CSS・接続の限定範囲に修正要求なし。画面比較8枚の完全一致と合わせて保存する。次のR4d-2では状態とfolder dialog／menu接続をcontrollerへ移す。

### R4d-2：レイヤー検索・展開・drag・folder状態

基準は`1bf30d7`、開始時clean。query／open・世代／画面別の閉フォルダー記録・検索投影・選択祖先の展開、drag token／guide／target／クリック抑止、folderRequest／menu参照／originと非同期focus復帰を`designer/controllers/layer-tree.svelte.ts`へ移した。表示部品の`LayerTreeBindings`へcontrollerを直接渡し、Appに置いた一時的なview facadeは取り除いた。

| 境界         | 維持する状態と時点                                                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 検索・展開   | scopeは世代＋画面ID。検索中は結果を一時展開し、検索条件外の選択は維持。祖先展開のkeyとuntrackを保つ                                           |
| drag解除     | 元のscope・mode・activePanel・sidebar表示だけを追跡。広い編集可否getterで取消範囲を増やさないよう、表示条件のgetterを分ける                   |
| source／drop | token・source snapshot・scope・lock／hidden判定と300msクリック抑止を維持。native dragendより前にsnapshotを保持し、draft確認後も元対象を再検証 |
| folder操作   | requestのkind・IDs・scope・originを捕捉し、menuのrequest番号・scope・mode・blocking・対象存在をtick後に確認                                   |
| 適用・focus  | 既存editのerror callbackへ接続し、成功後だけ祖先展開・close。close後は同一scopeで接続中・表示中のoriginへ戻し、なければ作成buttonへ戻す       |
| 初期化       | AppのProject採用時、元のquery／open初期化位置で`resetPresentation`を呼ぶ。Project／選択／履歴と表示・lockの共通操作はApp所有                  |

FolderDialogとContextActionsのroot配置はAppに残し、controllerのrequest／menu handleを接続する。元がplain letのfolderOriginはAppの`$derived`へキャッシュせず、操作時にgetterを直接読む。ownerのmode等をguardとdrag解除で混同しない。原本やProjectコピー、別のdirty／履歴台帳を持たせない。

I1〜I10を維持。型チェックはエラー／警告なし、TS全636件が成功し、両テーマ・2画面幅の比較8枚も移動前とpixel完全一致した。Astraの実差分レビューではdrag取消依存・snapshot／token・origin／focus・edit error接続・初期化位置に修正要求なし。状態移動後の関連ブラウザ78件も成功した。

R4d完了。状態分離後の型チェック（エラー／警告なし）、TS全636件、本番ビルド、対象整形と関連ブラウザ78件が成功した。表示分離の78件と同じ関連ケースを再確認したもので、156件の異なる機能検証として合算しない。最終状態でも移動前との画面比較8枚はpixel完全一致。検索・祖先展開・drag・folder dialog／menuのstate／effectはcontrollerへまとまり、Appは現在情報・選択・共通編集・rootでのUI接続を所有する。

保存形式・Undo単位・既存の操作条件を維持した。既存のJS bundle 500kB警告は継続。次はR4eでメニュー・toolbar・contextの共通action定義を整理し、イベント受付と現在contextの供給はAppへ残す。R4eとR5は未着手。

<a id="r4e-actions"></a>

### R4e：メニュー・toolbar・contextの共通action定義

基準は`7166eab`。`designer/controllers/designer-actions.ts`へfolder context・編集toolbar・clipboard・selection context・6分類メニューの定義を移した。状態やeffectを持たないbuilderとし、Appの`$derived`から現在情報のgetterと既存callbackを供給する。AppはDOMイベント受付、Project／履歴／draftと共通editを維持する。

| 不変条件               | 維持した接続                                                       |
| ---------------------- | ------------------------------------------------------------------ |
| disabled・動的ラベル   | 生成時に現在getterを読み、既存条件を変更しない                     |
| 操作対象・座標・origin | run callback内で現在getterを読み、作成時の選択を固定しない         |
| toolbar・menu・context | 同じ編集group／clipboard項目を参照する                             |
| chooser・clipboard     | 同期で既存controllerを呼び、新しいawaitを追加しない                |
| 入力保護・Undo・保存   | 既存callbackと共通edit／transitionへ戻し、状態の所有者を増やさない |

Astraの静的レビューでは具体的な回帰懸念・修正要求なし。型チェックはエラー／警告なし、TS全636件成功。R4全体の完了判定として全ブラウザ509件を実行した。保存形式・画面配置・操作仕様の変更は含めない。

既存の開発サーバーを使った最初の実行は、編集中のコンパイルエラーoverlayが残ったケースと時間切れを確認して途中停止した（32件成功、2件失敗、2件中断、473件未実行）。その結果を全体成功とは扱わず、専用サーバーを起動して最初から確認した。専用サーバー・4並列では496件成功、13件失敗（テスト全体の時間切れ12件、自動スクロールの到達位置1件）。失敗記録を保存し、同じコード・判定条件のまま13件を1並列で再確認して全件成功した（1.6分）。全体実行が一度で成功したとは記載しない。対象の全509ケースの成功を組み合わせて確認したが、4並列時の失敗が再現しない理由までは断定しない。型チェック・TS全636件・Rust全30件・Clippy・Rust整形・CLIサンプル3件も成功。

本番ビルド・リポジトリ全体の整形確認も成功。既存のJS bundle 500kB警告は継続する。R4a〜R4eの実装とローカル検証を完了した。Appのmarkup／CSSはR4eで変更せず、Project形式・採用順序・Undo単位も維持した。R4dまでの全体CI（`7166eab`）は成功。R4e差分の最終CIはPush後に確認する。次はR5aのコマンド型の移動と全41種類の分類を型で照合する工程へ進む。handler分割とR5全体の完了とは分けて保存する。
