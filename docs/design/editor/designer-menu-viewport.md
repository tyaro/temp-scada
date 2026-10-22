# Designerメニューの可用高さとスクロール

状態: **Banto v6.9.0へ依存更新済み・局所adapter撤去待ち**。左作業パネルの操作追加後、常設メニューの末尾が小さい画面からはみ出す問題をCIで確認した。Bantoの依存コードは変更せず、上流へ[#427](https://github.com/tyaro/banto/issues/427)を報告した。

2026-10-22更新: 上流#427は[PR #430](https://github.com/tyaro/banto/pull/430)で解決済み。SCADAの固定依存はv6.9.0へ更新済み。上流修正の受入と局所adapter撤去は未完了で、PR #9の別工程とする。adapterを外した状態で`e2e/menu-viewport.spec.ts`の内部／外部scroll・末尾項目・キー・resizeを通すことを受入条件にする。adapterありでも同じ試験は通るため、それだけでは上流修正の受入証拠にならない。[引渡し一覧](../../reviews/banto-contribution-handoff.md)を参照。

## 局所対応を導入した原因と現在の境界

導入時の旧版Menuは上下反転・横位置補正を持つが、上下いずれにも収まらない高さの制限がなかった。またwindowのcapture scrollで閉じるため、overflowだけを加えるとmenu自身のスクロールやEnd／矢印のfocus移動でも閉じていた。v6.9.0は可用高制限・内部scrollの除外・focus前のflushSyncを上流に持ち、以下のadapterと重複している。

`settle-menu-focus.ts`のbeforetoggleで、そのMenuのtrigger上下の広い側の可用高さを求め、padding・border込みのmaxHeightとoverflowを設定する。overscrollは背面へ伝播させない。前面表示・項目・権限・キー操作・light dismissはBantoを使う。

`menu-viewport.ts`のwindow capture境界は、**登録済み・接続中・開いているMenu要素自身のscrollだけ**を区別する。子孫widgetや外側のscrollを対象へ広げない。Bantoのancestor-scroll listenerより前に動く必要があるため、`main.ts`でmount前に一度登録する。resize時もBantoの再配置前に制約を更新する。close・action破棄・HMR時に登録を解除する。

`stopImmediatePropagation()`は対象Menu自身のscrollについて他の後続listenerも止めるため、共有基盤として一般化せず暫定対応として維持する。固定revは更新済みで、この境界の削除と受入試験を残す。上流はopen／resizeでmax-heightを消して再計測するため、adapterの高さ指定を上書きする。一方、boxSizing・maxWidth（`min(320px, calc(100vw - 8px))`）・overflowYはclose後も残る。上流の横位置補正はdocumentElement.clientWidthと4pxの余白を使う。Chromium 156.0.8078.4で常設メニューを比較すると、adapterありのbase work（v6.7.0）と本PR（v6.9.0）は幅200pxでともにx=4／右端196／幅192pxとなり、はみ出しはない。幅240pxはともにx=4／幅212.19pxで、320／480pxも同じだった。以前の「幅200pxで左端−4px」はadapterの幅制限を外した状態（x=−4／幅204px）の観測であり、PR #8の回帰ではない。PR #9でadapterを撤去するときの狭幅制約として扱う。

## 検証

`2822881`の全体CI39430512454では、フロントエンド・Rust・ブラウザ3分割は成功、1分割の標準復元（両テーマ）とメニューバー復帰の3件がタイムアウトした。ローカルでも同じ3件を再現し、修正後は3件すべて成功した。timeoutやretryは増やしていない。

`menu-viewport.spec.ts`で小さい画面の高さ、ArrowUpで末尾から開く・Home／End・内部ホイールで開いたままの表示、Esc、開いたままのresize、外側キャンバスのscrollによるdismissを確認する。既存の`layout-reset.spec.ts`・`menubar.spec.ts`と合わせた19件が成功した。型チェック（エラー／警告なし）と本番buildも成功。Project・保存形式は0.32.0のまま。
