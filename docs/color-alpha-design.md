# 単色と枠線のα

文書の位置付け: **採用済み設計・導入時の実装記録。文中の旧版・件数・当時の未実装表記は記録時点のもの。** 現在の対応範囲と保存契約は[実装状況](implementation-status.md)を正とする。

> 0.18.0更新: 矩形／楕円の塗りは `paint.fill.enabled` と `paint.fill.paint`（solid／linearGradient）へ集約した。旧root `fill`／`colorAlpha` は図形では禁止する。以下は導入時の設計記録。現行契約・フォーム操作は[線形グラデーション設計](linear-gradient-design.md)を参照。Text・Polyline・Symbolの単色αと枠線αの合成規則は維持する。

Project 0.15.0で実装。[配置全体の不透明度](opacity-design.md)と、paintに使う色のαを分離する。[拡張設計](scada-graphics-runtime-extension-design.md)に対する段階導入で、gradient／patternを持つ判別型paintへの再編は後続。

## 保存契約

全配置の任意 `colorAlpha` は、現行 `fill` のRGBに対応する単色のα。矩形／楕円では塗り、Textでは文字、Polylineでは線本体と終端矢印、Symbolでは配置単色に対応する。矩形／楕円の枠線は `shape.paint.stroke.alpha` を別に持つ。いずれも省略は1、有限な0〜1を保存する。α0でも塗りあり・配置あり・タグ参照ありを維持し、非表示やクロマキーへ置換しない。

旧0.14.0は自動移行しない。共有schema・Rust・TypeScript・サンプル・clipboard・JSONを現行版へ揃える。RGBだけの編集ではαを保持する。省略された1へ100%を無変更適用しても履歴を作らず、明示1は無変更のまま保持する。

## 合成と描画

矩形／楕円はfillとstrokeへ各αを適用し、最後に配置opacityを掛ける。重なった塗りと枠線は独立したpaint channelなので、それぞれのαで合成される。

TextとPolylineは、文字または線本体＋矢印を合成したグループへ `colorAlpha × opacity` を一度だけ適用する。線と矢印の接合部へ同じαを重複適用して濃くしない。

Symbolは内部の各paintαと子配置opacityを保持して合成する。配置単色モードはRGBだけを置換し、合成後のSymbolへ `colorAlpha × opacity` を一度掛ける。定義色モードは配置のcolorAlphaを保存するが描画へ使わず、配置opacityだけを掛ける。共有定義の内部αを変更しない。

合成計算を共通関数へまとめ、Editor・表示プレビュー・ミニマップ・Symbolサムネイルで共用する。選択枠・hit領域・ハンドルにはαを掛けず、0%でも選択できる。エディタのテーマ切替は保存色・αを変更しない。

## UI

配置全体の「不透明度（%）」と区別し、「塗り／文字／線／単色の不透明度（%）」を色欄の隣に置く。0〜100%、Enter／フォーカス移動でその項目だけ確定、Escで取消。範囲外は入力を保持してエラーにする。塗りなし・Symbol定義色モードでは保存αを表示したまま入力無効にし、現在の描画に使わないと説明する。塗りあり・単色へ戻すと保存αが復帰する。

「枠線の不透明度（%）」は既存paintフォームで明示適用する。枠線なしにするとstroke全体を解除するため、そのαも解除される。RGBの一括変更はαを変えない。定義色Symbolを明示単色化するチェックには、保存された単色αも有効になることを案内する。αの一括編集は後続。

![塗りと枠線の不透明度・ライト](assets/frontend-ux/color-alpha-light.png)

[ダーク](assets/frontend-ux/color-alpha-dark.png)。静的な描画比較で、正式RuntimeやHub接続を示さない。
