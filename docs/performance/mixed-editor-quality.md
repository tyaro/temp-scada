# 混在図面の品質・性能計測（I5）

2026-10-21。状態: **初回〜I5eの全体CI成功。I5fの現行再計測・候補見送り、I5gの履歴資産索引も全体CI成功**。[単体開発計画](../project/upstream-independent-plan.md)のI5。[R6のNodeドメイン計測](editor-performance.md)と区別し、ブラウザで実際の読込・入力・保存・資源寿命を確認する。

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

変更前の[生JSON](i5-baseline.json)を保存した。100／500／1000配置の再読込中央値は約1.55／11.53／37.70秒、キー移動は約103／494／815ms。50履歴の移動確定の最大値は1000配置で約5.25秒だった。3規模とも保存内容・PNG原本が一致し、資産なしProjectへの3回の切替後にlive URLは0件。ヒープはGC後の参考値として記録し、初期値との差だけでリークを断定しない。

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

[変更前JSON](i5-baseline.json)と[変換保護後のJSON](i5-after-svg-measure.json)。表は中央値、ms。各規模1回のrunで、再読込／保存3回、移動／Undo9回。反復移動は50回。最大値もJSONへ残し、p95や設備規模の保証として扱わない。

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

![100配置の混在図面・ライト](../assets/frontend-ux/mixed-quality-100-light.png)

![100配置の混在図面・ダーク](../assets/frontend-ux/mixed-quality-100-dark.png)

[1000配置の実画面](../assets/frontend-ux/mixed-quality-1000-light.png)。必要な拡大表示は既存のツールバー／Ctrl+ホイールで行う。

## I5b：キー移動・Undoの内訳と復元候補

同じ`mixedFixture`をNode側でも計測できるよう、既存の`benchmark-editor.mjs`へ`--mixed`を追加する。既定のR6 fixtureは維持する。Nodeは実ドメイン関数をSSR loaderで呼び、ブラウザ版は本番bundleの実キー操作を使う。両者は別の実行環境なので、Nodeの時間をブラウザ時間から引いてSvelte処理時間とはしない。

ブラウザrunnerではwarmupの移動／Undoに続く各9回についてCDPのScriptDuration・LayoutDuration・RecalcStyleDuration・TaskDurationと回数の差を記録する。期間はドライバーとの通信や待機も含み、キーイベントから2rAFまでの既存指標と厳密に同じ区間ではない。CDP durationの単位は秒で、指標は重なるため合計しない。性能の合否閾値やCI待機時間は変更しない。

Undoの候補変更は、履歴snapshotを検証・正規化したあとrevisionを更新し、候補を`parseProject(JSON.stringify(restored))`で再検証する。旧経路の`parseProject(serializeProject(restored))`はserialize内部と外側で同じ候補を2回検証する。履歴の入口検証、更新後revisionの上限、現在Projectのsnapshot生成時の検証、別Project拒否、独立候補、原子的失敗は残す。履歴の件数・形式・資産寿命・保存モデルは変えない。

```sh
source scripts/cloud-env.sh
node --expose-gc apps/banto-scada/scripts/benchmark-editor.mjs --mixed 100 500 1000 > /tmp/i5b-domain.json
# 本番previewの起動後。Node計測やbuild・テストとは並走させない。
node apps/banto-scada/scripts/benchmark-mixed-editor.mjs /tmp/i5b-browser 100 500 1000
```

復元候補の限定変更を採用する。UI更新全体の高速化とは扱わず、残るScriptDurationは後続のサンプリングprofileで調べる。

### I5bのドメイン比較

[Node生JSON](i5b-domain.json)。基準`de1fe7f`と履歴候補変更、同じ100／500／1000混在配置。各9回の中央値はUndoが6.732→5.129ms、32.856→22.946ms、60.379→42.557msだった。1回ずつのrunであり、ブラウザ応答の短縮率へ読み替えない。最大値と未変更操作の変動もJSONに残す。

[ブラウザ変更前JSON](i5b-browser-before.json)では1000配置のキー移動中央値1118ms、Undo1057ms。CDP ScriptDurationの中央値はそれぞれ1012／953msで、LayoutDurationは約3〜4ms、RecalcStyleDurationは約3msだった。Nodeとは実行環境も区間も違うため差分をSvelte時間と断定できない。スクリプト側を優先して追う根拠とする。50履歴移動の最大は約11.5秒で、このrunには大きなばらつきもある。

### I5bの本番ブラウザ比較と残り

[変更後JSON](i5b-browser-after.json)。アプリ差分は`27f10b9`の履歴候補コピーのみで、Project0.33.0・Banto・Industrial SDKは維持する。beforeは`8a7cf21`のbuild、docs-only HEADは`de1fe7f`。afterも`de1fe7f`上の候補からbuildした同一コードで、`27f10b9`へコミットした。実行時のHEADとbuildの関係をJSONにも記録した。同じクラウド・Chromium・fixtureで、ローカルの重い処理は並走させていない。表は各9回（保存3回、連続移動50回）の中央値、ms。

| 操作             | 100配置（前→後） | 500配置（前→後） | 1000配置（前→後） |
| ---------------- | ---------------: | ---------------: | ----------------: |
| キー移動         |            87→70 |          448→307 |          1118→697 |
| Undo             |           107→60 |          392→277 |          1057→655 |
| 50履歴を積む移動 |            94→74 |          340→325 |           810→709 |
| 保存download開始 |            76→52 |          152→148 |           235→232 |

この比較では未変更の移動・保存にも時間差があり、Undo差分の全部を今回の変更に帰属させない。ホスト負荷・JIT・GC等を制御しきれず、各1runの観測で統計的有意性も評価していない。Node側で候補コピー費用の削減を確認し、検証・正規化・原子的拒否を維持できた範囲で採用する。1000配置の変更後もUndo約655ms、移動約697ms、50履歴移動最大約1.55秒であり、大図面が快適になったという完了判断はしない。

変更後1000配置のScriptDuration中央値は移動約622ms、Undo約576ms。Layout／RecalcStyleDurationは各約2〜3msで、スクリプト側が依然大きい。次はSvelte更新・canonical比較・snapshot等のサンプリングprofileを採り、実際のcall stackを根拠に候補を絞る。Node値からの差し引きでSvelte分を推定しない。差分Undo・大域cache・検証省略は引き続き未採用。

3規模すべてで保存Project・PNG4原本が一致し、変更前後のText投影も完全一致した。資産なし図面への3回の切替後にlive URL／bytesは0、一時文字計測DOMも0。1000配置のGC後ヒープは50履歴の前約141.3MB→後194.5MB、最後の資産なし図面では約15.1MBで、履歴資源の大幅な削減はしていない。画面エラーは0だった。

