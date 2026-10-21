# I5k：同期の段階バッチ文字計測の試作

2026-10-22（日本時間）。**1000配置でばらつきを超える明確な短縮を確認できず、不採用。停止条件に従い試作コードのpush・PR作成・CI起動は行わなかった。** `perf/i5j-getbbox-diagnosis`の`9a2119a`から`perf/i5k-batched-text-measure`を作った。I5jの診断script・試験・docsはブランチに含む。試作コードはローカルの`e80f4a2`に残し、pushせず、`work`へ採用していない。この文書と計測値だけを`work`から切った`docs/i5j-i5k-records`の記録PRへ取り込む。

## 試作した範囲

- `wrapStaticLine`と幅の省略探索を同期generatorへ分解し、1回の`fitStaticLines`内の独立段落／行を、測定結果が必要になる段階ごとに進める。前の幅に依存する同一探索内の二分探索・次行探索は逐次のまま。
- `withSvgTextMeasure`の**既存host・SVG group・fontコピー・座標変換を維持**し、同じgroup内に必要なprobeを作る。各段階で全probeの`textContent`を書いてから全`getBBox`を読む。host内probeは同じ呼出中だけ再利用し、成功・例外とも`finally`でhostごと解放する。
- 既存の呼出内cacheだけを継続使用する。同じ段階で同じ文字列を要求した場合も既存cacheへ1結果だけ登録する。新しいcache、componentを跨ぐqueue、Promise／rAF等による非同期計測、表示省略は導入していない。
- `TextPrimitive`の単一行直接計測は変更しない。font ready／loadingdone／loadingerror、非表示からの再試行、theme、倍率、Project形式も変更しない。同期のcomponent呼出を跨いだ集約は今回の禁止範囲へ踏み込むため行っていない。

## 同じ環境での前後計測

Mac／Apple M1、Node24.16.0、Playwright1.64.1、**同じChrome for Testing156.0.8078.4の完全版をheadless実行**、1920×1080。macOSのプライバシー設定は変更していない。基準はI5jの`9a2119a`（実行アプリは`work`の`473b0f8`と同じ）。I5hのLinux／Xeon／Chromium154、I5iのChromium148の値を対照として引いていない。

前段I5jで使った公開fixtureの同じbytesを100／500／1000配置で使用した。基準production bundleは`index-z42DYoHf.js`、試作は`index-CXKKRb2v.js`。script・変更source・bundle・fixture・traceのSHAと各runの値は[集計JSON](i5k-batched-text-measure-results.json)へ保存した。raw traceは作業用フォルダに保持し、Gitへ投入しない。

**通常の時間計測**は100／500配置は各前後1run、1000配置は各4run。1000の順序は「前→後→後→前→後→前→前→後」。すべて別ブラウザの初回Project取込と同じpackage再読込。起動済みエディタからの取込であり、ブラウザ起動時間ではない。font準備・文字計測完了・画像decode・2 rAFまでを測る。試験・build・別診断を並走させない。

| 配置 | 取込   | 前の平均ms | 後の平均ms |  後−前 | 前の範囲ms     | 後の範囲ms     |
| ---- | ------ | ---------: | ---------: | -----: | -------------- | -------------- |
| 100  | 初回   |      371.0 |      291.2 | −21.5% | 1run           | 1run           |
| 100  | 再読込 |      320.9 |      238.3 | −25.7% | 1run           | 1run           |
| 500  | 初回   |     1440.9 |     1378.9 |  −4.3% | 1run           | 1run           |
| 500  | 再読込 |     1641.6 |     1461.9 | −10.9% | 1run           | 1run           |
| 1000 | 初回   |     3799.2 |     3758.6 |  −1.1% | 3616.5〜3984.2 | 3636.4〜3866.6 |
| 1000 | 再読込 |     4444.5 |     4455.1 | ＋0.2% | 4319.9〜4621.0 | 4341.2〜4575.7 |

1000配置の範囲は大きく重なり、再読込平均は短縮していない。100／500の各1runだけを根拠に効果ありとは判断しない。統計的有意性を示したものではなく、指定された「ばらつきを超える明確な短縮」の採用条件を満たさない。

## getBBoxと同期Layout

時間計測とは**別に**、各規模・前後1runずつ`--bbox --layout-trace`を採取した。同threadでgetBBox開始／終了markに完全に内包するLayoutだけを数える。DOM変更があったという観測だけでは同期Layout扱いにしない。全traceでdata lossなし、marker数一致、Layout／Style総数とCDP counterの一致を確認した。診断のラッパー・Observer・mark・trace負荷があるため、このrunの時間を上表に混ぜない。

| 配置 | 取込   | getBBox回数 前→後 | getBBox区間内の同期Layoutあり 前→後 | renderer全体のLayout件数 前→後 |
| ---- | ------ | ----------------: | ----------------------------------: | -----------------------------: |
| 100  | 初回   |           905→905 |                             843→523 |                        968→648 |
| 100  | 再読込 |           840→840 |                             840→520 |                        965→645 |
| 500  | 初回   |         6705→6705 |                           6403→4803 |                      7009→5409 |
| 500  | 再読込 |         6400→6400 |                           6400→4800 |                      7007→5407 |
| 1000 | 初回   |       13405→13405 |                          12803→9603 |                    14009→10809 |
| 1000 | 再読込 |       12800→12800 |                          12800→9600 |                    14006→10806 |

1000配置では、初回・再読込とも同期Layoutありのcallを3200回減らした。再読込の内訳は既存の複数行計測hostが12000→8800、図面側単一行が800→800。全getBBox回数と最終文字投影を維持したまま局所的な交互実行は減らせたが、読込全体の改善を確認できたとは扱わない。generator駆動、段階ごとの配列／cache照合、追加probe作成等の費用とLayout短縮分は個別に分離しておらず、原因を推測で断定しない。

