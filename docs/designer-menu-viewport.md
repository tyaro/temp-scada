# Designerメニューの可用高さとスクロール

状態: **Banto v6.7.0への局所adapter**。左作業パネルの操作追加後、常設メニューの末尾が小さい画面からはみ出す問題をCIで確認した。Bantoの依存コードは変更せず、上流へ[#427](https://github.com/tyaro/banto/issues/427)を報告した。

## 原因と境界

公開Menuは上下反転・横位置補正を持つが、上下いずれにも収まらない高さの制限がない。またwindowのcapture scrollで閉じるため、overflowだけを加えるとmenu自身のスクロールやEnd／矢印のfocus移動でも閉じる。

`settle-menu-focus.ts`のbeforetoggleで、そのMenuのtrigger上下の広い側の可用高さを求め、padding・border込みのmaxHeightとoverflowを設定する。overscrollは背面へ伝播させない。前面表示・項目・権限・キー操作・light dismissはBantoを使う。

`menu-viewport.ts`のwindow capture境界は、**登録済み・接続中・開いているMenu要素自身のscrollだけ**を区別する。子孫widgetや外側のscrollを対象へ広げない。Bantoのancestor-scroll listenerより前に動く必要があるため、`main.ts`でmount前に一度登録する。resize時もBantoの再配置前に制約を更新する。close・action破棄・HMR時に登録を解除する。

`stopImmediatePropagation()`は対象Menu自身のscrollについて他の後続listenerも止めるため、共有基盤として一般化せず暫定対応として維持する。上流の可用高・内部scroll対応が公開されたら固定revを更新し、この境界を削除して同じ受入試験を行う。

## 検証

`2822881`の全体CI39430512454では、フロントエンド・Rust・ブラウザ3分割は成功、1分割の標準復元（両テーマ）とメニューバー復帰の3件がタイムアウトした。ローカルでも同じ3件を再現し、修正後は3件すべて成功した。timeoutやretryは増やしていない。

`menu-viewport.spec.ts`で小さい画面の高さ、ArrowUpで末尾から開く・Home／End・内部ホイールで開いたままの表示、Esc、開いたままのresize、外側キャンバスのscrollによるdismissを確認する。既存の`layout-reset.spec.ts`・`menubar.spec.ts`と合わせた19件が成功した。型チェック（エラー／警告なし）と本番buildも成功。Project・保存形式は0.32.0のまま。
