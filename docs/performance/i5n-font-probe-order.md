# I5n：font準備取得とprobe書込の順序

2026-10-22（日本時間）。**通常時間のばらつきを超える明確な短縮を確認できず、不採用。** PR #3マージ後の最新work `2d09779`から`perf/i5n-font-probe-order`を作り、I5l候補(b)だけを試作した。追加queue・非同期計測・Promise共有・通知集約・文字metrics cacheは入れない。I5mの記録公開は別の[PR #5](https://github.com/tyaro/temp-scada/pull/5)。I5nの試作はpush・PR作成しない。

## 変更と守る契約

従来は各Text componentのonMountで`document.fonts.ready`を取得し、後続のeffectでprobeを書き換え、getBBoxを読む。前componentのprobe片付け・描画更新と、次componentのfont準備取得が交互になる。

試作では初回のfont準備取得を、既存の同期文字探索の直後・probeの片付け書込より前へ移した。単一行はfitTextの直後、複数行はwithSvgTextMeasureのcallback内のfinallyで、隔離host解放より前に取得する。各componentで一度だけ購読し、hidden／計測失敗でもcatch側から購読する。onMountで先に登録するloadingdone／loadingerror、既存ResizeObserverと再試行frame、破棄時のactive guard・listener解除は維持した。

計測場所・font・SVG変換・getBBox探索・表示投影・Project形式を変えない。I5iのPromise取得共有やI5kのgeneratorを再導入した試作ではない。I5l候補(c)の図面側probe境界整理には広げない。

## 通常時間：前後各4run

Mac／Apple M1、Node24.16.0、Playwright1.64.1、Chrome for Testing156.0.8078.4完全版のheadless、1920×1080。同じmixed-1000 package bytes（SHA256 `e7a8238340ca83397fd83d5cabb93bb2ada08c99103aafddbdf761020d811ffd`）、主図面400 Text・PNG原本4個。基準のbundleは`index-z42DYoHf.js`、候補は`index-tHNdrryW.js`。

既存`profile-editor-load.mjs --direct-file-query`を変更せず、「前→後→後→前→後→前→前→後」で取得した。各runは新規ブラウザで、ロード済みエディタへの初回Project取込と同じpackageの再読込を測る。ブラウザ起動時間ではない。終了は文字計測・font準備・画像decode・2 rAFの完了時。build・試験は並走させず、原本・投影・GCの確認は時間計測後に行った。過去のI5l／I5mの絶対値を今回の対照値として使わない。

| 取込   | 前の平均ms | 後の平均ms | 平均差 | 前の範囲ms     | 後の範囲ms     |
| ------ | ---------: | ---------: | -----: | -------------- | -------------- |
| 初回   |     3821.4 |     3781.9 | −1.03% | 3592.3〜4190.4 | 3667.8〜3907.6 |
| 再読込 |     4756.3 |     4533.7 | −4.68% | 4430.5〜5128.6 | 4406.6〜4643.7 |

初回の中央値は3751.5→3776.2msで増加。再読込の平均・中央値は小さくなったが、両方の範囲が重なる。最後の前→後は初回3597.2→3730.1ms、再読込4430.5→4634.3msと逆転した。基準自体の最初→最後の変動（再読込5128.6→4430.5ms）が平均差より大きく、指定の4runでは安定した全体短縮を確認できない。統計的有意差や「効果が完全にゼロ」を示すものではないが、採用を裏付ける再現性が不足するため不採用とする。測定後に条件・候補の範囲を拡大して採用を探さない。

## 別runの読取診断

通常時間とは別に「前→後→後→前」で各2run。ブラウザ内でFontFaceSet.ready、Element.getClientRects、SVGGraphicsElement.getBBoxをwrapし、native receiver・引数・戻り値・例外を転送して、取込区間のdocument全体の回数と累積時間を記録した。終了時にprototypeを復元する。計測client自身のfont準備取得も含む。単発計測の分解能とwrapperの費用があるため、診断runを通常表へ混ぜない。

