# Bantoへの還元候補と採用境界

2026-10-21確認。状態: **候補整理・公開ソース照合済み。追加起票・上流への追補・依存更新は未実施**。

SCADAの局所実装をそのまま移すのではなく、Bantoの既存APIに不足する契約と、再利用できる受入テストを渡す。[起票時の引渡し記録](banto-contribution-handoff.md)とは区別する。

## 比較基準

- SCADA: `2abc53f`（アプリ実装の直近変更は`01d5df0`）。固定依存は引き続きBanto v6.7.0。
- Banto main: [`ac571ebffa76db61e28230a7138223f069eee067`](https://github.com/tyaro/banto/tree/ac571ebffa76db61e28230a7138223f069eee067)。以下の公開API照合はこの版に限る。
- 起票済みの[#432〜#438](banto-contribution-handoff.md#関連する起票済み事項)はすべてClosed。[PR #447](https://github.com/tyaro/banto/pull/447)のdraft基盤、[PR #453](https://github.com/tyaro/banto/pull/453)の画像Storeはmerge済み。IssueのClosedと、SCADAでの採用・受入完了は別である。

## 優先順位

| 優先 | 候補                               | 渡すもの                                                       | 次の判断                                        |
| ---- | ---------------------------------- | -------------------------------------------------------------- | ----------------------------------------------- |
| 高   | 複数フォームの適用前検証           | 後続フォームがIME変換中なら先行フォームも適用しない回帰ケース  | #432の追加要件としてpreflight契約を相談         |
| 高   | 画像の原本・URL・pinのブラウザ回帰 | Redo破棄、履歴上限、同一package再読込、原本bytesの受入条件     | #438の既存試験と照合し、足りないケースだけ抽出  |
| 中   | 既存TreeViewへの追加要件           | 明示確定、行内操作、ドラッグ事前判定・失効の受入ケース         | 小さいconsumer fixtureで現APIとの差を確定       |
| 中   | 編集性能の診断手順                 | 実キー入力計測、CPU source map、交互比較、見送り候補の記録方法 | Bantoの開発者向けrecipeとして適否を確認         |
| 継続 | dock・操作定義・request・設定保存  | 起票済み資産と10ケースの再現fixture                            | 新設Issueを重ねず、上流公開APIのSCADA受入へ進む |

高優先も即座のAPI追加を意味しない。上流の最新試験を照合し、既存機能で満たせるものは採用側adapterで対応する。

## 1. 複数フォームの適用前検証

現行Bantoの[`DraftSource` / `DraftCoordinator`](https://github.com/tyaro/banto/blob/ac571ebffa76db61e28230a7138223f069eee067/packages/forms/src/draftCoordinator.svelte.ts)は、各`apply()`を開始してから結果を待つ。あるフォームが失敗しても、成功したフォームは適用済みになる契約であり、不具合として扱わない。公開`DraftSource`には独立したpreflightはない。

SCADAで確認した要件は、**適用を始める前に、全対象フォームの入力・IME状態・所有者を確認すること**。前の名前入力がdirty、後の接続入力が変換中というケースで、前だけがProjectへ反映されないようにする。

- 提案範囲: 任意の事前検証hook、全対象の検証後に適用を開始する手順、検証中に入力・登録・対象が変わった場合の失効。具体的API名と同期／非同期契約は未決。
- 対象外: 外部API副作用のrollback、全consumerの分散transaction。Project commandの候補生成・一括UndoはSCADAの責務。
- 受入候補: 後続IMEで全適用開始を拒否し入力を保持、変換終了後に再実行、検証後の入力変更・登録差替えを見逃さない。既存の部分成功契約は維持するか、明示的な別modeにする。
- 出典: [`eef69fd`の回帰テスト](https://github.com/tyaro/temp-scada/blob/eef69fd0748a3b3254731e11188f6ed8dd616be6/e2e/connection-settings.spec.ts)、[`line-connection`の入力検証](https://github.com/tyaro/temp-scada/blob/eef69fd0748a3b3254731e11188f6ed8dd616be6/apps/banto-scada/src/lib/designer/forms/line-connection.ts)。テスト名は「Apply-and-continue rejects all dirty forms before mutation while a connection is composing」。

## 2. 画像資源のブラウザ受入

Bantoには原本hashによるStore、`acquireUrl()`の借用／release、pin、collectがある。Storeを再新設する提案ではない。

SCADAで増えた資産は、実ブラウザで原本の保持と解放を確認するシナリオである。上流の現行試験に同等ケースがあるかを先に調べる。

| シナリオ             | Bantoへ抽出できる契約                         | SCADAに残す設定                   |
| -------------------- | --------------------------------------------- | --------------------------------- |
| Undo後のRedo破棄     | 保持集合から外れ、借用・pinもない原本だけ解放 | Undo stack、編集command           |
| 50履歴境界           | retain集合の変更とURL／原本の解放             | 履歴数50、snapshot形式            |
| 同一package再読込    | 別Storeへの切替と旧資源の最終release          | package読込・Project差替え        |
| 保存中・非同期操作中 | pin中の原本保持、release後の回収              | ZIP出力・clipboard・cutの成功判定 |
| PNG／JPEG・透過      | 実decode、原本bytes・alphaの保持              | crop・背景・図面表示              |

Bantoは最後のURL借用をreleaseするとrevokeする。SCADAの既存URL参照方式とは異なるため、dispose直後の一律revokeを要求せず、**借用とpinがある間は保持、最終解放後に回収**へ試験を変換する。

出典（実装`01d5df0`固定）:

- [Redo破棄と50履歴上限](https://github.com/tyaro/temp-scada/blob/01d5df015058ae7cd38cf8b68529ac1b71d39044/e2e/image-replacement.spec.ts)
- [幾何編集と同一package再読込](https://github.com/tyaro/temp-scada/blob/01d5df015058ae7cd38cf8b68529ac1b71d39044/e2e/symbol-image.spec.ts)
- [実ブラウザの画像受入](https://github.com/tyaro/temp-scada/blob/01d5df015058ae7cd38cf8b68529ac1b71d39044/e2e/image-assets.spec.ts)
- [Storeのpin／非同期寿命の単体試験](https://github.com/tyaro/temp-scada/blob/01d5df015058ae7cd38cf8b68529ac1b71d39044/apps/banto-scada/src/lib/image-assets.test.ts)

## 3. TreeViewは既存部品への差分還元

現在のSCADAは独自実装である。プロジェクトは`App.svelte`と`TreeSection.svelte`、レイヤーは`LayerTree.svelte`とcontroller、タグ選択は`TagPicker.svelte`が担う。`TreeSection`自体はdetails／summaryの部品であり、汎用ARIA TreeViewではない。

一方、Banto mainにはすでに[`@banto/tree-svelte`](https://github.com/tyaro/banto/blob/ac571ebffa76db61e28230a7138223f069eee067/packages/tree-svelte/README.md)がある。展開、単一／複数選択、三状態checkbox、遅延読込、キー操作、ドラッグ、名前変更、tree-grid、TreeSelectを重ねて新設しない。

| SCADAの要件                                           | 確認した既存APIとの差                                                                                    | 還元／採用方針                                                          |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| タグをクリックで詳細確認、Enter／ダブルクリックで確定 | `BantoTree`は`onSelectionChange`と`onActivate`を分離済み。`TreeSelect`単一選択は選択変更時に確定・閉じる | まず`BantoTree`を候補にする。TreeSelect拡張を必須にしない               |
| 型別アイコン・可視／lockボタン・件数・右クリック      | 公開Propsに行snippetや行内action／context hookは見当たらない                                             | 汎用行描画・action slotの追加候補。設備iconや操作内容はconsumer         |
| 検索と祖先表示、検索解除後の展開復元                  | 公開Propsにfilter／searchはない。入力nodesの参照変更は内部copyをresetする                                | 外部filterで選択・展開・focusが保てるかfixtureで確認してから不足を提案  |
| lock／group制約に沿うdrop可否表示                     | `onMove`で最終変更をconsumerへ委譲できるが、事前判定は内部`canDrop`。公開のconsumer判定hookはない        | `before`／`after`／`inside`の可否をconsumerへ問い合わせる拡張候補       |
| IME・対象切替中の誤確定を防ぐ                         | 確認したtreeのkeydown入口に`isComposing` guardはない                                                     | composition中のEnter／矢印と行内入力を最小fixtureで再現してから回帰提案 |

受入では、選択とfocusと確定を分けること、行内ボタンが行選択・dragを誤発火しないこと、キャンセル／対象切替後にdragが実行されないことを確認する。行数・描画費用の計測前に仮想化を必須要件にはしない。

SCADAのsourceとテスト（`01d5df0`固定）:

- [タグ選択UI](https://github.com/tyaro/temp-scada/blob/01d5df015058ae7cd38cf8b68529ac1b71d39044/apps/banto-scada/src/lib/designer/TagPicker.svelte)と[ブラウザ試験](https://github.com/tyaro/temp-scada/blob/01d5df015058ae7cd38cf8b68529ac1b71d39044/e2e/tag-picker.spec.ts)
- [drag sessionの検証](https://github.com/tyaro/temp-scada/blob/01d5df015058ae7cd38cf8b68529ac1b71d39044/apps/banto-scada/src/lib/designer/layer-drag.test.ts)と[dragのブラウザ試験](https://github.com/tyaro/temp-scada/blob/01d5df015058ae7cd38cf8b68529ac1b71d39044/e2e/layer-drag.spec.ts)
- [プロジェクト階層の受入](https://github.com/tyaro/temp-scada/blob/01d5df015058ae7cd38cf8b68529ac1b71d39044/e2e/sidebar-tree.spec.ts)、[フォルダ移動の受入](https://github.com/tyaro/temp-scada/blob/01d5df015058ae7cd38cf8b68529ac1b71d39044/e2e/folder-drag.spec.ts)

レイヤーの複数配置・group展開、循環／lock判定、表示順snapshot、Undo command、Project／catalog revisionはSCADAに残す。既存のHTML Drag and Drop用token方式と上流のpointer方式は異なるため、実装の直接移植ではなく失効・取消の契約を抽出する。

## 4. 性能診断の手順

[混在図面の品質計測](../performance/mixed-editor-quality.md)から、CPU profileのsource map解決、実キー入力→DOM反映→2回のrequestAnimationFrame、A/B/B/Aの交互比較、採用しなかったpatchと計測条件の保存を開発者向けrecipeとして渡せる。

資産は`apps/banto-scada/scripts/`の`profile-editor.mjs`、`summarize-editor-profile.mjs`、`compare-editor-load.mjs`、`benchmark-mixed-editor.mjs`。selector・fixture・Project整合検査はSCADA固有のため、再利用時はadapterへ分ける。source-map解析に使う依存も抽出先で明示する。

計測のinclusive時間は重なりを含み、2回のrAFは実ディスプレイ表示完了を保証しない。I5gは50履歴で改善したが、短履歴・再読込は悪化した比較もある。Bantoの性能欠陥や全操作の改善を示す資料として渡さない。

## SCADA／Industrialに残すもの

- Project保存形式・参照整合性・command／Undo／Redoと履歴資産索引（`history-assets.ts`）。
- 設備・Symbol・接続anchor・配管・型付きtagの意味、runtimeへの投影。
- Hub／catalog接続・認証・正式Faceplate。Industrialの契約再確認後に進める。
- 図面固有の性能fixtureと採否判断。一般的な大域cacheや検証省略を共通化案にしない。

## 次の区切りと完了条件

1. 高優先2件の上流試験を照合し、再現fixtureと期待結果を最小化する。
2. 既存Issueの追補か新規Issueかを決め、固定sourceリンク・上流版・責務境界・受入条件を添えて渡す。ClosedのIssueを再開済みとは扱わない。
3. TreeViewはプロジェクト／タグ選択／レイヤーを別consumerとして試作評価する。1種類の採用を全ツリーの移行完了にしない。
4. 上流変更の公開API確定後、SCADAの固定依存を更新し、入力保護・資源寿命・キー／drag回帰を通してから重複実装を外す。

この整理はアプリ変更・上流採用・共通化完了の記録ではない。今回の検証範囲は公開ソース、参照ファイル、文書整形・リンクである。