## 全体が速くならなかった理由の候補

確定したのは「局所的な同期Layoutありのcallは減ったが、1000配置の全体時間の採用条件は満たさなかった」ことまで。以下は根拠を伴う仮説で、原因の確定や各費用の差引計算ではない。

| 考えられる理由                                            | 観測・限界                                                                                                                                                                                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 減らした回数が、そのまま大きな時間短縮にならない          | 削減3200回は既存の隔離host側。I5jの別runでは同経路の1回平均は約0.03ms、図面側単一行は約1.1msだった。試作は図面側の800回を維持しており、回数の25%削減を時間の25%削減と読み替えられない。環境内の別runの数字を掛けて正確な短縮量とはしない。 |
| 段階駆動の追加費用が削減分を相殺した可能性                | 同期generator、段階ごとの配列・cache照合、追加probeの作成・書込を加えた。各費用を単独計測していないため、generatorが主因とはまだ言えない。                                                                                                 |
| 残るStyle／Layout・状態構築・描画等が全体を支配した可能性 | 文字計測以外の処理は変更していない。I5jではgetBBox外のLayout／Styleも残った。画像decodeや状態構築を含む全体の時間配分はI5lの調査対象であり、この記録から断定しない。                                                                       |
| 測定ばらつきに対して差が小さい                            | 前後各4runの範囲が重なり、初回−1.1%・再読込＋0.2%。100／500配置は各1runのため、採用条件の代替根拠にならない。                                                                                                                              |

## 品質と検証

全18run・36取込で、前後・通常／診断・初回／再読込の文字投影SHAが各規模で一致した。1000配置の400 Textは`e195beaa7c4f47f1cbe8f2e916fa0a4d9a1d89e2024f8a05b3792963d8a0dcea`。画像原本4個のSHA／bytes一致、旧blob URL解放、一時host0、pageerrorなしも全取込で確認した。

- TS全単体1216件成功。追加2件で、空行・grapheme・幅／高さ省略・折返し・独立段落の段階集約・既存cacheの呼出内寿命・失敗伝播を確認。
- I5jの診断単体5件成功。型チェックはエラー0／警告0。production build成功（既存のbundleサイズ警告あり）。変更ファイルのPrettier、`git diff --check`、docsの相対リンクを確認。
- 新規のブラウザ2件は両テーマ各324条件で逐次版とbatch版の全layoutを完全比較。SVG倍率、回転／非等方変換、字体、折返し、空白、絵文字、幅／高さ省略を含む。全書込の終了後に最初のgetBBoxを呼ぶこと、例外解放、非表示拒否と表示復帰も確認した。
- `svg-text-measure.spec.ts`の既存5件はChrome156で成功。動的font、両themeの計測変換・寸法、単一行との一致・解放を確認。
- 関連ブラウザは計37件中28成功・9失敗。9件すべてを同じChrome156・変更前production buildでも再実行し、同じ箇所で再現した。試験を緩めたりOS設定を変えたりしていない。

失敗の内訳は、`multiline-text.spec.ts`のnative paste・clipboard往復・word-wrap clipboard往復の3件、`text-style.spec.ts`のnative multiline pasteの1件、`selection-text-style.spec.ts`全5件。後者はCtrl＋clickによる複数選択が成立せず、選択書式regionが現れない箇所で失敗する。以前の「Macで既存6件」はChromium148でのclipboard4件＋隔離寸法比較2件だった。今回Chrome156では寸法比較2件は成功し、対象を広げた選択書式5件も基準で失敗したため、旧6件へまとめず区別して記録する。

## 再現と停止位置

この節はローカルに保存した診断・試作の再現履歴。記録PRには`getbbox-diagnostics`の診断追加や`batched-text-measure.spec.ts`等の試作コードは含まれない。

同じfixture bytes・Chrome実行ファイルを用意し、`9a2119a`と試作ブランチを別production buildへ出力してpreviewする。`profile-editor-load.mjs`の診断処理はI5jから変更していない。

```sh
node --test apps/banto-scada/scripts/getbbox-diagnostics.test.mjs
pnpm test
pnpm check
pnpm build
# 各buildのpreview URL・Chromeを指定し、前後を交互に採取する。
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="/path/to/Chrome for Testing"
export SCADA_PROFILE_URL=http://127.0.0.1:5381
node apps/banto-scada/scripts/profile-editor-load.mjs /path/to/mixed-1000.bantoscada /tmp/i5k-normal-before-1 1000 --direct-file-query
# 診断は通常時間計測から分離する。
node apps/banto-scada/scripts/profile-editor-load.mjs /path/to/mixed-1000.bantoscada /tmp/i5k-trace-before 1000 --direct-file-query --bbox --layout-trace
pnpm exec playwright test e2e/batched-text-measure.spec.ts e2e/svg-text-measure.spec.ts e2e/multiline-text.spec.ts e2e/text-style.spec.ts e2e/selection-text-style.spec.ts --workers=1
```

100／500も同じ手順で規模とfixtureを替える。`PATH`の先頭に動作するGitを置く（このMacでは`/usr/bin`）。通常時間計測の1000配置は前後各4runを採取し、JSONの`normalRuns`に順序・各値を記録した。時間計測とtraceの差分から改善量を求めない。

Windows／I5hと同じLinux／実Hub／長時間運転、アプリの全E2E、試作コードのremote CIは未実施。componentを跨ぐ集約、単一段落内の依存する探索の更なる集約、追加probe数の制限設計、別の探索アルゴリズムへは進んでいない。今回の制約内では採用条件を満たせなかったため、次の工程は**コード変更を伴わないI5lの読込プロファイル調査**とし、この記録PRとは別ブランチで進める。
