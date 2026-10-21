# I5m：可測定性判定のgetClientRects削減試作

2026-10-22（日本時間）。**全体時間の明確な短縮がなく試作は不採用。** 当時はpush・PR作成せずローカルで締めた。2026-10-22の追加指示により、最新work（`2d09779`）から記録とSTATUS除外だけをdocs PRへ公開する。試作アプリは含めない。 `work`の`dba09f2`から`perf/i5m-measurability-dedupe`を作成し、`withSvgTextMeasure`の入口の判定だけを試作した。計測後にアプリ・試作テストを元へ戻し、記録だけを残した。試作patchはoutputsに保管する。`.gitignore`のSTATUS除外は別コミット`4c41c77`。

## 試作と安全性

通常のSVG viewport／g祖先の現在のdisplay状態と`checkVisibility`を確認できた場合に、後続の既存CTM取得に先立つ重複した矩形取得を省く試作。永続的な可視性の保存や文字metricsのcacheは追加せず、各呼出時点の状態を読む。queue、非同期計測、計測場所・font・SVG変換・getBBoxによる文字探索は変更しない。

事前調査で、`getCTM`／`getScreenCTM`はdisplay:noneでも非nullになり、Chrome156のSVG `checkVisibility`もSVGのgがdisplay:none、またはdefs等の内側でもtrueになる場合を確認した。そのため単独の置換判定には使わなかった。SVG祖先のcomputed displayを確認し、svg／g以外のSVG祖先、shadow tree、display:contents、API未実装／例外、曖昧なvisibility判定は元の`getClientRects`へ戻す。未接続・owner SVGなしは従来どおり拒否する。単純に判定を削除した試作ではない。

両themeの追加ブラウザ試験で、HTML／SVG祖先の非表示と即時復帰、CSS class・CSSOM変更、viewport自身の非表示、未接続、defs／symbol／clipPath／mask／marker／pattern、closed dialog、shadow tree、API未実装／例外、透明・visibility:hiddenなどの従来の可測定性とfallback、host解放を確認した。既存のfont／寸法／倍率・共通描画・hidden thumbnail復帰試験も維持した。ただし別ブラウザすべてのSVG挙動を保証したものではなく、試作は採用しない。

## 同じ条件での前後比較

Mac／Apple M1、Node24.16.0、Playwright1.64.1、同じChrome for Testing156.0.8078.4完全版のheadless、1920×1080。同じI5lの公開1000配置fixture bytesを使用。主図面400 Text、PNG原本4個。macOSのプライバシー設定は変更していない。

基準の通常bundleは`index-z42DYoHf.js`（I5lと同じJavaScript bytes）、候補は`index-Dc4187uk.js`。通常時間は既存runnerのまま前後各4runを「前→後→後→前→後→前→前→後」で採取した。各runは新規ブラウザで初回Project取込と同一package再読込を行う。試験・build等を並走させず、文字計測完了・font準備・画像decode・2 rAFまでを測る。

| 取込   | 前の平均ms | 後の平均ms |      差 | 前の範囲ms     | 後の範囲ms     |
| ------ | ---------: | ---------: | ------: | -------------- | -------------- |
| 初回   |     3328.6 |     3343.4 | ＋0.45% | 3264.2〜3401.1 | 3301.4〜3405.9 |
| 再読込 |     3917.2 |     3934.9 | ＋0.45% | 3807.9〜4105.2 | 3875.2〜4005.6 |

範囲が重なり、平均は両方ともわずかに増加。統計的有意差を示したものではないが、明確な短縮という採用条件は満たさない。今回の絶対値は以前のI5l（約3.8／4.4秒）より小さく、過去値を対照にした引算はしない。同じ期間に取り直した上記の前後だけを比較する。

## getClientRectsの回数と時間

通常時間とは別に前後各2runを「前→後→後→前」で採取。診断ブラウザ内でSVGSVGElementをreceiverにしたnative `getClientRects`だけをwrapし、引数・receiver・戻り値・例外を転送する。計測対象は取込区間のdocument全体。終了時にprototypeを復元する。

| 取込   | 呼出回数 前→後／run | 累積時間 前→後 ms | 1回平均 前 ms | p95 前 ms |
| ------ | ------------------: | ----------------- | ------------- | --------- |
| 初回   |               800→0 | 371.0〜395.5 → 0  | 0.464〜0.494  | 1.1〜1.2  |
| 再読込 |               800→0 | 450.7〜455.9 → 0  | 0.563〜0.570  | 1.2〜1.3  |

後の0はこの通常SVG fixtureで同getterを呼ばなかったという意味で、可測定性判定・Style／Layout・計測が無料になったという意味ではない。fallback経路を含む追加ブラウザ試験では元のgetterが呼ばれることも確認した。`performance.now()`の単発時間には分解能の制約があり、診断runの全体時間は通常表に混ぜない。

矩形getterの回数は削減できたが、現在のCSS状態確認、祖先の走査、既存のCTM／font／文字計測の読取りは残る。同期Style／Layout等の費用が別の読取りへ移った可能性、祖先確認の追加費用は考えられるが、今回それぞれの寄与は個別に測っていない。「getterの約0.4秒を丸ごと短縮した」とは扱わない。中立の結果を受け、範囲を広げた追加最適化は行わない。

## 検証と保存物

- 単体1214件、関連ブラウザ28件（追加2件含む）成功。既存失敗9件は変更せず、該当するclipboard4件と選択書式5件を今回の実行対象から除外した。Issue #4の品質・デバッグ担当へ委ねる。
- 型エラー／警告0、production build成功、試作source／testのPrettier成功。候補patchの保存後、アプリとテストを元へ戻し、`git apply --check`で再適用可能なことを確認した。
- 通常8run＋診断4runの全24取込で文字投影SHAが一致。400 TextのSHAは`e195beaa7c4f47f1cbe8f2e916fa0a4d9a1d89e2024f8a05b3792963d8a0dcea`。PNG原本4個のSHA／bytes、旧blob URL解放、一時host0、pageerrorなしも確認した。
- [集計JSON](i5m-measurability-dedupe-results.json)に各run・fixture／source／bundle／patch／診断clientのSHAを保存。raw reportとclientはwork、レポート・JSON・候補patchはoutputsに保持する。I5mのremote CIは起動していない。

再現は同じfixture・Chrome・前後buildを用意し、通常は`profile-editor-load.mjs ... 1000 --direct-file-query`、getter診断はrepo外の`capture-rects.mjs`で採取する。診断clientはsourceを変更せず、normal runにはwrapperを入れない。SVG APIの参考は[CSSOM View](https://www.w3.org/TR/cssom-view-1/)だが、今回のSVG edge caseはこのChromeでの実測も併記した。

Windows／Linux・他ブラウザ・実Hub・長時間運転は未検証。次の候補はI5l (b) font準備取得とprobe書込の順序、(c) 図面側単一行probeのwrite/read境界。いずれも未着手で、別の設計判断が必要。引継ぎ用`docs/STATUS.md`を更新し、この区切りで止まる。
