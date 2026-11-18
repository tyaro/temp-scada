# SCADAからBantoへの共通機能引渡し

2026-10-22（日本時間）更新、2026-11-18に棚卸しを追記。状態: **起票・当初資産の引渡し済み。上流は#432〜#438をBanto v6.8.0で公開済み。SCADAへの採用は未着手**（[2026-11-18の棚卸し](#2026-11-18の棚卸し上流の版とscadaの採用状況)）。既存の[パネル基盤比較](banto-dock-comparison.md)に加え、汎用化の候補と受入資産を記録する。

## 現在の確認状態

Banto main `ac571ebffa76db61e28230a7138223f069eee067`で再確認し、#432〜#438はすべてClosed。[PR #447](https://github.com/tyaro/banto/pull/447)のdraft基盤と[PR #453](https://github.com/tyaro/banto/pull/453)の画像Storeはmerge済み。SCADAのadmin-core／theme／uiはv6.9.0（`1bd12fe023cf3958dbdde923e1bdd4fdb28a9139`）へ固定依存更新済み。Menuの上流#427／#430修正を受け入れ、局所adapterをPR #9で撤去した。その他の共通APIへの接続・受入は未完了。

## 2026-11-18の棚卸し：上流の版とSCADAの採用状況

Banto v7.5.0のCHANGELOGで照合した。#432〜#438の公開APIはすべて**v6.8.0**で入った（計画書PR-1〜PR-14）。SCADAの固定依存はv7.2.0（#238）なので、`@banto/admin-core`・`@banto/ui`のAPIは依存を変えずに使える。`@banto/forms`・`@banto/dock-svelte`・`@banto/image-assets`はSCADAの依存に無い。SCADAのコード（`apps/banto-scada/src`）は下の上流APIを1つもimportしていない（2026-11-18にgrepで確認）。手元の対応先は名前と責務からの候補で、差分の照合はまだしていない。