| 取込   | 読取            | 回数 前→後／run | 累積時間 前 ms | 累積時間 後 ms |
| ------ | --------------- | --------------: | -------------- | -------------- |
| 初回   | fonts.ready取得 |       1003→1003 | 1080.1〜1170.6 | 3.6〜3.8       |
| 初回   | getClientRects  |         800→800 | 426.3〜470.7   | 826.6〜870.7   |
| 初回   | getBBox         |     13405→13405 | 1147.5〜1236.5 | 1904.0〜1917.6 |
| 再読込 | fonts.ready取得 |         801→801 | 1293.4〜1570.8 | 2.7〜3.2       |
| 再読込 | getClientRects  |         800→800 | 507.8〜587.8   | 1010.9〜1115.8 |
| 再読込 | getBBox         |     12800→12800 | 1284.8〜1431.4 | 2089.5〜2279.7 |

font getterの回数を減らさず、その呼出区間内の時間は小さくできた。一方、他の読取区間の時間は増えている。同期更新の費用が別の読取へ移った可能性と整合するが、このwrapperだけでStyle／Layout eventの厳密な帰属は断定しない。getter内の約1秒を全体から削減したとは扱わず、これらの時間をCDPのStyle／Layout時間と合算しない。

通常runのCDP平均LayoutCountは初回14008.25→13607、再読込14006.75→13607と約400減ったが、LayoutDurationは初回596.5→582.4ms、再読込579.8→569.0ms。回数減少を全体の明確な短縮とは読み替えない。個々のrunと診断時間は[集計JSON](i5n-font-probe-order-results.json)に保持する。

## 検証・保存・限界

- 試作の型エラー／警告0、本番build成功、単体1214件成功。変更sourceと追加ブラウザtestをPrettierで整形した。
- 関連ブラウザ29件を実行し28件成功（追加2件を含む）。単一行／複数行のhidden→表示復帰、未解決font準備Promiseの解決による再計測、loadingdone／loadingerror、破棄後のPromise解決とイベントで追加計測しないこと、listener／host解放を追加確認した。既存の両theme・寸法・倍率・Symbol／View／Popupも成功した。
- 残る1件はtext-styleのControl+V貼付試験。試作を戻した基準コードでも同じ行168で同じ旧本文が残り失敗した。既知のMac入力問題として維持し、今回修正していない。その他の既知clipboard3件と選択書式5件は実行していない。「全E2E成功」とは扱わない。
- 試作source／追加testをpatchへ保存して元へ戻し、`git apply --check`で再適用可能、apps／e2eが基準HEADと同一であることを確認した。文書とJSONの整形・構文・相対リンク・差分確認も成功した。I5nのremote CI／push／PR作成は行わない。

通常8run＋診断4runの全24取込で文字投影SHAは`e195beaa7c4f47f1cbe8f2e916fa0a4d9a1d89e2024f8a05b3792963d8a0dcea`と一致。400 Text、PNG原本4個のSHA／bytes一致、旧blob URL解放、一時host0、pageerrorなしを確認した。計測clientのassertを通過したraw reportを保持する。

raw・前後build・試作patch・診断client・集計器は、このMacのrepo外`/Users/tyaromax/Documents/Codex/2026-10-22/te/work/i5n-font-probe-order/`へ保存。報告・JSON・patch・clientは同じ親のoutputsにも保存する。source／bundle／fixture／script／patchのSHAは集計JSONに記録する。元runnerのreport.commitは両方とも基準HEADを示すため、未コミット試作の特定にはsourceとbundleのSHAを使う。

再現は同じfixture・Chromeと前後buildを用意し、各previewを5411／5412で起動してrepo外の`run-comparison.mjs`を実行する。通常はrepoの`profile-editor-load.mjs`、診断だけ`capture-reads.mjs`を呼ぶ。このPCの絶対パスは他環境では調整する。

Windows／Linux・他ブラウザ・実Hub・長時間運転は未検証。macOSのプライバシー設定や上流固定依存は変更していない。既存macOS E2Eの失敗は[Issue #4](https://github.com/tyaro/temp-scada/issues/4)の別工程を維持する。追加の設計判断を必要とするqueue／非同期化には進まず、I5l候補(c)も未着手のまま止まる。
