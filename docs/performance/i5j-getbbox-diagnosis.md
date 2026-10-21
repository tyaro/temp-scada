# I5j：getBBoxの回数・時間・同期Layoutの診断

2026-10-22（日本時間）。**I5jの調査完了時点の記録。推奨案は後続I5kで試作し、全体時間の明確な短縮がなく不採用とした。** `work`の`473b0f8`から`perf/i5j-getbbox-diagnosis`を作成した。I5iの記録PR #2とは別のブランチで、I5iの候補は含まない。

この記録PRはdocsのみを取り込み、診断script・試験や試作コードは含めない。以下の採取方法・検証結果はローカルの`9a2119a`に対する履歴であり、再現時の`--bbox`／`--layout-trace`にはその診断runnerが必要になる。後続の[I5kの不採用記録](i5k-batched-text-measure.md)と区別する。

## 結論

1,000配置の再読込では`getBBox`が**12,800回**呼ばれ、トレース採取では全12,800回の呼出区間内に、probeへのDOM変更後の同期Layoutを確認した。初回は13,405回中12,803回。書込直後という観測だけでなく、同じrenderer threadのLayoutイベントが呼出開始／終了markに完全に収まることを確認している。

回数は既存の複数行計測host側が12,000回と多いが、図面側の単一行経路は再読込800回でも1回平均約1.09〜1.11msと重い。どちらか一方だけを問題と決めない。`getBBox`以外にもLayout／Style費用が残り、下記の候補で読込全体がどれだけ短縮するかはまだ測っていない。

おすすめは、**既存の測定場所・font・SVG変換を維持して、適応的文字計測を段階ごとのwrite→readにまとめる小さな検証試作**。現時点では候補比較までであり、queueや非同期計測、cache、表示省略を実装していない。

## 環境・採取範囲

- Mac／Apple M1、Node24.16.0、Playwright1.64.1、Chrome for Testing156.0.8078.4の完全版をheadlessで実行。viewport1920×1080。I5hのLinux／Xeon／Chromium154と直接比較しない。
- 既存の公開fixture `mixed-1000.bantoscada`を同じbytesで使用。主図面上のTextは400個、画像原本は4個。
- アプリの通常production buildは基準と同じ`index-z42DYoHf.js`。変更は診断script・試験・docsだけで、`src`・Rust・schema・依存・保存形式に差分はない。macOSのプライバシー設定は変更していない。
- 順序は通常a→回数／時間a→トレースa→回数／時間b→通常b。各runは新規ブラウザで初回Project取込・同一package再読込を1回ずつ採取。build・試験・他の診断を並走させていない。
- 回数は取込区間の**document全体**のSVG `getBBox`。主図面だけでなくミニマップ・サムネイル等を含む。`drawingText`と`isolatedText`は測定場所の分類で、主図面400 Textだけの回数ではない。

[集計値・識別SHA・各runのデータ](i5j-getbbox-results.json)を保存した。raw trace約25.4／27.9MBは作業用フォルダに保持し、repoには投入していない。rawのSHA、data lossなし、marker数とcall数の一致を記録した。

## 呼出回数と1回あたりの時間

下表は**トレースなしのラッパー計測2run**の範囲。`performance.now()`でnative呼出の前後を測り、同期Style／Layoutがあれば含む。署名取得・MutationObserver処理はnative時間の外だが、診断全体の実行には影響する。

| 取込   | 経路                 | 呼出回数／run | 呼出累積ms       | 1回平均ms      | p95 ms   |
| ------ | -------------------- | ------------- | ---------------- | -------------- | -------- |
| 初回   | 図面側Text           | 1,405         | 739.1〜822.2     | 0.526〜0.585   | 1.9〜2.1 |
| 初回   | 既存の複数行計測host | 12,000        | 384.3〜403.8     | 0.0320〜0.0337 | 0.1〜0.2 |
| 初回   | 合計                 | 13,405        | 1,123.4〜1,226.0 | 0.0838〜0.0915 | 0.2      |
| 再読込 | 図面側Text           | 800           | 871.4〜891.8     | 1.089〜1.115   | 2.3〜2.4 |
| 再読込 | 既存の複数行計測host | 12,000        | 363.9〜375.5     | 0.0303〜0.0313 | 0.1      |
| 再読込 | 合計                 | 12,800        | 1,235.3〜1,267.3 | 0.0965〜0.0990 | 0.2      |

