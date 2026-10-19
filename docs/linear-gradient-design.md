# 矩形・楕円の2色線形グラデーション

2026-10-20（日本時間）。Astraの読取専用レビューを反映した次工程。[描画拡張の計画](scada-graphics-runtime-extension-design.md#2-paint線種αを先行する)に従う。**保存契約とUI・共通描画への接続は未実装**。現在は局所座標の計算基礎だけを検証する。

## 塗りを1つの正へ整理する

矩形・楕円の塗りRGBとαをpaintへ集約し、既存の配置fill／colorAlphaと二重保存しない。Text・Polyline・Symbol配置色の単色契約、画像原本と配置全体のopacityは維持する。保存モデルを次のバージョンへ更新し、Rust／TypeScript／schema・生成例・既存操作を同期する。リリース前の旧形式の互換性は要求しない。

```ts
type FillPaint =
  | { type: "solid"; color: string; alpha: number }
  | {
      type: "linearGradient";
      angle: number;
      start: { color: string; alpha: number };
      end: { color: string; alpha: number };
    };
// rectangle / ellipse
paint: {
  fill: {
    enabled: boolean;
    paint: FillPaint;
  }
  stroke: ExistingStroke | null;
}
```

「なし」はenabled=falseとしてpaintを保持する。再有効化で元の塗り・α・gradientを復元する。色は6桁HEX、αは有限の0〜1。始点・終点は0%／100%固定、角度は0〜360°未満へ正規化する。radial・pattern・多点stop・キャンバス上の制御ハンドルは後続。

## 単独Inspectorと入力保護

塗りの有無・種類・詳細を同じ明示適用フォームへまとめる。solidは色と不透明度、gradientは両端の色と不透明度・角度を表示する。矩形・楕円の下側の共通RGB／色α欄を外し、同じpaintを別フォームから更新しない。

solid→gradientの初期値は両端とも現在の色・α、角度0°として、外観を維持する。gradient→solidは始点の色・αを使うと表示する。適用後の復元はUndo。フォーム内の切替だけなら未適用値を保持する。blurで一部を先に確定せず、Enterでフォーム適用、IMEと他フォームの事前検証を共用する。

## Symbolと共通色

定義色Symbolは内部paintを保持する。単色Symbolは各stopのRGBだけを配置色へ置換し、各stopのα・子opacityを保つ。配置単色α×配置opacityは合成後に1回だけ掛ける。原本定義を変更しない。

RGB一括色の初回範囲は、有効なgradient塗りを含む選択を全体拒否し、単独Inspectorへ案内する。異なる端点αを暗黙にsolidへ縮約しない。無効なgradientと有効な枠線なら、枠線だけを変更でき、保存paintを保つ。単色Symbol配置のRGB変更は維持する。

## 局所座標と共通描画

0°は左→右、90°は上→下。図形の幅・高さと単位方向から四隅の射影範囲を求め、中心を通る端点を計算する。SVGのuserSpaceOnUseを使い、非正方形でも指定角度を維持する。配置の回転は既存transformで行い、resizeでは端点を再計算する。SVG IDは描画インスタンス単位で一意にし、同じSymbolの複数配置・ミニマップ・サムネイルで衝突させない。

外形・hit・回転pivotを変えず、両端α0でも透明hitやレイヤーから選べるようにする。配置opacity以外のαを重ねて掛けない。画像を伴わないgradientのclipboardはv1でよく、資産を追加しない。

## 検証の区切り

まず`linear-gradient.ts`で直交方向・非正方形45°・四隅の射影範囲・resize・角度正規化・有限座標を検証する。これは画面でgradientを編集できる状態の完成ではない。

接続後はTS／Rust／schema、異なる端点α、塗りなし往復、同一Symbol複数配置とミニマップ、共通色の原子的拒否、回転＋resize、JSON／両clipboard／Undo往復、両テーマと入力保護を確認する。
