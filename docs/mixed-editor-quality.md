# 混在図面の品質・性能計測（I5）

2026-10-21。状態: **初回計測・限定改善完了。全体CI成功確認済み**。[単体開発計画](upstream-independent-plan.md)のI5。[R6のNodeドメイン計測](editor-performance.md)と区別し、ブラウザで実際の読込・入力・保存・資源寿命を確認する。

## 条件と境界

公開サンプルとプログラムで生成するPNGだけから再現用図面を作る。非公開の実案件図面ではなく、実案件の規模や操作応答を保証しない。1画面100／500／1000配置を、矩形・折返しText・共有Symbol・画像・配管で構成する。同じ画像原本を再利用し、ファイルサイズ・画像寸法・配置内訳・共有定義を記録する。上流SDK・認証・保存形式は更新しない。

本番buildをVite previewで開き、1920×1080・Chromium・マウス／キー操作を使用する。関連試験やbuildと計測を同時実行しない。計測用の本番分岐・検証省略・大域cacheを追加しない。

## 測るもの

- 読込: ファイル指定開始から、主画面の配置数・画像参照と折返し完了を確認し、2回のrequestAnimationFrameを通過するまでのdriver経由経過時間。初回操作を別記し、反復の中央値と最大値を出す。
- キー移動／Undo: 信頼されたキーイベントをcaptureした時点から、対象配置のtransform更新と2回のrequestAnimationFrameまで。実際のディスプレイ描画時刻やハードウェア入力遅延ではない。ウォームアップ後の複数回を記録する。
- 保存: Ctrl+Sからdownload発生までのdriver経由時間。OSファイルpickerやディスク永続化時間は含まない。保存packageを読み戻し、位置・原文・参照・原本bytesを検証する。
- 資源: CDPでGC後のJSヒープ・DOM数を参考値として取得する。画像decode面・GPU・ブラウザ全体のRSSとは異なる。Blob URLの生成／解放とlive bytesを計測専用init scriptで追跡し、元のAPIへ委譲する。画像あり→資産なし図面を繰り返し開き、残留URLがないことを確認する。

計測値は単一環境の少数試行。最大値をp95と表記せず、閾値をCIの成否条件にしない。計測fixtureの検証と操作結果のassertは省かない。

## 判断

操作・Undo・保存で内容が壊れる、URLが解放されない、同条件で遅延が再現する場合は、その箇所を特定し別の保存区切りで改善する。差分Undoや検証cacheへ直ちに置換しない。改善不要の判断も根拠と限界を記録してよい。Windows実機・実OSのIME・実Hub・長時間運転は今回の計測外。

## fixtureと計測入口

`apps/banto-scada/scripts/mixed-editor-fixture.mjs`は5種類を等数配置し、公開ポンプSymbol（内部9配置）を再利用する。1024×512の自作PNG4枚は合計133,898 bytes・2,097,152画素。RGBA展開なら計8MiB相当だが、ブラウザの実decode／GPUメモリ使用量を測った値ではない。Nodeでは読取専用の原本sourceを実際のpackage writerへ渡す。ブラウザのpackage読込では通常のchecksum・寸法・decode検証が走る。

計測runnerは`apps/banto-scada/scripts/benchmark-mixed-editor.mjs`。ファイルinputがクリアされるまで待ち、同じ配置数の再読込を前回のDOMで完了扱いにしない。5秒を超えた500配置の読込を記録したため、計測だけは各待機60秒で打ち切る。CIのtimeout・retryは変更しない。移動はスナップをOFFにし、50回確定後の位置と保存package全体・PNG原本bytesの一致をassertする。

## 初回に確認した負荷

基準アプリ`1bdb624`。500配置の再読込中央値11,532ms、キー移動493.7ms。再読込で約7,800回のLayout／RecalcStyleが発生し、RecalcStyleDurationは約4.9〜7.0秒だった。1000配置の初回読込は約33.7秒、RecalcStyleDuration約22.4秒。複数行Textの適応的`getBBox`計測で図面側のSVGを反復更新する経路を、限定改善の候補とする。

比較候補は複数行Textの計測用probeだけを一時的なCSS contain領域へ複製する。原文・折返し計算・font計測方式・Project・Undo・描画先は維持する。大域cache・計測値の使い回し・数値省略は導入しない。SVGの実寸法一致、非表示時の扱い、成功／失敗時の一時DOM解放を確認し、同じfixtureで比較して採否を決める。

変更前の[生JSON](performance/i5-baseline.json)を保存した。100／500／1000配置の再読込中央値は約1.55／11.53／37.70秒、キー移動は約103／494／815ms。50履歴の移動確定の最大値は1000配置で約5.25秒だった。3規模とも保存内容・PNG原本が一致し、資産なしProjectへの3回の切替後にlive URLは0件。ヒープはGC後の参考値として記録し、初期値との差だけでリークを断定しない。

### 拡縮時の文字寸法の保護

最初の隔離候補では1000配置の原文・行数は一致したが、ベースラインに約0.13図面単位の差があったため、その計測結果を最終採用値にしない。ChromiumのSVG font hintingを保つため、外側SVGの座標変換からCSS側の変換を除き、SVGのviewport・group変換を一時probeへ引き継ぐ。SVGの入れ子、拡縮、回転、縦横別倍率、CSS変換を含む寸法比較を追加した。丸め誤差の上限は0.0001図面単位で、原文・行数・省略結果は完全一致を要求する。