型チェックはエラー・警告なし、全単体1107件、履歴・キー操作のブラウザ9件、本番build・全体整形が成功した。Undo／Redoの不正snapshot・不正な現在状態・revision上限超過でProject／履歴を保持し、改行正規化・独立した復元候補も単体で確認した。実装`27f10b9`の[全体CI39545209042](https://github.com/tyaro/temp-scada/actions/runs/39545209042)でFrontend・Rust・ブラウザ4分割・集約checkがすべて成功した。I5bは内訳計測と履歴候補の限定改善を保存する区切りで、スクリプト内の詳細切分けは残る。

## I5c：Project snapshotの監視境界

`a17fc96`の1000配置を別のsource map付き本番buildで診断した。移動9回／Undo9回を別々にCPU sampling（1ms間隔）し、生成位置をsource mapで元ファイルへ対応付ける。sampling中はドライバー待機・idle・GCも含むため、通常runnerの入力遅延とは比較しない。inclusiveの集計は祖先を含み重複するので合計しない。source mapの位置は関数開始位置で、個別のhot statementの特定ではない。

移動profileは約10.13秒相当のsamplesで、Svelte task／batchを含むinclusiveが約5.48秒、runtime約5.11秒。Undoは約7.77秒中、task／batch約4.35秒、runtime約4.04秒。`update_reaction`・`remove_reaction`・`mark_reactions`・proxy getがself時間の上位に現れた。これをSvelte内部の不具合とは扱わず、アプリの監視範囲を見直す根拠とする。

現行AppのProject変更入口を確認すると、初期parse、`recordEdit`、`travelHistory`、file／new／sampleの`adopt`が検証済みの独立したProjectを返し、Appがルートを差し替える。数値確定も同じrecordEdit経由で、子コンポーネントは編集通知を返す。UIからProjectの内部を直接書き換えるbindingはない。保存baseline・asset lease・非同期generationの契約は維持する。

採用する限定変更はAppのProjectと確認待ちreplacementを`$state.raw`にする2箇所。replacementはconfirm時にProjectを渡すため、ここだけ深いproxyが残らないよう同じ境界に揃える。rawはimmutableを強制するfreezeではない。今後もProject変更はcommand／history／adoptで独立候補を作ってルート更新し、ネストした直接代入で変更を通知しない実装を追加しない。選択・draft・パネル等のUI state、ドメイン検証、履歴・JSON・保存モデルは変更しない。

### 診断の再現

通常benchmarkで生成した公開fixtureのpackageを使用する。別の出力先にsource map付きbuildを作る。アプリへ診断分岐や計測用APIは追加しない。

```sh
source scripts/cloud-env.sh
pnpm --filter banto-scada exec vite build --sourcemap --outDir /tmp/scada-profile-build
pnpm --filter banto-scada exec vite preview --outDir /tmp/scada-profile-build --port 5234 --strictPort
# 別ターミナル。CPU採取は通常benchmarkやbuild・テストと並走させない。
node apps/banto-scada/scripts/profile-editor.mjs /tmp/scada-mixed-quality/mixed-1000.bantoscada /tmp/scada-profile 1000
node apps/banto-scada/scripts/summarize-editor-profile.mjs /tmp/scada-profile/move.cpuprofile /tmp/scada-profile-build > /tmp/scada-profile/move-summary.json
node apps/banto-scada/scripts/summarize-editor-profile.mjs /tmp/scada-profile/undo.cpuprofile /tmp/scada-profile-build > /tmp/scada-profile/undo-summary.json
```

診断runnerの既定URLは`http://localhost:5234`で、`SCADA_PROFILE_URL`で変更できる。source map readerは固定中のSvelte compilerが既に依存する`source-map-js`をSvelteの解決元から使い、新しい依存は追加しない。Svelte依存更新時はこの診断ツールの解決も再確認する。通常の速度評価はsource mapなし本番buildで既存benchmarkを別途実行する。

### I5cの結果と採用範囲

[profile集計・source hash](i5c-profiles.json)に、前後の生CPU traceへのリンク相当のファイル名とsource map hashを残した。移動9回のSvelte batch inclusiveは約5.48→2.05秒、Undo9回は約4.35→2.20秒になった。ドライバー・GCを含む採取ごとの時間も違うため、この数値を入力応答の短縮率とはしない。深い監視の費用を減らす根拠として、通常benchmarkと別に判断する。

[変更前の通常JSON](i5b-browser-after.json)と[変更後の通常JSON](i5c-browser-after.json)。表は各9回（再読込／保存3回、連続移動50回）の中央値、ms。各1runで、統計的有意性は評価していない。

| 操作             | 100配置（前→後） | 500配置（前→後） | 1000配置（前→後） |
| ---------------- | ---------------: | ---------------: | ----------------: |
| 再読込           |         747→1015 |        5906→5138 |       15872→26973 |
| キー移動         |            70→46 |          307→165 |           697→497 |
| Undo             |            60→36 |          277→166 |           655→410 |
| 50履歴を積む移動 |            74→57 |          325→197 |           709→514 |
| 保存download開始 |            52→60 |           148→82 |           232→161 |

1000配置の再読込増加を採用前に追加確認した。[A/B/B/Aの生JSON](i5c-load-comparison.json)は、各contextで初回読込＋再読込1回を実行した値。再読込は順に変更前29.1秒／変更後24.9秒／変更後21.4秒／変更前16.6秒。各2件の算術平均は変更前約22.8秒、変更後約23.1秒で、通常runの約15.9→27.0秒という増加を一貫して再現したとは判断しない。サンプルが少なく、読込非劣化の保証でもない。大規模図面の読込自体は依然遅く、ここで解決したとは扱わない。

この対照buildは作業ツリーを巻き戻さず、[専用Vite config](i5c-baseline-vite.config.mjs)のloaderで対象2ファイルだけを`a17fc96`から読み出した。他の実行時コードが同じI5c候補ツリー上で使う比較専用であり、任意の将来版全体をa17fc96に復元するものではない。変更前main asset名`index-fjnTrq38.js`は初回profileと一致した。通常buildと別の出力先・portにし、ローカルのbuild・test・profileを比較実行と並走させていない。

```sh
source scripts/cloud-env.sh
pnpm --filter banto-scada exec vite build --config ../../docs/performance/i5c-baseline-vite.config.mjs --outDir /tmp/scada-before-build
pnpm --filter banto-scada exec vite preview --outDir /tmp/scada-before-build --port 5235 --strictPort
# 通常buildのpreview（5233）も起動したうえで別ターミナルから実行。
node apps/banto-scada/scripts/compare-editor-load.mjs /tmp/scada-mixed-quality/mixed-1000.bantoscada /tmp/scada-load-comparison.json http://localhost:5235 http://127.0.0.1:5233 1000
```

通常runの3規模とも保存Project・PNG4原本が一致し、1000配置の文字投影は変更前との許容差0.0001図面単位の比較を通過した。資産なし図面への3回の切替でlive URL／bytesは0、一時文字計測DOMも0。画面エラーは0。内容・資産寿命・履歴形式は維持する。1000配置は変更後も移動約497ms／Undo約410msで、十分な応答性能の完了とはしない。

型チェックはエラー・警告なし、全単体1107件、保存状態・未適用入力・履歴・キー操作のブラウザ17件、本番buildが成功した。確認置換後の編集・Undo／Redoと読込baselineの表示も既存試験へ追加した。root差替え契約を維持できる範囲で採用し、実装`fa595d0`の[全体CI39548196580](https://github.com/tyaro/temp-scada/actions/runs/39548196580)でFrontend・Rust・ブラウザ4分割・集約checkがすべて成功した。Project0.33.0、Banto、Industrial SDK、認証の保留方針は不変。次はI5の読込時のstyle／文字計測費用を再評価し、適応的文字計測の回数やcacheを先行変更せずに対象を絞る。

## I5d：単一行Textの計測診断と候補評価（変更見送り）

I5c後の`1e86740`を基準に、読込時の`getBBox`を診断runnerで分類した。図面外の計測host内と図面内の呼出しを分け、native呼出しの経過時間（内部の同期style／layoutを含む）とCDP差を記録する。wrapperによる診断負荷があるため、通常の読込速度として扱わない。記録は初回読込と同一図面の再読込の2回で、合計やCDP指標からSvelte時間を差し引かない。

1000配置の再読込は、複数行Textの隔離済み呼出し14,000回、図面内の単一行Textが2,400回だった。ソース内のnative呼出し元も`TextPrimitive.svelte`と既存`svg-text-measure.ts`に限られ、少ない図面内呼出しが大きなnative時間を使っていた。両テーマ等の計測を変えず、まずこの残る図面内probeを減らす。

候補は`TextPrimitive.svelte`から既存`withSvgTextMeasure`へ接続するだけ。static単一行・数値／Quality・機器プロパティ・共有Symbolの共通描画が対象になる。`fitText`の省略規則、数値overflow、元の文字列、SVGのfont／座標変換、非表示時の再試行、font loadingdone／loadingerror時の再計測、finallyでのprobe解放を維持する。文字計測回数・cache・描画済み結果の保持・Project／Undo形式は変えない。Shadow DOMや別documentはこの区切りでは導入しない。

単一行fitの両テーマ比較を追加し、SVG倍率2種・weight2種・6文字列・numeric2種・width3種・height2種の288条件ずつで、従来の図面内計測と文字列／表示モード一致、baseline／left／inkWidthの誤差0.0001図面単位未満を要求する。既存の変換・寸法・失敗時解放、text-style・複数行・設備メタデータのブラウザ回帰も実行する。

```sh
source scripts/cloud-env.sh
# source map不要。通常buildのpreviewを別ターミナルで起動する。
node apps/banto-scada/scripts/profile-text-load.mjs /tmp/scada-mixed-quality/mixed-1000.bantoscada /tmp/scada-text-load.json 1000
```

診断runnerのURLは既定`http://127.0.0.1:5233`、`SCADA_PROFILE_URL`で変更する。wrapperは通常実装を呼び出した戻り値をそのまま返し、browser context終了で破棄する。本番アプリへ診断分岐は追加しない。400個の実描画Textのmode・原文ラベル・描画内容・x／yも保存し、複数行だけでなくSymbol内の単一行も前後比較する。

### I5dの結果と見送り判断

[診断の生JSON・400 Textの投影](i5d-text-load.json)、[候補の通常benchmark](i5d-browser-candidate.json)、[候補patch](i5d-candidate.patch)を保存した。初回の採取と再読込で呼出し数に差があるため、同じ再読込同士を比べる。基準は隔離14,000回＋図面側2,400回、候補は隔離16,400回＋図面側0回で、合計は変わらなかった。native累積は基準約1.86秒＋4.08秒、候補約3.13秒。ただしCDPのLayoutCountは17,606→18,006で、host作成・transform／fontの準備などnative以外の費用もある。native getBBox時間だけから全体の改善とは判断しない。

400 Textのmode・原文ラベル・描画文字列は一致し、x／yの最大差は`0.00000095367431640625`図面単位で、許容差0.0001以内だった。関連ブラウザ35件、型チェック、単体1107件、本番buildは候補コードで成功した。静的単一行・数値overflow・font再読込・非表示復帰・共有Symbol／ミニマップ／埋込／小窓・機器情報を含む。保存Project・PNG原本、一時DOMとURL解放も通常benchmarkの3規模すべてで成功した。表示品質の比較は通過したが、速度面の採用条件は別に判断する。

表は[基準の通常JSON](i5c-browser-after.json)→[候補JSON](i5d-browser-candidate.json)の中央値、ms。各1run、再読込／保存3回、移動／Undo9回、連続移動50回。未変更の保存等にも大きな差があり、統計的な有意性は評価していない。

| 操作             | 100配置（基準→候補） | 500配置（基準→候補） | 1000配置（基準→候補） |
| ---------------- | -------------------: | -------------------: | --------------------: |
| 再読込           |            1015→1863 |            5138→7956 |           26973→18945 |
| キー移動         |                46→63 |              165→220 |               497→402 |
| Undo             |                36→57 |              166→166 |               410→402 |
| 50履歴を積む移動 |                57→61 |              197→257 |               514→472 |
| 保存download開始 |                60→56 |               82→173 |               161→365 |

1000配置だけで判断せず、[同じ時間帯のA/B/B/A](i5d-load-comparison.json)も実行した。再読込は順に基準18.0秒／候補18.3秒／候補25.6秒／基準18.9秒。各2件の算術平均は基準約18.4秒、候補約21.9秒だった。初回読込も基準14.2／12.6秒、候補14.3／14.3秒で、改善を示していない。この少数試験で一般的な悪化率を断定はしないが、一律置換を採用する根拠も得られなかった。

**今回の候補は採用せず、`TextPrimitive.svelte`は基準の直接計測へ戻した。** 現行アプリの文字描画・Project・Undo・保存・上流SDKは変わらない。診断runner、単一行fitの寸法比較試験、候補patchと結果を残す。I5dは切分けと候補評価の完了であり、読込性能の改善完了ではない。次は計測回数やcacheを先に変えず、style／layoutを局所化する別の候補を設計し、同じ寸法・資源・読込の基準で比較する。

### 候補を作業ファイルへ書き戻さず再現する

[比較専用config](i5d-comparison-vite.config.mjs)は、既定ではTextPrimitiveの`1e86740`をVite loaderへ渡す。`SCADA_I5D_TEXT_SOURCE`指定時は再生した候補ファイルを使う。このI5d評価時の他の実行時コードが同じツリー上で使い、任意の将来版を丸ごと基準へ戻すconfigとしては扱わない。通常のvite.configや本番起動からは読み込まない。

```sh
source scripts/cloud-env.sh
git show 1e86740:apps/banto-scada/src/lib/TextPrimitive.svelte > /tmp/scada-i5d-original.svelte
patch --output /tmp/scada-i5d-candidate.svelte /tmp/scada-i5d-original.svelte docs/performance/i5d-candidate.patch
pnpm --filter banto-scada exec vite build --config ../../docs/performance/i5d-comparison-vite.config.mjs --outDir /tmp/scada-i5d-before
SCADA_I5D_TEXT_SOURCE=/tmp/scada-i5d-candidate.svelte pnpm --filter banto-scada exec vite build --config ../../docs/performance/i5d-comparison-vite.config.mjs --outDir /tmp/scada-i5d-candidate
# それぞれのpreviewをport 5237／5238で別途起動して比較する。
node apps/banto-scada/scripts/compare-editor-load.mjs /tmp/scada-mixed-quality/mixed-1000.bantoscada /tmp/scada-i5d-comparison.json http://localhost:5237 http://localhost:5238 1000
```

patch再生後のsource hashは診断JSONの候補hashと一致した。作業ツリーのTextPrimitiveは変更しない。source overlayも含めて独立した出力先を使い、build・test・CPU採取を通常benchmarkと並走させない。候補を戻した最終差分でも寸法試験4件・通常build・整形が成功した。候補を作業ファイルへ戻さずconfigからbuildする再現手順も実行し、通常buildのmain assetは基準の`index-Cu0HSCLM.js`へ戻っている。最終差分`94078be`の[全体CI39553076790](https://github.com/tyaro/temp-scada/actions/runs/39553076790)でFrontend・Rust・ブラウザ4分割・集約checkがすべて成功した。

## I5e：計測用SVGのstyle tree分離（変更見送り）

基準`9563504`。I5dの単一行一律置換は採用せず、今回は既存の複数行計測hostだけをclosed ShadowRootへ分離する候補を調べる。TextPrimitiveは直接計測を維持する。変更箇所はhelperの`host.append(svg)`から`host.attachShadow(...).append(svg)`への1箇所で、fontのcomputed値コピー・SVG座標変換・計測回数・折返しアルゴリズム・cache・finally解放を変えない。

ShadowRootは同じdocument内に作り、iframeや別document・別FontFaceSetは導入しない。外部selectorの適用範囲は変わるため、元SVGとのfont／寸法一致を採用条件にする。既存の両テーマ・SVG／CSS変換・単一行fit288条件・非表示と失敗時解放に加え、`document.fonts`へ動的に追加したFontFace（size-adjust 200%）も同じ寸法で使う回帰試験を追加した。ローカルのArial／Liberation Sans／DejaVu Sansを候補とし、ネットワークからfontを取得しない。

まず29件の文字関連ブラウザを実行し、追加fontを含む寸法5件を再確認した（計30件の異なるケース）。型チェックはエラー・警告なし、本番buildも成功した。これは品質条件の確認であり、速度改善や採用の完了ではない。

性能は同じ1000配置のpackageで基準／候補／候補／基準を順に読み込む。基準はI5dの対照build（main `index-Cu0HSCLM.js`）で、`9563504`までの実行時コードと同一。候補だけShadowRootへ変える。重いローカルbuild・test・診断採取と通常の読込比較を並走させず、各contextの初回＋再読込を記録する。読込全体の効果が見えなければ採用しない。

### 結果と保存した再現資産

[交互比較の生JSON](i5e-load-comparison.json)で、再読込は基準22.5秒／候補24.4秒／候補22.8秒／基準20.4秒。各2件の算術平均は基準約21.5秒、候補約23.6秒だった。初回読込も基準17.8／13.1秒、候補24.6／18.8秒で改善を示さない。少数試験から一般的な悪化率は断定しないが、採用の根拠は得られなかった。

**候補は採用せず、helperを基準へ戻した。実行時ソースの差分はない。** 動的FontFaceの回帰試験、[候補patch](i5e-candidate.patch)、[比較config](i5e-comparison-vite.config.mjs)を残す。最終基準コードでも寸法5件・全単体1107件・通常buildが成功した。patchを作業ツリーへ戻さずconfigから再buildし、基準main `index-Cu0HSCLM.js`と候補main `index-Bi7vBIUY.js`、候補source hashの一致を確認した。

```sh
source scripts/cloud-env.sh
git show 9563504:apps/banto-scada/src/lib/svg-text-measure.ts > /tmp/scada-i5e-original.ts
patch --output /tmp/scada-i5e-candidate.ts /tmp/scada-i5e-original.ts docs/performance/i5e-candidate.patch
pnpm --filter banto-scada exec vite build --config ../../docs/performance/i5e-comparison-vite.config.mjs --outDir /tmp/scada-i5e-before
SCADA_I5E_MEASURE_SOURCE=/tmp/scada-i5e-candidate.ts pnpm --filter banto-scada exec vite build --config ../../docs/performance/i5e-comparison-vite.config.mjs --outDir /tmp/scada-i5e-after
# 両方のpreviewを5237／5238で別途起動する。
node apps/banto-scada/scripts/compare-editor-load.mjs /tmp/scada-mixed-quality/mixed-1000.bantoscada /tmp/scada-i5e-comparison.json http://localhost:5237 http://localhost:5238 1000
```

比較configは、この評価時と他の実行時コードが同じツリーで使う。将来版全体を巻き戻すものではない。I5eでは100／500／1000の通常benchmark、native呼出し分類や400 Text投影を再採取していない。それらの既存記録をI5eの結果に読み替えない。

I5の限定改善・候補評価はここで一区切りとする。大図面の読込・キー操作の遅延は既知課題として残し、次に再開する場合は新しい仮説と同じ品質条件を先に定める。次の機能工程は[I6：参照名の一括置換](../design/equipment/text-reference-replacement-design.md)の計画へ移る。Project0.33.0・Banto／Industrial SDK・認証延期は維持する。

実装差分`f8bbdc9`の[全体CI39555810579](https://github.com/tyaro/temp-scada/actions/runs/39555810579)でFrontend・Rust・ブラウザ4分割・集約checkがすべて成功した。

## I5f：現行版の再計測と画像Map更新の候補（変更見送り）

基準はI8完了後の`e9c5d46`、Project0.35.0。公開fixtureを現行形式で再生成し、本番build `index-BQZZi5es.js`で1,000配置を計測した。[通常の生JSON](i5f-browser-before.json)では、再読込中央値17,176ms、移動413ms、Undo438ms、50履歴の移動478ms。保存Project／PNG原本・200 Textの投影（過去基準との差0）・URLと計測DOMの解放は成功した。I7／I8で増えた機能を含む現行版の確認であり、過去版との速度差から因果関係を主張しない。

[CPU診断のsource map集計](i5f-profiles.json)では、移動／Undo各9回でSvelte batch inclusive約2.02／2.06秒、mark_reactions self約330／389ms、AppのcollectAssets self約93／185msが見えた。samplingにはdriverのidle・native処理が含まれ、inclusiveは重複する。通常応答時間と相互に差し引かず、アプリ側の依存と反復処理を調べる根拠にする。診断時に既定port5234の旧サーバーを検出し、その試行は除外して専用port5344と現行asset名の一致を確認後に採取した。通常計測とbuild・試験・CPU採取は並走させていない。

候補は、Appの`assetImages`の依存を`[id, sha256, width, height]`のJSON文字列とStoreに分けるもの。幾何だけ変わる編集で同内容のMapを再生成しない。Store変更時は必ず再生成し、asset collection・history・検証を変更しない。Astraも限定評価として妥当と判断したが、主因と断定せず交互比較した。

[交互比較の生JSON](i5f-load-key-comparison.json)は基準／候補／候補／基準、各新contextで初回読込・再読込・warmup後9移動・9 Undo。単一環境の少数試行で、統計的有意性は評価していない。基準／候補をまとめた値は次のとおり。

| 操作                             |         基準 |         候補 |
| -------------------------------- | -----------: | -----------: |
| 再読込（各2件の平均、ms）        |     16,737.5 |     15,505.1 |
| 移動（各18件の中央値／平均、ms） | 347.9／357.8 | 345.1／392.8 |
| Undo（各18件の中央値／平均、ms） | 333.3／339.8 | 330.2／366.2 |
| 移動の最大値（ms）               |        428.2 |        701.3 |
| Undoの最大値（ms）               |        520.6 |        821.1 |

**応答改善の根拠を得られず候補は採用しない。Appの画像Mapは基準へ戻した。** 再読込の少数値だけで採用せず、中央値がほぼ変わらず平均・最大が増えた移動／Undoも判断に含める。改善率・一般的な悪化率を保証する計測ではない。

### 再現と保持した検証

`compare-editor-load.mjs`は従来の読込専用モードを維持し、`--keys`で信頼されたkeydownからtransform更新＋2rAFまでを測る。9移動・9 Undo後の位置復元と画像URL不変をassertする。追加の`--history`は50回確定して全変位を確認する。閾値をCIの成否条件にはしない。`symbol-image.spec.ts`へ、同一package再読込時の新StoreのURL・古いURLの解放、幾何編集／Undo中のURL保持と原画素一致の回帰を追加した。

[候補patch](i5f-candidate.patch)と[比較専用config](i5f-comparison-vite.config.mjs)はAppのsourceだけをloaderへ渡す。通常起動からは読み込まない。他の実行時コードが同じ評価ツリーで使い、任意の将来版全体を巻き戻すconfigではない。

```sh
source scripts/cloud-env.sh
git show e9c5d46:apps/banto-scada/src/App.svelte > /tmp/scada-i5f-original.svelte
patch --output /tmp/scada-i5f-replayed.svelte /tmp/scada-i5f-original.svelte docs/performance/i5f-candidate.patch
SCADA_I5F_APP_SOURCE=/tmp/scada-i5f-replayed.svelte pnpm --filter banto-scada exec vite build --config ../../docs/performance/i5f-comparison-vite.config.mjs --outDir /tmp/scada-i5f-replay
# 基準・候補previewを別portに起動してから実行する。
node apps/banto-scada/scripts/compare-editor-load.mjs /tmp/scada-i5f-before/mixed-1000.bantoscada /tmp/scada-i5f-abba.json http://127.0.0.1:5233 http://localhost:5345 1000 --keys
```

<a id="history-asset-index"></a>

## I5g：保持中履歴の資産hash索引（限定改善・CI成功）

I5fで観測した`collectAssets`の全履歴JSONの反復parseだけを対象にする。索引はAppインスタンス専用で、snapshot文字列そのものをキーとする。現在のpast／futureに含むsnapshotのhash配列だけを保持し、毎回現在の集合へ作り直して脱落entryを捨てる。現在Projectのassetsは毎回直接読む。Store／Blob／URL／leaseは索引へ保持しない。

全snapshotの抽出成功後にStore.collectを呼び、成功後だけ索引を置き換える。抽出途中の失敗ではStoreも索引も変わらない。索引は参照集合の導出結果であり、検証済みの証明には使わない。Projectの入口・command・履歴復元・保存の検証、JSON snapshot、Undo単位・上限、Storeのpinと保存中leaseは変更しない。大域cacheや汎用memo基盤は追加しない。

`history-assets.test.ts`で現在／past／futureの和集合、現在参照の再読取、Undo／Redo間の再利用、Redo破棄、履歴上限での脱落と再導入、抽出失敗の原子性、history初期化、インスタンス分離、外部Set変更からの保護を確認する。通常計測では短い履歴と50履歴を分けて評価し、改善が確認できなければこの候補も戻す。

### I5gの測定結果と採用範囲

[交互比較](i5g-load-key-comparison.json)はA／B／B／Aの各contextで初回＋再読込、warmup後の移動9回・Undo9回・連続移動50回を測った。個々の試行でばらつきがあり、基準の初回読込36.8秒・連続移動10.3秒、候補の短い履歴の移動1.07秒などの外れ値も省かず保存した。統計的有意性や一般的な性能保証ではない。

| 操作                                 |     基準 |     候補 |
| ------------------------------------ | -------: | -------: |
| 再読込（各2件の平均、ms）            | 15,745.8 | 18,746.8 |
| 短い履歴の移動（各18件の中央値、ms） |    344.8 |    362.5 |
| Undo（各18件の中央値、ms）           |    387.8 |    327.6 |
| 50連続移動（各100件の中央値、ms）    |    414.4 |    350.2 |

**短い履歴の移動と再読込はこの比較で悪化した。全操作の改善や読込非劣化は主張しない。** 50連続移動の各context中央値は、基準374.1／476.0ms、候補345.9／351.8ms。保持履歴が長い集計処理の削減に絞って評価する。

別の[通常benchmark](i5g-browser-after.json)では100／500／1,000配置を測定し、3規模とも保存Project・PNG4原本bytes・エラーなし・資産なし図面への3回切替後のlive URL／bytes 0・計測DOM 0を確認した。1,000配置の200 Textのmode・行内容・x／yはI5f基準と一致した。通常の1,000配置は移動342ms・Undo337ms・50履歴移動348ms。比較するI5fの各値は413／438／478msだが、別runの値だけから改善率を保証しない。100／500配置には同時間帯の基準runを追加しておらず、速度比較とは扱わない。

GC後の1,000配置・50履歴のJSヒープは基準179,287,708 bytes、候補179,292,124 bytes（差4,416 bytes）。索引は現在保持するsnapshot文字列とhash配列だけを参照し、画像原本のURLは50履歴前後とも4件・133,898 bytesで不変。短い試行のJSヒープは全ブラウザ・GPU資源の計測や長時間リークの不存在証明ではない。

[履歴満杯時のCPU診断](i5g-profiles.json)は、採取前に50回の移動を確定し、続く9移動・9 Undoを別々に1ms間隔でsamplingした。資産回収関数のinclusiveは移動約925→29ms、Undo約1,007→33ms。候補のApp wrapperとhistory-assetsの値は重複するので合算しない。厳密な関数実行時間でも、通常の入力遅延の短縮率でもない。未変更のSvelte更新等は依然大きい。

**反復する資産抽出の削減と、長い履歴での通常操作の結果を根拠に、資産索引だけを限定採用する。** Project／Undo全体、読込、短い履歴の速度改善完了とはしない。I5fの画像Map候補は戻したまま。入力・保存・履歴復元の検証、Storeのpin／leaseや上流依存を変更しない。

### I5gの再現と受入

```sh
source scripts/cloud-env.sh
# 同じ評価ツリー上の基準／候補の通常buildを別portで起動する。
node apps/banto-scada/scripts/compare-editor-load.mjs /tmp/scada-i5f-before/mixed-1000.bantoscada /tmp/scada-i5g-abba.json http://127.0.0.1:5233 http://localhost:5346 1000 --keys --history
SCADA_BENCHMARK_URL=http://localhost:5346 SCADA_BENCHMARK_BASELINE=docs/performance/i5f-browser-before.json node apps/banto-scada/scripts/benchmark-mixed-editor.mjs /tmp/scada-i5g-after 100 500 1000
# CPU採取はsource map付きの別buildで、通常benchmark・build・試験と並走させない。
SCADA_PROFILE_URL=http://localhost:5347 node apps/banto-scada/scripts/profile-editor.mjs /tmp/scada-i5g-after/mixed-1000.bantoscada /tmp/scada-i5g-profile 1000 --history
node apps/banto-scada/scripts/summarize-editor-profile.mjs /tmp/scada-i5g-profile/move.cpuprofile /tmp/scada-i5g-profile-build 'collectAssets|history-assets'
```

profile runnerの`--history`は事前投入50件をmetadataへ残す。summarizerの任意function filterは上位30件の圏外でも指定した関数を記録する。いずれも通常アプリには計測API・分岐を追加しない。JSON内のcommitは計測開始時のHEADで、未コミット候補のsource hashは別のprofile記録に示す。両buildはAppとhistory-assets以外の実行時ソースを揃えた。

TS全1,214件（資産索引の新規7件を含む）、型チェック（エラー・警告0）、関連ブラウザ40件、本番build・整形・文書リンクが成功した。Storeのpin／export leaseの単体、実画像のUndo後の新規編集によるRedo原本の解放、50件目での旧原本の解放・49件目までの保持、保存原本の一致、同一package再読込時の新StoreへのURL切替、Symbol内画像・原本付きclipboard・保存状態の既存回帰を確認した。

I5fのpatch再生後のsource hashは記録と一致し、比較専用configでbuildしたmain asset `index-DZP628Bn.js`は元の候補buildとバイト一致した。現行の通常mainは資産索引だけを含む`index-B9CfaS6j.js`。Astraの安全性／採用レビューに必須修正なし。実装`01d5df0`は[全体CI39589758815](https://github.com/tyaro/temp-scada/actions/runs/39589758815)でFrontend・Rust・ブラウザ4分割・集約checkがすべて成功した。

保存版0.35.0・Rust／schema・固定Banto／Industrial SDKは変更していない。今回は履歴資産集計の限定改善で区切る。大図面の読込とSvelte更新の費用は残課題とし、次回も新しい診断の根拠から別候補を選ぶ。

<a id="load-diagnostics-i5h"></a>

## I5h：読込・再読込の診断と計測処理の切り分け（2026-10-21）

状態: **診断完了。アプリの性能改善は未実施**。アプリ`daf5760`（直近実装`01d5df0`）、Project0.35.0のまま、既存の100／500／1,000配置packageを同じproduction sourceから作った通常buildとsource map付きbuildで計測した。[生の計測値・CPU集計・source／build／原本SHA](i5h-load-diagnostics.json)を保存する。Linux6.18.55、Xeon Platinum8573C、Node24.19.0、Chromium154.0.8037.57、viewport1920×1080。

### 計測方法

`profile-editor-load.mjs`を追加し、初回取込と同一package再読込に限定した。coldはエディタ起動完了後の初回Project取込で、ブラウザ起動やネットワークcold cacheの意味ではない。file input差替え完了・配置数・Text pending解消・font ready・全画像decode・2rAFを待つ。GC後heap、画像原本SHA、文字投影、旧URL解放は時間計測の後に確認する。

`--cpu`は別buildで1ms samplingする診断で、通常時間と比較しない。新しい`--direct-file-query`は、入力欄を`getByLabel`の全体検索から`input[type=file][aria-label]`へ絞る**計測側だけの差分**。操作・待機条件・アプリは同じ。初回はpreviewのlocalhost待受に127.0.0.1で接続して失敗し、取込前に終了した。その試行は計測値を生成せず、localhostへ揃えて再実行した。

### 通常buildの観測値

| 配置数・入力欄の検索 | 初回取込ms | 再読込ms |
| -------------------- | ---------- | -------- |
| 100・label           | 975.9      | 807.3    |
| 500・label           | 5,107.1    | 5,516.7  |
| 1,000・label初回run  | 11,234.0   | 16,184.1 |
| 1,000・label再試行   | 11,970.9   | 18,201.9 |
| 1,000・direct        | 14,495.5   | 18,833.1 |

各runで初回・再読込は1観測ずつ。label／directは交互比較ではなく、時間変動も大きい。**direct queryへの変更で読込時間が改善したとは判断しない**。過去のI5g値との単純差も改善率にしない。

通常label初回runの再読込では、100／500／1,000配置のLayoutCountは965／8,006／17,606、RecalcStyleDurationは約0.10／1.36／5.92秒だった。Task／Script／Layout／RecalcStyleの時間は重なるので合算しない。増加は反復する文字計測・style／layoutを調べる根拠であり、これだけで計算量やSvelteの欠陥を断定しない。

### CPU診断で分かった呼出元

`summarize-editor-profile.mjs`に、`getBBox`・`document.fonts.ready` getter・`getClientRects`のnative self sampleを最も近いsource map付きcallerへ集計する出力を追加した。従来のfile／function集計は維持する。inclusiveは重複するが、下表のnative self sampleは呼出元を分けている。samplingの重み付き時間であり、正確な関数実行時間ではない。

| 再読込の呼出元                                               | label診断ms | direct診断ms           |
| ------------------------------------------------------------ | ----------- | ---------------------- |
| Playwright `getElementLabels` self                           | 4,053       | 上位self集計に現れない |
| `TextPrimitive`からの`getBBox` self                          | 3,963       | 3,945                  |
| `svg-text-measure`からの`getBBox` self                       | 1,433       | 1,432                  |
| `TextPrimitive.onMount`からのfont ready getter self          | 1,347       | 1,280                  |
| `MultilineTextPrimitive.onMount`からのfont ready getter self | 704         | 723                    |
| `withSvgTextMeasure`からの`getClientRects` self              | 647         | 745                    |

label診断で計測ツール自身のラベル検索が目立った。directはその経路を避けるが、全体時間の短縮は確認できていない。一方、両経路で文字寸法とfont ready取得の費用は残る。label再読込の`readProjectFile` inclusiveは約34ms、`parseProject`は約18msで、今回のsamplingでは主因ではない。これらもnativeや通常時間から差し引かない。

CPU採取の初回／再読込はlabel約12.0／16.1秒、direct約24.2／11.7秒で、外れた値も記録した。direct採取中に短いrunner整形・構文確認が重なっているため、そのwall timeも比較根拠にしない。アプリbuild・通常benchmark・アプリ試験は採取と並走していない。

### 品質確認と次の候補

7runすべてで初回と再読込の文字投影が完全一致し、100／500／1,000配置で40／200／400 Text、4原本のSHAとbytesが入力package宣言に一致した。再読込後の旧4URLは解放され、一時計測hostは0、pageerrorなし。1,000配置の全runで同じ文字投影SHAだった。これは同一buildの読込間一致であり、別実装との見た目比較ではない。2回のGC後heapだけで長時間リークの不存在を保証しない。

次候補は**文字componentごとのfont ready取得と再計測通知のまとめ方**を最小変更で比較すること。現在の呼出元を確認できたが、改善実装・採用はまだしていない。font loadingdone／loadingerror、非表示復帰、theme・倍率・文字の一致とcleanupを維持し、既に見送った単一行probe隔離を根拠なく再採用しない。大域cache・検証省略・Undo方式変更・上流依存更新は行わない。

### 再現

既存の`benchmark-mixed-editor.mjs`で生成したpackageを使う。通常buildとCPU用buildはそれぞれpreviewを起動し、診断と通常計測は順番に実行する。

```sh
source scripts/cloud-env.sh
pnpm --filter banto-scada exec vite build --outDir /tmp/scada-i5h-normal-build
pnpm --filter banto-scada exec vite build --sourcemap --outDir /tmp/scada-i5h-profile-build
# 別ターミナルで各previewを起動。最初のコマンドは常駐する。
pnpm --filter banto-scada exec vite preview --outDir /tmp/scada-i5h-normal-build --port 5350 --strictPort
pnpm --filter banto-scada exec vite preview --outDir /tmp/scada-i5h-profile-build --port 5351 --strictPort
# 通常計測と、別のCPU診断。
SCADA_PROFILE_URL=http://localhost:5350 node apps/banto-scada/scripts/profile-editor-load.mjs /tmp/scada-i5g-after/mixed-1000.bantoscada /tmp/scada-i5h-normal-1000 1000
SCADA_PROFILE_URL=http://localhost:5351 node apps/banto-scada/scripts/profile-editor-load.mjs /tmp/scada-i5g-after/mixed-1000.bantoscada /tmp/scada-i5h-direct-cpu-1000 1000 --cpu --direct-file-query
node apps/banto-scada/scripts/summarize-editor-profile.mjs /tmp/scada-i5h-direct-cpu-1000/reload.cpuprofile /tmp/scada-i5h-profile-build 'parseProject|readProjectFile|fitText|withSvgTextMeasure'
```

raw cpuprofileとbuildは`/tmp`にあり、repoには集計とSHAを残した。再生成は上記コマンドを使う。追加runnerの構文・整形、source mapの既知fixture（mapped caller／unmapped callerへのnative self振分け）、実ブラウザの7run、文書リンクを確認した。アプリコード・Rust・schemaは変更しておらず、全unit／E2Eの再実行や性能改善の全体CI完了を意味しない。

<a id="font-events-i5i"></a>

## I5i：font準備・通知共有候補のローカル比較（2026-10-22）

状態: **候補評価完了・未採用。アプリの変更なし**。基準`473b0f8`から、単一行・複数行componentの`document.fonts.ready`取得と`loadingdone`／`loadingerror`通知の共有を試した。同一frameの通知をまとめ、最後の購読解除でlistener・予約frameを解放する。文字寸法・fit・非表示時のResizeObserver再試行・保存・Undoは変更しない。[候補コードと6件の単体試験](i5i-font-events-candidate.patch)をpatchに保存し、稼働コードへの接続は戻した。

### 条件・観測・採否

このPCのmacOS・Apple M1・Node24.16.0・既存Chromium148.0.7778.96、Playwright1.64.1、viewport1920×1080で実行。以前のLinux／Chromium154のI5hとは環境が異なるため過去値を改善率にしない。固定lockfileで依存を導入し、依存更新はしていない。

通常production buildを基準／候補に分け、同じ100／500／1,000配置packageと既存runnerの`--direct-file-query`を使う。各runは新しいブラウザで初回Project取込・同一package再読込を1回ずつ計測。1,000配置は基準→候補→候補→基準、100／500配置は各build1runだけ。少数試行であり統計的有意性は評価していない。計測中にbuild・試験は並走していない。

| 配置数・run | 基準 初回ms | 候補 初回ms | 基準 再読込ms | 候補 再読込ms |
| ----------- | ----------- | ----------- | ------------- | ------------- |
| 100         | 220.5       | 260.2       | 215.4         | 214.7         |
| 500         | 1,614.0     | 1,637.2     | 1,763.6       | 1,734.1       |
| 1,000・a    | 5,246.4     | 5,298.8     | 5,918.9       | 5,857.3       |
| 1,000・b    | 5,332.6     | 4,963.1     | 6,125.9       | 5,769.5       |

1,000配置の再読込LayoutCountは14,006→13,606と400減った。一方、RecalcStyleDurationは基準約4.32〜4.43秒、候補約4.26〜4.36秒。全体時間に対する一貫した大きな改善を確認できず、小規模の初回は遅い観測もあるため**候補は採用しない**。各CDP時間は重なるため合算しない。[全8runの必要な計測値・source／build／patchのSHA](i5i-font-events-comparison.json)を保存した。

サンドボックスによるChromium起動拒否と、記録末尾の`spawnSync git`実行パスエラーで終了した試行は表に含めない。ローカルブラウザの実行権限と`PATH=/usr/bin:$PATH`で解消して取り直した。

### 品質確認と未検証

全8runの初回／再読込に加え、規模ごとに**基準と候補の文字投影SHAが一致**した。40／200／400 Textのmode・label・描画文字列・x／yを含む。4画像原本のSHA／bytes、再読込後の旧URL解放、一時計測host0、pageerrorなしも確認。保存操作・長時間運転・実Hub・Windowsはこの読込比較では再検証していない。

候補で型エラー／警告0、単体1,220件（追加6件を含む）、production build成功。文字style・複数行・SVG寸法の関連ブラウザ30件は24成功・6失敗。失敗6件だけを基準コードで再実行し、全件で同じ失敗を確認した。

- `multiline-text.spec.ts:113／333／476`と`text-style.spec.ts:142`：Controlによるnative貼付・コピーが期待どおり進まない。OSショートカット差が原因候補で、今回テスト・入力実装は変更していない。
- `svg-text-measure.spec.ts:59`の両テーマ：隔離probeの寸法比較が許容差0.0001を超え、基準・候補とも最大差199.42047882080078。フォント／ブラウザ差を含めた原因切分けは未実施。

ブラウザ全成功や性能改善提供済みとは扱わない。候補を外したため追加6件もpatch内だけに保存する。最終差分は調査記録・生JSON・候補patchで、Rust／schema／Project0.35.0／固定Banto・Industrial SDKは変更しない。

### 次の判断

まず既存の寸法比較失敗を標準ブラウザ環境でも切り分け、共通の品質基準を確認する。そのうえで、残る`getBBox`・style／layoutの呼出元と反復回数をCPU診断し、根拠から別候補を選ぶ。今回の共有候補や過去の単一行probe隔離は自動採用しない。

<a id="font-ready-batch-i5i"></a>

### 取得集約のみの追加比較（2026-10-22）

状態: **効果なしのため不採用。アプリの変更なし。計測記録のみをPRにまとめる**。`git fetch`・`git switch work`・`git pull --ff-only`後の`473b0f8`から`perf/i5i-font-ready-batch`で計測した。その後のユーザー指示に従い、候補と記録を既存の`perf/font-readiness-batching`へ移した。候補は`font-ready.ts`の`fontReady(document)`に、同一mount batchの`document.fonts.ready`取得だけを共有させる。共有表は次のmicrotaskでgetterを読む直前に破棄し、次のbatchでは現在のfont-loading cycleを取得し直す。フォント準備完了後もcallbackは各componentへ従来どおり通知する。持続的なready／文字寸法cacheや通知のframe集約は入れない。

`loadingdone`／`loadingerror`のlistener、`active`による破棄後callback抑止、ResizeObserverと非表示復帰、既存の計測・fit・listener／frameのcleanupは変更しない。Project0.35.0・依存・Rust／schemaも変更しない。

#### 前後の計測

macOS・Apple M1・Node24.16.0、固定Playwright1.64.1が導入するChrome for Testing156.0.8078.4の完全版をheadlessで使用した。I5hのLinux／Chromium154や、別候補を既存Chromium148で測った値とは混ぜない。通常production build・同じ入力bytes・1920×1080・既存`profile-editor-load.mjs --direct-file-query`で比較。各runは新規ブラウザで初回Project取込・再読込を1回ずつ計測し、1,000配置は基準→候補→候補→基準を2組、各build・phaseで4観測。100／500配置は各1観測だけ。計測中にbuild・試験・CPU採取を並走していない。

| 配置数・観測数     | 初回 基準ms | 初回 候補ms | 再読込 基準ms | 再読込 候補ms |
| ------------------ | ----------- | ----------- | ------------- | ------------- |
| 100・各1回         | 458.5       | 288.7       | 507.7         | 290.3         |
| 500・各1回         | 1,384.9     | 1,309.4     | 1,430.2       | 1,559.3       |
| 1,000・各4回の平均 | 3,685.9     | 3,772.1     | 4,602.8       | 4,681.7       |

1,000配置の初回範囲は基準3,549.3〜3,760.6ms／候補3,622.2〜3,900.3ms、再読込は基準4,450.8〜4,884.2ms／候補4,645.8〜4,738.2ms。初回の標本標準偏差は基準95.3ms／候補118.6ms、再読込は196.4ms／40.4ms。平均で短縮せず、観測範囲も重なった。**一貫した読込短縮を実証できず、効果なしのため不採用とする。** 小規模の単一観測だけで改善と判断しない。統計的有意性は評価していない。

[全12runの必要な計測値・集計に必要なデータ・source／buildのSHA](i5i-font-ready-batch-comparison.json)を保存した。基準の確定buildは元のcomponent2本を復元して順番に作成した`baseline-clean`（既存`index-z42DYoHf.js`と同じ内容）。作成中にソースが変わった最初の仮buildは使用しない。

#### 一致確認・検証・停止後の範囲

全12run・24取込で、規模ごとの文字投影SHAが**基準と候補で一致**した。40／200／400 Textのmode・label・文字列・x／yを含む。4原本のSHA／bytes一致、旧URL解放、一時計測host0、pageerrorなしも確認した。これは当該図面の読込比較であり、theme・倍率・非表示復帰・font loading通知を含む全回帰の代用にはしない。

停止判断前に、取得共有・document分離・次batch／次font-loading cycle・失敗時の再試行を確認する追加単体5件、前後のproduction build、ソースのprettierが成功した。全単体・関連ブラウザ・型チェック・CIは停止後に進めていない。不採用のcomponent変更とhelper／追加テストは元に戻した。本PRは計測記録だけで、候補アプリの採用を含まない。

headless shell156の試行は、初回操作前のタイムアウトとICU／GPUエラーでreportを生成せず比較から除外した。ユーザーから「書類」フォルダ許可を拒否したとの申告があり、再起動でも再表示されなかった。`tccutil reset SystemPolicyDocumentsFolder headless_shell`はbundle未登録で失敗した。他アプリを含む一括リセットは行っていない。完全版Chromeでの有効な比較とは分けて記録する。

#### 締めと次工程

ユーザー指示により本候補は不採用で締め、次は別ブランチでgetBBoxの診断（I5j）を行う。通知集約の単独効果とI5hと同等環境での差は未確認。共有の寿命・通知方式・計測回数・cache・probe隔離を広げるアプリ変更には進まない。

#### 取得集約と通知集約の効果の分離

- **取得集約だけ**：上記のChrome156比較。1,000配置の平均は初回3,685.9→3,772.1ms、再読込4,602.8→4,681.7msで、短縮を確認できない。loadingdone／loadingerrorのlistenerと通知は既存のまま。
- **取得と通知の両方を共有**：先のChrome148比較。文字投影は一致しLayoutCountは減ったが、一貫した大きな読込短縮は確認できなかった。
- **通知集約だけの寄与**：未分離。同じ環境での対照実験ではなく、共有の寿命も異なるため、前後差を引き算して通知集約の効果とは表記できない。停止条件を維持するため追加実験には進まない。

指定ブランチ`perf/font-readiness-batching`には計測記録だけを残す。候補アプリの全回帰が成功したという記録にはせず、記録PRの最終HEADに対するCIで確認する。以前の`5f590e0`に対するCI成功とは区別する。

<a id="getbbox-diagnosis-i5j"></a>

## I5j：getBBoxの同期Layout診断（2026-10-22）

[I5jの結果・候補比較](i5j-getbbox-diagnosis.md)と[集計値](i5j-getbbox-results.json)を追加した。Mac／Chrome for Testing156の1,000配置で、初回13,405回・再読込12,800回のgetBBoxを観測。再読込のtraceでは全12,800回で、probe変更後の同期Layoutが呼出区間内にあった。回数／時間とtraceは通常時間とは分けて扱う。通常・ラッパー・traceの文字投影と原本が一致した。段階的なwrite→readのbatch化を次の検証候補として推奨するが、改善は実装していない。I5hのLinux環境との差と未検証事項を明記した。後続の限定試作はI5kで不採用とした。

<a id="batched-text-measure-i5k"></a>

## I5k：同期の段階バッチ文字計測（2026-10-22）

I5jの`9a2119a`から、独立段落／行の書込→読取を同期の段階ごとにまとめて試作した。同じMac・Chrome156で100／500／1000配置を前後比較し、1000配置は各4run。初回平均3799.2→3758.6ms（−1.1%）、再読込4444.5→4455.1ms（＋0.2%）で範囲が重なり、**明確な短縮なし・不採用。試作コードはpush／PR作成せず、docsのみ記録PRへ取り込む**。

別runの診断ではgetBBox回数・文字投影SHAを維持して、1000配置再読込のgetBBox内同期Layoutありは12800→9600回になった。局所的な削減を読込全体の改善とは扱わない。[試作範囲・前後表・考えられる理由・検証](i5k-batched-text-measure.md)と[集計JSON](i5k-batched-text-measure-results.json)を参照する。
<a id="measurability-dedupe-i5m"></a>

## I5m：可測定性判定の矩形取得削減（2026-10-22）

workの`dba09f2`から、`withSvgTextMeasure`の可測定性判定だけを限定試作した。同じMac／Chrome156の1000配置で通常前後各4run、getter診断各2run。getClientRectsは800→0回になったが、通常平均は初回3328.6→3343.4ms、再読込3917.2→3934.9ms（ともに約＋0.45%）で範囲が重なり、**試作は不採用**。当時はpush／PR作成せず、2026-10-22の追加指示で記録のみを小さいdocs PRへ公開する。試作source・testは元へ戻した。[条件・hidden保護・表・限界](i5m-measurability-dedupe.md)と[集計値](i5m-measurability-dedupe-results.json)を参照。

<a id="font-probe-order-i5n"></a>

## I5n：font準備取得とprobe書込の順序（2026-10-22）

PR #3マージ後のwork `2d09779`から、初回font準備取得を同期文字計測直後・probe片付け前へ移す限定試作を行った。同じMac M1／Chrome156／1920×1080／mixed-1000の通常前後各4runで、平均は初回3821.4→3781.9ms（−1.03%）、再読込4756.3→4533.7ms（−4.68%）。範囲が重なり、最後の組で逆転し、基準側の変動も大きいため、**明確な全体短縮を確認できず不採用**。別runのgetter診断ではfont取得内の時間が減る一方、他の読取内の時間が増えた。試作アプリ・テストは戻し、記録のみ保存する。[変更範囲・採否・検証](i5n-font-probe-order.md)と[集計JSON](i5n-font-probe-order-results.json)を参照。I5mの記録公開は別の[PR #5](https://github.com/tyaro/temp-scada/pull/5)で行う。