再読込では9,052〜9,107回がtimer上0msだった。これは分解能以下という意味で、処理が無料という意味ではない。単発時間は精密なnative処理時間とは扱わない。p95はnearest-rank。最大値は初回の図面側で9.9ms、再読込の図面側で3.3msだった。

通常runの読込時間は初回3,516.4〜3,628.4ms、再読込4,063.6〜4,587.1ms。診断runはラッパー・Observer・mark・traceの負荷を持つため、この値と差し引いたり、診断runが速いことを改善としたりしない。

## 読み書きの交互実行と同期Layout

`MutationObserver.takeRecords()`と通常callbackで前回の読取以降のDOM変更を集め、`getBBox`直前にprobe自体への変更があったかを記録する。書込内容が実際にどのLayoutを無効化したかまでは特定していない。

別runで各`getBBox`をUser Timing markで囲み、CDPの`devtools.timeline`と照合した。start／endと同じpid・tidで、区間に完全に内包する`Layout`／`UpdateLayoutTree`等のcomplete eventだけを対応付ける。範囲外・別thread・部分重複は帰属させない。重なるStyle eventの時間はunionで集計し、二重加算しない。

| トレース取込 | 経路                 | 呼出回数 | 呼出区間内のLayoutあり | 同区間内のStyleあり |
| ------------ | -------------------- | -------- | ---------------------- | ------------------- |
| 初回         | 図面側Text           | 1,405    | 803                    | 802                 |
| 初回         | 既存の複数行計測host | 12,000   | 12,000                 | 12,000              |
| 再読込       | 図面側Text           | 800      | 800                    | 800                 |
| 再読込       | 既存の複数行計測host | 12,000   | 12,000                 | 12,000              |

これらのLayoutありのcallでは、すべてprobeへのDOM変更も直前に記録された。再読込は`write→getBBox内の同期Layout`の反復が観測できる。初回には書込があってもLayoutを伴わない602回があり、DOM変更の観測だけを強制Layout件数に読み替えることはできない。

再読込のtrace全体ではLayout14,006件／Style14,007件で、両方ともCDP counterと一致した。`getBBox`内は各12,800件なので、外側にもLayout1,206件／Style1,207件が残る。呼出内のLayoutは891.2ms、Styleは823.4ms、同thread全体は各1,338.3／2,355.5msだった。これらは`getBBox`時間やCDP指標と重なり、合算して全体費用とはしない。外側の呼出元の完全な切分けは後続。