runnerへ`SCADA_BENCHMARK_BASELINE=docs/performance/i5-baseline.json`を渡すと、保存した1000配置の投影と比較し、上限超過や行内容の差を拒否する。初回100／500の記録には投影がないため、この機械比較は1000配置のみ。両テーマの寸法試験で各font・倍率を別途検証する。

変換を引き継いだ本番buildでは、変更前1000配置の200個のTextと原文・行数・省略結果が完全一致し、x／yの最大差は`0.000000476837158203125`図面単位だった。SVG font metricsの浮動小数点丸めの範囲として扱い、完全なbit一致とは表記しない。変換を含む両テーマの寸法試験も成功した。最終の速度・資源・保存往復はこの修正を含むbuildで再計測する。

## 再現手順

別ターミナルで本番previewを起動する。

```sh
source scripts/cloud-env.sh
pnpm build
pnpm --filter banto-scada preview --port 5233 --strictPort
```

本番previewと同じ作業ツリーで、他のbuild・テストを止めて実行する。

```sh
source scripts/cloud-env.sh
SCADA_BENCHMARK_BASELINE=docs/performance/i5-baseline.json node apps/banto-scada/scripts/benchmark-mixed-editor.mjs /tmp/scada-mixed-quality 100 500 1000
```

出力先に自己生成package、各規模のJSONと両テーマPNG、`report.json`を保存する。変更前はアプリ`1bdb624`、最終比較は`8a7cf21`の本番build。Linux x64、Node24.19.0、CPU quota 4コア、メモリ上限32GiB、viewport1920×1080。Chromium版・時刻・SHA・各資産hashは生JSONを参照。待機中のGitHub CIは別のrunnerで動き、このクラウド内では試験・buildを並走させていない。

## 最終比較と採否

[変更前JSON](performance/i5-baseline.json)と[変換保護後のJSON](performance/i5-after-svg-measure.json)。表は中央値、ms。各規模1回のrunで、再読込／保存3回、移動／Undo9回。反復移動は50回。最大値もJSONへ残し、p95や設備規模の保証として扱わない。

| 操作             | 100配置（前→後） | 500配置（前→後） | 1000配置（前→後） |
| ---------------- | ---------------: | ---------------: | ----------------: |
| 再読込           |         1554→935 |       11532→6395 |       37701→17842 |
| キー移動         |           103→69 |          494→399 |           815→691 |
| Undo             |           145→89 |          394→287 |           749→856 |
| 50履歴を積む移動 |            95→84 |          431→461 |           920→806 |
| 保存download開始 |            62→65 |          120→139 |           316→289 |

再読込の中央値は約40／45／53%短縮し、スタイル再計算の費用も下がった。原文・行数・省略結果の一致と一時DOMの解放を確認できたため、この限定改善を採用する。キー移動・Undo・保存の全般改善とは主張しない。1000配置のUndo中央値は増え、キー移動の最大値は約2.16秒、50履歴中の移動最大値も約2.04秒だった。大きな図面の編集・履歴には引き続き費用があり、実運用に十分な性能へ到達したという意味ではない。

### 保持資源と内容

3規模すべてで保存Projectの内容・参照・PNG4枚の原本bytesが一致した。画像原本は50履歴の前後とも4 URL・133,898 bytesで、履歴ごとに原本を複製していない。保存download用のURLは別に一時増加する。資産なし図面への3回の切替ではlive URL／bytesが0になり、計測hostも残らなかった。

GC後JSヒープは50履歴の前→後で、100配置約24.6→30.3MB、500配置約76.2→102.1MB、1000配置約141.3→194.5MB。資産なし図面への切替後の最終値は約11.5／13.4／15.1MBだった。JIT・UI設定・ブラウザ内部cacheの影響も含む値であり、正確な履歴専用メモリ量や画像decode／GPU量ではない。3回の切替だけで長時間のリーク不存在を保証しない。

### 検証と残り

型チェックはエラー・警告なし、全TS単体1104件、文字関連ブラウザ18件、本番build・整形が成功した。変換保護後に同じ18件を再確認し、最終3規模の計測・保存往復・投影比較も成功した。Project0.33.0・Banto・Industrial SDKは不変。実装`8a7cf21`の[全体CI39540132164](https://github.com/tyaro/temp-scada/actions/runs/39540132164)でFrontend・Rust・ブラウザ4分割・集約checkがすべて成功した。

初回のI5としては、計測入口・根拠・限定改善を保存する区切りとする。次は1000配置のキー移動・Undoのドメイン処理／Svelte更新／レイアウトの内訳を別の計測で切り分ける。R6のNode計測をそのままブラウザ時間へ読み替えず、差分Undo・大域cache・検証省略を先行実装しない。Windows実機、実Hub、長時間連続運転、実案件図面は後続。

## 実画面

公開サンプルと自作PNGによる再現用図面。製品の設備テンプレートや実設備監視画面ではない。100配置を両テーマで表示した。1000配置のfit表示は密度確認用で、全要素をFHDで読める保証ではない。

![100配置の混在図面・ライト](assets/frontend-ux/mixed-quality-100-light.png)

![100配置の混在図面・ダーク](assets/frontend-ux/mixed-quality-100-dark.png)

[1000配置の実画面](assets/frontend-ux/mixed-quality-1000-light.png)。必要な拡大表示は既存のツールバー／Ctrl+ホイールで行う。
