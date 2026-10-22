# Designerメニューの可用高さとスクロール

状態: **Banto v6.9.0のMenuへ移管済み**。固定依存をv6.9.0へ更新し、上流[#427](https://github.com/tyaro/banto/issues/427)／[PR #430](https://github.com/tyaro/banto/pull/430)の修正を受け入れた。左作業パネルの操作追加後に小さい画面で常設メニュー末尾がはみ出した問題への局所adapterは、依存更新後のPR #9で撤去した。adapterありの試験成功だけでは上流修正の受入証拠にならないため、撤去後の受入を区別する。[引渡し一覧](../../reviews/banto-contribution-handoff.md)を参照。

## 責務と不変条件

上流Menuが上下反転・横位置補正、paddingとborderを含む可用高、内部スクロール、初回フォーカス、Home／End／矢印、Esc復帰、resize再配置を所有する。Menu自身のscrollで閉じず、外側のscrollで閉じる。overscrollは背面へ伝播させない。

Designerは横方向のメニューバー移動と、右クリック時の対象選択・起動を維持する。ContextActionsの仮想triggerはクリック座標を保持するため、resizeでその座標が画面外へ出る場合の上端補正と画面高の上限は引き続き同コンポーネントが担う。メニュー項目の実行可否、未適用入力保護、Project・保存形式は変更しない。アプリ固有のcapture scroll抑制やフォーカス再試行は行わない。ContextActionsは`contextKey`ごとにMenuを再生成し、対象切替で表示項目が変わったときも上流の登録順と表示順を揃える。同じcontext内ではMenuItemを表示位置ごとに再利用する。`selection-context.spec.ts`で選択／空白contextを往復し、初期フォーカス・全有効項目の矢印巡回・Home／End・Esc復帰を確認する。

## 局所対応の撤去

v6.7.0では小さい画面で常設メニュー末尾が画面外へ出たため、`menu-viewport.ts`と`settle-menu-focus.ts`を利用していた。v6.9.0への更新後、この2ファイルとmain／App／DesignerMenubar／ContextActionsの接続を撤去した。HMRの破棄処理にはUI設定の監視解除だけを残す。

旧adapterは横幅を`min(320px, calc(100vw - 8px))`に制限していた。現在は上流の`max-width: 320px`を使用し、viewport幅による追加制限はない。狭幅の受入では実際のメニュー外接矩形とキー操作を確認する。実測では常設メニューは240px以上で横幅約212.19pxとなり、旧横幅制限を同じMenuへ適用した場合も幅は変わらなかった。200px幅では上流版は幅204px・左端−4pxとなる一方、旧制限を適用すると幅192px・左端4pxとなった。320px以上の受入と、極端な幅での汎用Menu全体の保証は区別する。これは横幅制限だけの比較で、旧adapter全体の画素比較ではない。

PR #8の訂正記録: Chromium 156.0.8078.4でadapterありのbase work（v6.7.0）とPR #8（v6.9.0）を比較した場合、200px幅はともにx=4／右端196／幅192pxで、240／320／480px幅も同じだった。以前の左端−4px／幅204pxはadapterの幅制限を外した観測であり、PR #8の回帰ではない。上記の狭幅制約はPR #9でadapterを撤去した後の状態として扱う。

## 検証と完了条件

`e2e/menu-viewport.spec.ts`は480px高でArrowUpから末尾を開く、Home／End・矢印・内部ホイール、Escのtrigger復帰、開いたままのresize、外側キャンバスのscrollによるdismissを確認する。両テーマの480／360／320px幅で外接矩形・初回フォーカス・末尾到達・Esc復帰を確認し、寸法とスクリーンショットを記録する。

`menubar.spec.ts`、context操作、`layout-reset.spec.ts`、左右浮動、Banto接続の既存試験も受入対象とする。型・単体・build・macOS E2Eの成功と、局所adapterへの参照が残らないことを完了条件とする。導入当時の19件成功・CI回帰の経緯は過去の検証であり、今回の結果と混同しない。

2026-10-22の受入: 型エラー／警告0、TS1,214件、build、修正後の関連ブラウザ54件が成功。macOSの全746件も実行結果をIDで照合し、成功632件と再開成功112件、Ctrlクリックのskip2件を確認した。4並列実行での画像比較・遅延timeout後に1並列で未成功分を再開した結果で、単一の全件一括成功ではない。局所adapterへの接続は残っていない。