強制reflowの考え方は[Chromeの公式解説](https://developer.chrome.com/docs/performance/insights/forced-reflow)に従う。採取は[Chrome DevTools ProtocolのTracing](https://chromedevtools.github.io/devtools-protocol/tot/Tracing/)を使う。今回は上記の実測イベントで判定しており、コードの読み書き順からだけの推測ではない。

## 改善候補の比較

| 候補                                           | 効果の見込み・根拠                                                                                 | リスク／まだ分からないこと                                                                                                                                                       | 変更の大きさ                           |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| **段階ごとにwrite→readをまとめる（おすすめ）** | 再読込12,800回の同期Layout反復を直接対象にできる。減らせる回数・時間は未測定                       | 二分探索／折返しは前の測定結果に依存するため、一括1回にはできない。既存のfont・変換・測定場所を保つ段階batch、pending・取消・世代・非表示復帰の扱いに設計が必要                  | 中〜大。まず範囲を限定した検証試作     |
| 同じ文字列・fontの結果を図面内で再利用         | 図面側の同一element・属性署名の再要求は再読込400回（800回中）。異なるelementをまたぐ重複率は未測定 | inherited font、font読込世代、SVG／CSS変換、倍率等の違いを署名だけでは覆えない。既存複数行には1計算内cacheがあり、今回のisolated側0重複は図面内再利用の余地が0という意味ではない | 中。キーと無効化境界の設計が必要       |
| 表示範囲外を後回しにする／LOD                  | 初回の同時計測量を減らせる可能性。範囲外だけの件数・時間は未測定                                   | ミニマップ・埋込・小窓・全体表示・パン直後・文字のpending解消と、計測完了条件を変える可能性                                                                                      | 中〜大。表示仕様と受入条件の判断が必要 |

第1案はcacheの安全性や表示省略の仕様を先に決めず、観測したwrite/read反復を対象にできるため推奨する。ただし既存の同期fitを段階batchへ接続する境界は未設計で、効果を保証しない。単一行probe隔離の再採用や、大域cache・検証省略は提案に含めない。**これはI5j時点の推奨。後続I5kの限定試作は不採用とし、更なる設計変更は行っていない。**

## 検証と未検証

- トレース帰属・別thread／範囲外の排除・marker欠損・重複・時間のunion等の単体5件が成功。
- 独立した実ブラウザでnativeの戻り値・引数／例外の転送、probe変更検出、同一element再要求の集計、prototypeの復元を確認。
- 通常2run・ラッパー2run・trace1runの全10取込で、400 Textの投影SHAが一致。4画像原本のSHA／bytes、旧URL解放、一時host0、pageerrorなしも確認。
- raw traceにdata lossなし。Layout／Style event総数とCDP counterが一致。script構文・整形・ローカルリンク・通常production buildを確認。
- 最終runnerではcapture後のCDP counter一致assertとreport保存後の明示的disposeを追加し、100配置のtrace smokeで正常終了を確認した。時間計測部分は変えていない。集計JSONは採取時runnerと最終runnerのSHAを分けている。

callの時間は2run、traceは1runの観測で、統計的有意性は未評価。初回が再読込より605回多い理由、`getBBox`外の読取呼出元、図面内の再利用率や範囲外の費用は完全には切り分けていない。診断時のheapはラッパーが保持する行データやtraceの影響を含むためリーク評価に使わない。Windows・I5hと同等のLinux・実Hub・長時間運転は未検証。アプリの全unit／全E2Eを今回再実行したという意味ではない。

## 再現

通常buildのpreviewと、使うChrome for Testingの実行ファイルを用意する。既存のbenchmarkで生成した同じ`mixed-1000.bantoscada`を使い、各採取を順番に行う。

```sh
node --test apps/banto-scada/scripts/getbbox-diagnostics.test.mjs
pnpm --filter banto-scada exec vite build --outDir /tmp/scada-i5j-build
# 別ターミナルでpreviewを起動する。
pnpm --filter banto-scada exec vite preview --outDir /tmp/scada-i5j-build --host 127.0.0.1 --port 5370 --strictPort
export SCADA_PROFILE_URL=http://127.0.0.1:5370
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="/path/to/Chrome for Testing"
node apps/banto-scada/scripts/profile-editor-load.mjs /tmp/mixed-1000.bantoscada /tmp/i5j-normal 1000 --direct-file-query
node apps/banto-scada/scripts/profile-editor-load.mjs /tmp/mixed-1000.bantoscada /tmp/i5j-count 1000 --direct-file-query --bbox
node apps/banto-scada/scripts/profile-editor-load.mjs /tmp/mixed-1000.bantoscada /tmp/i5j-trace 1000 --direct-file-query --bbox --layout-trace
```

診断オプションを指定しない通常実行ではprototypeの差替え・Observer・traceを入れない。CPU samplingとは同時に使わない。marker欠損・trace data loss・CDP counterとtrace件数の不一致があれば部分的な帰属を報告せずエラーで止める。