| Issue                                                                        | 上流の公開API（v6.8.0）                                                | パッケージ（SCADAの依存）                    | SCADAの手元の対応先（候補）                                               | 判断                                                                                               |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [#435](https://github.com/tyaro/banto/issues/435) 操作定義・ショートカット   | `CommandSpec`、`shouldHandleShortcut`・`createShortcutDispatcher`      | `@banto/ui`（あり）                          | `designer/controllers/designer-actions.ts`、`App.svelte`の`shortcut`      | 1番目。キーの保護（IME変換中・入力欄・モーダル・`repeat`）から置き換え、操作定義の移行は後に分ける |
| [#437](https://github.com/tyaro/banto/issues/437) UI設定の保存状態           | `createSavedSetting`（`current`・`saved`・`saving`・`error`・`dirty`） | `@banto/admin-core`（あり）                  | `banto/setup.ts`、`designer/floating-*.svelte.ts`の保存                   | 2番目。パネルの幅・高さ・浮動配置の保存失敗と破損値のE2Eで受け入れる                               |
| [#436](https://github.com/tyaro/banto/issues/436) 非同期結果の失効と資源解放 | `createRequestOwner`（`begin`・`invalidate`・`dispose`・`busy`）       | `@banto/admin-core`（あり）                  | `designer/controllers/`の`image-import`・`clipboard`・`catalog`の世代番号 | 3番目。controllerごとに1つずつ置き換える                                                           |
| [#438](https://github.com/tyaro/banto/issues/438) ブラウザ画像の取込・原本   | `@banto/image-assets`の`inspectImageHeader`・`createImageStore`        | `@banto/image-assets`（なし）                | `lib/image-assets.ts`とProjectの資産store                                 | 4番目。依存の追加が要る。Projectの資産（Undo・package・資産lease）と上流のstoreの境界を先に決める  |
| [#432](https://github.com/tyaro/banto/issues/432) 入力保持とpane切替前guard  | `createFormDraft`・`DraftCoordinator`、`DockHost`の`beforePanelChange` | `@banto/forms`・`@banto/dock-svelte`（なし） | `designer/drafts.svelte.ts`、Inspector・作業タブの入力保護                | 可動パネルの工程（改訂B）で`@banto/dock-svelte`の採用と一緒に判断する                              |
| [#433](https://github.com/tyaro/banto/issues/433) 操作の所有者・取消         | `@banto/dock-svelte`の操作の持ち主とキーボード操作                     | `@banto/dock-svelte`（なし）                 | `designer/floating-panel*.svelte.ts`、`PanelResizeHandle.svelte`          | 同上                                                                                               |
| [#434](https://github.com/tyaro/banto/issues/434) 配置の検証・到達性         | `DockState`の`hydrate`の検証、`DockHost`の`clamp`                      | `@banto/dock-svelte`（なし）                 | `designer/floating-panel-layout.ts`                                       | 同上                                                                                               |

- #435の1段目（2026-11-18）: `App.svelte`の`shortcut`のキー保護を`@banto/ui`へ寄せた。Fは`shouldHandleShortcut`、F1/F2・Delete・Ctrl+N/O・Ctrl+Z/Y/A/G/Dは`isEditableTarget`・`hasVisibleModalLayer`とIME・`repeat`の判定を組んだ`shortcutAllowed`。上流の`shouldHandleShortcut`はメニューの表示中も止めるが、SCADAはコンテキストメニューを開いたままのCtrl+Aなどで選択を変えてメニューを閉じる（`e2e/selection-context.spec.ts`・`screen-context.spec.ts`）ので、メニューでは止めない。上流へ持ち込むなら「メニューを止める対象から外す」選択肢として相談する。変わった点: 押し続けのCtrl+A/G/Dと`keyCode 229`は無視、`aria-modal="true"`の層の表示中はCtrl+Z/Y/A/G/D・Deleteも効かない、チェックボックスは入力欄に数えない。Ctrl+Sと操作定義・`createShortcutDispatcher`への移行は後の区切り。試験は`e2e/history.spec.ts`の「shared guards」。
  - `shortcutAllowed`は上流の`shouldHandleShortcut`と同等ではない。メニューを止めないことのほかに、`event.defaultPrevented`の検査と、`composedPath()`の先頭による入力元の解決（shadow DOM内の入力欄を入力欄と判定する）を持たない（`event.target`で判定する）。`createShortcutDispatcher`へ移すときは同等と見なさず、差を試験で確かめる。
  - 1段目のレビューで未検証と指摘された点: メニュー表示中のF1/F2・Ctrl+N/O、`defaultPrevented`の付いたkeydown、非文字入力（チェックボックス・ボタンなど）からの操作、モーダルを閉じた後の復帰。移行の区切りで試験を足す。
- #435の2段目（2026-11-18）: `App.svelte`のF・F1/F2・Delete・Ctrl+N/O/S・Shift+Ctrl+S・Ctrl+Z/Y・Shift+Ctrl+Z・Ctrl+A/G/D・Shift+Ctrl+Gを`CommandSpec`の配列にし、`createShortcutDispatcher`で処理する。`shortcutAllowed`は削除し、上流の`shouldHandleShortcut`の保護（`defaultPrevented`・`composedPath()`による入力元の解決を含む）をそのまま使う。
  - メニューで止めない約束は`ownerLayer`で保つ。F以外の操作は、モーダルの表示中なら`null`、そうでなければ上に別のメニューが無い表示中のメニューを返す（`menuOwnerLayer`）。メニューが2つ同時に見えるときは止まる。上流へ持ち込むなら、この使い方ではなく「メニューを止める対象から外す」指定として相談する。
  - 前段の`routeBeforeCommands`（ダイアログ・タグ選択の表示中、配置のEsc、レイヤーのフォルダのDelete・Ctrl+D/X/C）と、記録・警報・履歴などの作業画面を開いている間の打切りは`shortcut`に残す（F・F1/F2はこの前段より先、という従来の順も保つ）。`enabled`/`run`はeventを受け取らないので、keydownの対象を`shortcutTarget`に控える。
  - Ctrl+S・Shift+Ctrl+Sはdispatcherに載せず、`handleSaveShortcut`で従来どおり層（モーダル・メニュー）では止めずに書き出す。「Project を置き換えますか」の表示中に書き出してから破棄する流れ（`e2e/image-crop.spec.ts`もこれを使う）があるため。最前面の層を`ownerLayer`に返す案は、メニューとモーダルが同時に残る場合（メニュー→F1）に上流の判定では互いに「上」（open popoverは常に上、モーダルはz-indexで上）となって層を選べず、保存が止まった（#254のオーナーレビュー）。IME・`keyCode 229`では何もせず、先に止められたキー・押し続けでは既定だけ止める。
  - 保護で断ったときも、F1/F2・Ctrl+N/O・Ctrl+S（Shift付きを含む）はブラウザの既定を止める（`reservedBrowserKey`、従来と同じ）。
  - 変わった点: 先に`preventDefault`されたkeydownは操作しない。Ctrl・Cmd（Meta）は従来どおりどちらでも効く（上流の`Mod`はmacOSではCmdだけなので、`Mod+`の操作を`Ctrl+`と`Meta+`に分けて登録する。macOSで`Control+…`を送る既存e2eのため）。
  - 試験: `e2e/history.spec.ts`の「dispatcher shortcuts …」で、`defaultPrevented`、チェックボックスからのCtrl+Z/Y、コンテキストメニュー表示中のF1/F2・Ctrl+N/O、モーダルを閉じた後の復帰、置換の確認の表示中とメニュー・ヘルプが同時に残った状態でのCtrl+S・Shift+Ctrl+Sでの書き出し、Ctrl・Metaの両方を確かめる。
  - 移行前からの残課題: メニューを開いたままF1でヘルプを開くと、メニューがヘルプの裏で開いたまま残り、最初のEscはメニューを閉じる（ヘルプはEsc 2回で閉じる）。
  - メニュー・toolbar・コンテキストメニューの項目を同じ`CommandSpec`（id）から作る移行は、次の区切り（`designer-actions.ts`）。
- Menuの200px幅の左4pxはみ出し（下の節）は、v7.5.0までのCHANGELOGに該当する修正が見当たらない。Banto Issueは未起票のまま。
- 置き換えの各区切りでは、既存の入力保護・資源解放・保存失敗のE2Eを通してから手元の実装を消す（[引渡しの方法](#引渡しの方法)の3）。
- 新しい還元候補（パネルの幅・高さの保存と「標準レイアウトに戻す」、作業タブの入力保護など）は、上の採用で上流のAPIとの差が見えてから起票する。

追加候補・TreeViewの既存APIとの差・現在渡せる試験は[還元候補と採用境界](banto-contribution-candidates.md)へ整理した。以下は当初起票時の目的と引渡し資産であり、未実装項目の現行一覧ではない。

## 当初起票した4件

| Issue                                                                            | 目的・既存機構との関係                                                                                                                   | 渡したSCADA資産                                                                                   |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [#435 操作定義・ショートカット](https://github.com/tyaro/banto/issues/435)       | 既存PaletteCommand/searchCommandsに接続し、メニュー・toolbar・context・キーの実行／可否と入力欄・IME保護を共通化。優先度: 高             | `designer-actions.ts`、Appのshortcut、menubar／selection-context／clipboard／save-stateのE2E      |
| [#436 非同期要求の失効と資源解放](https://github.com/tyaro/banto/issues/436)     | request・owner寿命・対象epochから古い結果を不採用にする小さい共通契約。既存認証のrevisionやformsの遅延navigate対策と重複整理。優先度: 高 | image-import／project-files／clipboard controller、遅延画像差替え・非同期cutのE2E、AssetStore単体 |
| [#437 UI設定の保存状態](https://github.com/tyaro/banto/issues/437)               | UiSettingsProviderの上でcurrent／saved／saving／errorを管理。成功した送信snapshotだけを保存済みにする。優先度: 中                        | banto/setup.ts、floating controller、左右浮動の保存失敗・破損値・独立slotのE2E、配置検証単体      |
| [#438 ブラウザ画像の取込・原本・寿命](https://github.com/tyaro/banto/issues/438) | 形式・寸法検査、原本bytes／alpha、hash、Object URLとpin/releaseを抽出。既存添付処理との境界を確認。優先度: 中                            | image-assets.tsと単体、実decode／透過／URL寿命のE2E、画像差替えcontrollerとE2E                    |

各Issueには出典コミット`21ded7415178a763a34ef3897635be224dea71ac`の実装・テストへの固定リンク、受入候補、対象外、既存APIとの関係を記載した。上流修正後も元の資産を参照できる。起票前のBanto mainは`edecb214c87d9690e6e9933b073354ce84e3bc1b`で、比較基準591294…からadmin-coreの該当APIに変更がないことを確認した。

## 引渡しの方法

1. 既存SCADA実装とテストを読んで、Bantoの既存APIと責務を照合する。SCADAのcontrollerを丸ごと複製することは完了条件にしない。
2. Project・画面／機器の意味・Undo・保存形式をcallbackやconsumerへ残し、汎用処理と最小fixtureをBanto自身の単体／ブラウザテストへ抽出する。Bantoからtemp-scadaへの実行時依存は作らない。
3. 上流で公開API・回帰を確定した後、SCADAは固定コミット依存を更新して接続する。既存の入力保護・資源解放・失敗時保持のE2Eを通してから局所実装を外す。

起票時の評価では、#435の操作定義はSCADAのbuilderから抽出が必要で、汎用registryが完成しているという意味ではない。#436の失効は完了済みOS clipboard書込を巻き戻す機能ではなく、古い結果による削除・適用を防ぐ。#437の並行保存・全providerの検証と、#438の利用側別上限は上流で追加設計・試験が必要。既存テストのリンクを渡すことと、汎用化後の全consumer検証完了を区別する。

## 関連する起票済み事項

- [#432 入力保持とpane切替前guard](https://github.com/tyaro/banto/issues/432): formsとdock lifecycle。#436の非同期primitiveと連携する。
- [#433 gestureの所有者・取消](https://github.com/tyaro/banto/issues/433): 移動／resize／divider。#435のキーscopeと整合させる。
- [#434 layout検証・到達性](https://github.com/tyaro/banto/issues/434): #437はその永続化consumerを支援し、幾何検証は重複させない。
- [#427 メニューの可用高・内部scroll](https://github.com/tyaro/banto/issues/427): **Closed**。[PR #430](https://github.com/tyaro/banto/pull/430)が2026-10-21 00:46（日本時間）にmergeされた。新規Issueは重ねない。2026-10-22にSCADAの固定依存更新と暫定adapter撤去を実施した。[Menuの責務と受入](../design/editor/designer-menu-viewport.md)と`e2e/menu-viewport.spec.ts`を、上流接続時の受入に使う。接続後の受入範囲は同仕様を参照する。 adapterありの成功だけでは上流受入の証拠にならないため、撤去後の検証と区別する。Chromium 156でのadapterありのbase work／PR #8の比較では、ともに200px幅でx=4／右端196／幅192pxとなり、はみ出しはなかった。以前の左端−4px／幅204pxはadapterの幅制限を外した観測で、PR #8の回帰ではない。PR #9の撤去後の狭幅制約として同仕様に残す。

パネルの[10ケース再現fixture](banto-dock-fixture/README.md)も引き続き利用できる。当初の引渡し時点ではIssue・文書の引渡しのみで、アプリ・依存・Project形式は変更していない。検証は出典ファイルとリンク、Issue本文の確認・整形であり、上記の全体テストを再実行した記録ではない。

## 追加の上流報告候補：viewportより広いMenu

PR #9のadapter撤去後、Chrome 155の200px viewportで常設Menuはx=−4／幅204pxとなった。幅制限を適用するとx=4／幅192pxであり、adapterありのbase work／PR #8もx=4／幅192pxだった。上流v6.9.0の`Menu.svelte:computePosition`の横clampは`Math.min(Math.max(left, GAP), viewportWidth - menuRect.width - GAP)`で、後半が負になる場合に左端を負値へ押す。viewportに応じた幅上限と位置補正の契約をBantoへ報告する候補として残す。新規Issueの投稿・依存変更はこの区切りでは行っていない。320px以上の受入とは区別し、局所adapterは再導入しない。

PR #9のレビュー修正ではMenuGroupだけをcontextKeyで再生成し、Menu／popover／triggerとfocus復帰先を保持した。SCADA固有のcontext寿命の修正であり、上流#427／#430の撤回ではない。修正後のブラウザ受入はChromium 156とChrome 155で関連13spec・76件が成功した。その他の共通APIの採用状態は上記のまま。

2026-10-23（日本時間）時点でも、この200px幅の左4pxはみ出しはBanto Issue未起票の残課題。Chromium 148のcontext menu即closeと過去の4並列画像比較差分も原因未特定で、上流原因と断定しない。floatingのorigin消失時に常設メニューへ戻すfallback経路のE2Eも未追加。[PR #9の検証結果と残課題](../history/implementation-history.md#menu-review-phase-b)を参照する。
