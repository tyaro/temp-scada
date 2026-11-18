# SCADAからBantoへの共通機能引渡し

2026-10-22（日本時間）更新、2026-11-18に棚卸しを追記。状態: **起票・当初資産の引渡し済み。上流は#432〜#438をBanto v6.8.0で公開済み。SCADAへの採用は未着手**（[2026-11-18の棚卸し](#2026-11-18の棚卸し上流の版とscadaの採用状況)）。既存の[パネル基盤比較](banto-dock-comparison.md)に加え、汎用化の候補と受入資産を記録する。

## 現在の確認状態

Banto main `ac571ebffa76db61e28230a7138223f069eee067`で再確認し、#432〜#438はすべてClosed。[PR #447](https://github.com/tyaro/banto/pull/447)のdraft基盤と[PR #453](https://github.com/tyaro/banto/pull/453)の画像Storeはmerge済み。SCADAのadmin-core／theme／uiはv6.9.0（`1bd12fe023cf3958dbdde923e1bdd4fdb28a9139`）へ固定依存更新済み。Menuの上流#427／#430修正を受け入れ、局所adapterをPR #9で撤去した。その他の共通APIへの接続・受入は未完了。

## 2026-11-18の棚卸し：上流の版とSCADAの採用状況

Banto v7.5.0のCHANGELOGで照合した。#432〜#438の公開APIはすべて**v6.8.0**で入った（計画書PR-1〜PR-14）。SCADAの固定依存はv7.2.0（#238）なので、`@banto/admin-core`・`@banto/ui`のAPIは依存を変えずに使える。`@banto/forms`・`@banto/dock-svelte`・`@banto/image-assets`はSCADAの依存に無い。SCADAのコード（`apps/banto-scada/src`）は下の上流APIを1つもimportしていなかった（2026-11-18にgrepで確認。以降#435・#437を採用、下の各段）。手元の対応先は名前と責務からの候補で、差分の照合はまだしていない。

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
  - 移行前からの残課題: メニューを開いたままF1でヘルプを開くと、メニューがヘルプの裏で開いたまま残り、最初のEscはメニューを閉じる（ヘルプはEsc 2回で閉じる）。上流へ[tyaro/banto#670](https://github.com/tyaro/banto/issues/670)で報告した（メニューとモーダルの上下が決まらない件と合わせて）。Banto v7.6.0でモーダルが開くとメニューを閉じるようになり解消した（PR #270で`e2e/history.spec.ts`をEsc 1回へ直した）。
  - `ownerLayer`でメニューを外す回避と、`Mod+`の複製は[tyaro/banto#669](https://github.com/tyaro/banto/issues/669)で上流へ相談した。
- #435の3段目（2026-11-18）: メニュー・toolbar・コンテキストメニューの項目とキーを、同じ`CommandSpec`から作る。定義は`designer-actions.ts`の`commands`（`DesignerCommandId`の13件: Projectの新規・開く・保存・名前を付けて保存、元に戻す・やり直す、すべて選択・複製・削除・グループ化・グループ解除、選択範囲を表示、ヘルプ）。名前・実行・使える条件（`enabled`）はここだけで決め、メニュー・toolbarは`disabled = !enabled()`、`App.svelte`の`keyCommand`はキーだけの保護（`when`: 入力元・キャンバス上の対象・ヘルプやタグ選択の表示中など）を足す。F2（名前を変更）はメニューに無いのでキーだけの定義のまま。
  - 条件はメニュー・toolbar側にそろえた（ユーザー判断）。キーで変わった点: 元に戻す・やり直すは戻せるものが無いと使えずキーをブラウザに残す、Ctrl+D・Deleteはロック中の選択や作業画面の表示中は効かない、Ctrl+Aは選べる配置が無いと効かない、Ctrl+N/O・Ctrl+Z/Y/A/G/Dは浮動パネルのドラッグ中・割付の一覧表の表示中も効かない（`menuBlocked`）。Ctrl+G・Shift+Ctrl+Gは使えないときもブラウザの既定（検索）を止める。
  - Ctrl+S・Shift+Ctrl+Sは2段目のまま`handleSaveShortcut`（層で止めない。共有の`project.save`の`enabled`は`menuBlocked`を見るので使わない）。
  - 項目の文言は共有の`title`（従来のメニュー・toolbarの文言）。メニューにキーを出すには`MenuItem`に表示欄が要るので、[tyaro/banto#671](https://github.com/tyaro/banto/issues/671)で上流へ依頼した。
  - 試験: `e2e/history.spec.ts`の「edit shortcuts share the toolbar's conditions」、`e2e/edit-lock.spec.ts`のロック中のCtrl+D。
- Banto v7.6.0の#669・#671の採用（2026-11-18）: 上の回避を上流のAPIへ置き換えた。
  - `menuOwnerLayer`（`ownerLayer`）を`blockOnMenu: false`へ。モーダルでは従来どおり上流が止める。変わった点: メニューが2つ同時に見えるときも止めない（従来は止まった）。
  - `Mod+`を`Ctrl+`と`Meta+`に分けた登録をやめ、`createShortcutDispatcher({ mod: "either" })`にした。`handleSaveShortcut`も`matchShortcut(…, "either")`。Ctrl+Meta同時押しは従来どおり一致しない。
  - 共有の`commands`に`shortcut`（メニューに出すキー）を持たせ、`commandItem`経由でメニューバー・コンテキストメニューの`MenuItem`の`shortcut`へ渡す。`keyCommand`は既定でこのキーを登録し、やり直しのShift+Ctrl+Zだけを別に足す（表示はCtrl+Y）。切り取り・コピー・貼り付けもCtrl+X/C/Vを表示する（キーはブラウザのcut/copy/pasteイベントが受ける）。toolbarには出さない。記号はOSに合わせる（macOSは⌘）。
  - 試験: `e2e/menubar.spec.ts`の「menus show the shared keys …」（表示と`aria-keyshortcuts`、メニュー表示中のCtrl+Z・Meta+Z）。
- #437（2026-11-18）: `banto/setup.ts`のUI設定11件（テーマ、メニューバー・ミニマップ・ルーラーの表示、部品の表示形式、パネルの幅、タグ参照パネルの高さ、お気に入り、プロパティ・作業パネルの浮動配置の保存枠）を、`@banto/admin-core`の`createSavedSetting`（`explicit`）に載せた。包みは`banto/ui-preference.ts`の`createUiPreference`で、通知の文言・既定値・壊れた値の解釈はSCADAに残す。
  - 変わった点: 送信は1件ずつになり、送信中の変更は1回にまとめて最後の値を送る（従来は幅のドラッグなどで書込みが並行し、終わる順で古い値が残り得た）。まとめた保存が失敗したときの通知は1回（失敗した送信ごとに1回）。浮動配置の保存枠は、送信に成功した値だけを`saved`とする上流の契約で従来の「失敗時は前の枠を残す」を保つ。
  - 変えていない点: 壊れた値の扱い（幅・高さ・お気に入りは既定値へ丸める従来の`parse`、表示の有無は`"false"`だけを非表示）、読込み失敗の通知の文言と順序、「標準レイアウトに戻す」の5項目は通知1回。
  - 試験: `banto/ui-preference.test.ts`（まとめと順序、失敗の通知の数、壊れた値・読込み失敗）、既存e2eの`panel-widths`・`panel-height`・`inspector-floating`・`sidebar-floating`・`layout-reset`・`favorites`・`menubar`・`banto`・`palette-placement`。
  - 上流との差: SCADAはUI設定の保存先が`createLocalUiSettings`だけで、Tauriの`createTauriUiSettings`へは移していない。読込みの`'invalid'`（壊れた値）は通知しない。
- #436の1段目（2026-11-18）: `designer/controllers/image-import.svelte.ts`の画像読込を`@banto/admin-core`の`createRequestOwner`に載せた（key `"image"`）。要求番号`imageReadRequest`と`imageBusy`を`begin`・`isCurrent`・`busy`に、画面・モード・世代などの変化（`imageScope`）での打切りを`invalidate`に置き換え、controllerの破棄で`dispose`する。仮の`AssetStore`は`hold`して`finish`で1回だけ閉じる。入力の確定待ちで適用を先送りしたときは`adopt`で先送りした適用へ渡し、適用側が閉じる（従来と同じ）。
  - 変えていない点: 背景の切抜き・差替えの対象・差替えの切抜きのepochは、要求の種類（背景・差替え）ごとの条件なので`invalidate`にせず、`current()`の中で従来どおり比べる（背景の切抜きが変わっても配置の読込は続く）。先送りした適用が実行されないまま捨てられた場合に仮Storeが残るのは従来と同じ。
  - 試験: `image-import.svelte.test.ts`（新しい読込による失効と古い読込がbusyを解かないこと、先送りした適用が読込の終了後も仮Storeを使えること）と、既存e2eの`image-assets`・`image-placement`・`image-replacement`・`background-image`・`background-crop`・`image-crop`・`image-paste`・`image-fit`。vitest（node）ではsvelteがサーバー向けにコンパイルされ`$effect`が動かないので、対象の変化による失効と破棄はe2eで確かめる。
- #436の2段目（2026-11-18）: `designer/controllers/clipboard.svelte.ts`のcopy・cut・pasteを`createRequestOwner`に載せた。keyを2つに分ける。
  - `"target"`: 操作を受けた時点で`begin`してすぐ`finish`する（busyにしない）。画面・モード・世代などの変化（`clipboardOwnerScope`）で`invalidate`し、従来の`clipboardEpoch`の比較を`isCurrent()`に置き換えた。下書きの確定待ちで実行を先送りした間の変化もこれで失効する。確定待ちの間の次の操作は`draft.pending`で入口が断るので、先送り中の`"target"`が新しい操作で上書きされることはない。
  - `"run"`: 実行中のcopy・cut・paste（busy）。対象の変化では`invalidate`しない。OSのクリップボード書込みは止められないので、古い実行が終わるまで次の操作を受けない従来の動き（2つの書込みが競わない）を保つ。失効した実行がモデルを触らないことは`"target"`の確認が受け持つ。controllerの破棄で`dispose`する。
  - 変えていない点: Projectの版・下書き・選択の一致の確認は対象の失効と別の条件として残した。完了したOSの書込みは戻さない（失効しても「コピーしました。…切り取りは中止しました。」のとおり）。
  - 試験: `clipboard.svelte.test.ts`（実行中のbusyと次の操作の拒否、確定待ちの先送りと取消し、失敗の後始末、読取り中の版の変化）と、既存e2eの`clipboard`・`asset-clipboard`・`image-paste`・`screen-view-clipboard`・`symbol-usages`。対象の変化による失効はe2eで確かめる（vitestでは`$effect`が動かない）。
- #436の3段目（2026-11-18）: `designer/controllers/catalog.svelte.ts`のHost catalogの購読を`createRequestOwner`に載せた。sourceの`begin`1回を1つの要求とみなせば形に合う（同じkeyの次の`begin`で前のdeliveryが失効する）。keyを2つに分ける。
  - `"scope"`: 1つの(Project, source)への購読。購読時に`begin`してすぐ`finish`する（busyにしない）。次の購読で上書きされ、effectの後始末と購読の失敗で`invalidate`する。従来の`active`の代わりで、購読をやめた古いsourceから遅れて来た`begin`が今の`"delivery"`を上書きしないための確認。
  - `"delivery"`: Hostへの1回のcatalog要求。sourceの`begin`ごとに`begin`し、`close`・`fail`で`finish`する。古いdeliveryの`close`・`fail`は`finish()`がfalseを返すので何もしない。controllerの破棄で`dispose`する。
  - 変えていない点: Project・sourceの同一性の比較は別の条件として残した（値が変わってからeffectが走り直すまでの間に届いた返事を採らないため）。`catalog-session.ts`のtokenによる古いdeliveryの拒否・payload検証もそのまま（純関数の単体試験を持つため二重の確認になる）。busyは使わない（読込中は従来どおりsessionのphaseで表す）。
  - 試験: 既存e2eの`catalog-selection`（差し替えた古いsourceから遅れて来た`begin`が今のdeliveryを失効させない確認を追加）・`native-auth`・`native-read-path`・`slot-state-color`・`slot-state-display`・`symbol-equipment-check`・`table`と`catalog-session.test.ts`。vitestでは`$effect`が動かないので単体試験は足していない。
  - #436の置き換えは`designer/controllers/`の3つで終わり。
- #438の1段目（2026-11-18）: `@banto/image-assets`（v7.2.0の固定）を依存に足し、`lib/image-assets.ts`の取込の検査（`imageHeader`・`inspectImage`・`sha256`）を上流の`inspectImageHeader`・`inspectImage`・`sha256Hex`に置き換えた。上限（8MiB・1辺8192px・1600万画素・PNG/JPEG）はSCADAが`validateImageImportLimits`で渡す。上流は文言を持たないので、エラーコードを従来の日本語の文に変え、コードは`Error.cause`に残す。`.svelte.ts`を含むソース配布なのでviteの`optimizeDeps.exclude`に足した（`vite.pages.config.ts`も）。
  - 変わった点: 終端の欠けたPNGは「ヘッダーが壊れています」になる（上流は`malformed-header`にまとめる）。アニメーションPNGと非対応のJPEG（ロスレス・12bit・算術符号化）は同じ`unsupported-format`の文。JPEGはフレームヘッダの成分数（1・3・4以外）・高さ0・セグメント長の不整合も断る（上流のヘッダ検査の範囲）。hashは`crypto.subtle`が無い平文HTTPでも計算できる。PNGの`eXIf`による縦横の入替えも一致とみなす。
  - 変えていない点: `AssetStore`（原本の保持・重複排除・URL・pin・collect・`importFrom`）は手元のまま。空のファイルは上流へ渡す前に従来の文で断る。ファイル名の整形と`ImageMetadata`の形（`mime`・`name`）。
  - 2段目（store）の境界: 上流の`createImageStore`はURLを`acquireUrl`の貸出しと`release`で管理し、最後の`release`でrevokeする。手元は`url(hash)`をcollectまで共有する（利用は`App.svelte`の`assetImages`だけ）。ほかに、metadataにファイル名が無い、package読込の宣言との一致確認（`put`の`expected`）が無い、`add`が内部に要求の失効（key）を持ち`createRequestOwner`と重なる、の差がある。移す前に、URLの貸出しを誰が持つか（`$derived`の中で借りられない）と、ファイル名・宣言の確認をどこに残すかを決める。
  - 試験: `image-assets.test.ts`（終端の欠けの期待を上流の分類へ、エラーコードが`cause`に残ること）、vitest全件、既存e2eの画像・資産14ファイル（`asset-clipboard`・`background-*`・`image-*`・`screen-background`・`symbol-image*`・`project-files`）。
- #438の2段目（2026-11-18）: `AssetStore`の中身を上流の`createImageStore`（`maxTotalBytes`は256MiB）に置き換えた。外から見た形（`put`・`url`・`pin`・`collect`・`importFrom`・`dispose`、`ImageMetadata`の`mime`・`name`）は変えていない。原本の保持・hashでの重複排除・容量上限・pinの数え・URLの作成と取消しは上流が持つ。
  - 決めた境界: URLの貸出しは`AssetStore`が原本1つにつき1つ持つ。`url()`の初回に`acquireUrl`で借り、`collect`でその原本が残らないとき・`dispose`のときに返す（`url()`は`App.svelte`の`$derived`で呼ばれ、そこでは返せないため）。pin中の原本は貸出しも残し、`dispose`後は最後のpinの解放で返す（従来の「pin中はURLも残る」）。手元に残したもの: ファイル名（同じ原本では最初の名前。原本が消えたら忘れる）、package読込の宣言との照合（`put`の`expected`）、失敗の日本語の文言（上流のコードは`Error.cause`）。`add`は`key`なしで呼ぶので、失効は`dispose`だけ（取込の要求の失効は従来どおり各controllerの`createRequestOwner`）。
  - 変わった点: 宣言との照合は上流が保持した後に行う。合わなければ、そのputで新しく入った原本だけを`delete`で消す（既にあった原本は残す）。`has`・`count`・`byteLength`は上流のreactiveな値になる。
  - 試験: `image-assets.test.ts`に、URLの貸出しが`collect`・`dispose`・pinの解放で1回だけ取り消されること、名前の引継ぎと宣言違反の巻戻し・`cause`の2件を追加。vitest全件（11033件）、svelte-check、既存e2eの画像・資産（`asset-clipboard`・`background-*`・`image-*`・`screen-background`・`symbol-image*`、94件）。Tauri実機・実ブラウザでのURLの寿命は未確認。
- Menuの200px幅の左4pxはみ出し（下の節）は、v7.5.0までのCHANGELOGに該当する修正が見当たらず、上流mainの`anchoredPopover.ts`の横clampも同じ式のまま。[tyaro/banto#668](https://github.com/tyaro/banto/issues/668)で報告した（2026-11-18）。
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
