# Historian H4b1: History応答の配送制御と保守的なTrend表示

2026-11-02（日本時間）。状態: **Astra 主設計、ローカル実装・受入済み。全体CIはPRで確認する**。[H4a HistoryHost](historian-history-host.md)、[H1契約](historian-contract-fixtures.md)、[ChronoGazer資産調査](../../reviews/chronogazer-historian-reuse.md)を前提とする。

## 今回の具体的な区切り

再利用可能なTS HistorySource／controller、純粋なTrend projection、小さいSvelte TrendViewを一緒に実装する。受入専用fixtureをbrowserに表示し、要求差替え・取消・欠測・包絡の動作を確認する。通常Appへの正式統合はH4b2以降とする。

fixtureは[e2e/read-presentation.spec.ts](../../../e2e/read-presentation.spec.ts)の方式に合わせ、テスト時だけentry mountを差し替える。通常main／Appにサンプル接続hook、架空endpoint、製品route、Project Trend属性を足さない。「ローカル検証データ・実DB未接続」をfixtureへ明示する。Rust HistoryHostとの実transport接続は未実装であり、fixtureの表示をSQLite実接続と呼ばない。

ChronoGazerのcategory等間隔x／minmax中点一本線は今回の要件に合わない。userが許可した新共通設計として、実UTC時刻軸・生sample点・minmax範囲をnative SVGで描く。SCADA Banto 6.9.0の既存theme tokenを使用し、ChronoGazerのappや--cg tokenをコピーせず、依存versionを変更しない。将来の共通化へ向けて製品型から分離する。

## Sourceとcontroller

最終の型名は実装に従う。HistoryQuery／HistoryResult等は既存history-contract.tsのunionから抽出するtype alias、または既存interfaceのexportで提供できる。H1 schemaや意味規則は変更しない。

```ts
interface HistorySource {
  query(
    query: HistoryQuery,
    options: { signal: AbortSignal },
  ): Promise<unknown>;
}
```

createHistoryController(source?)はsetSource、load、cancel、dispose、state、subscribeを提供する。loadはqueryを検証してopaqueなrequest tokenを発行する。queryごとの未解決Promiseをcallerへ蓄積するAPIではなく、結果はcontroller stateへ公開する。

source session tokenとrequest tokenはprocess内のidentityであり、H1 requestIdとは別にする。sourceの付替えでは旧要求tokenを退役させ、source identityと新tokenの組で旧応答を無効化する。同じsource objectへのsetSourceはNoOpとする。同sourceへの新要求はload、再接続を別ownerとして扱う場合は新しいsource objectを渡す。load毎に新request tokenを作り、同じH1 requestIdの再利用で古い応答が通らないようにする。

stateは少なくともoffline、idle、loading、ready、partial、unavailable、invalid、error、cancelled、disposedを区別する。loadingにはwaitingを持ち、前要求の終了待ちなのか実source実行中なのかを説明できる。ready／partial／unavailableはH1結果のstatusであり、queryUnavailable／unknownSeriesは各seriesの結果として残す。invalid responseを空のreadyへ変換しない。

Source拒否は有限の安全なerrorCodeへ写し、生Error.message、SQL、endpoint、資格情報をUIへ出さない。外部エラーの詳細分類を提供しないsourceなら「履歴取得失敗」でよい。loading中の明示cancelはcancelled、source無しはofflineとし、過去の成功グラフを現在の成功結果に見せない。ready／partial／unavailable／error／invalid等の完了済み要求に対する遅延cancelはNoOpで、確定結果を消さない。

## 物理並列数を増やさない差替え

controllerは**active一件＋pending latest一件**だけを持つ。新loadでは旧論理tokenを無効化して表示を消し、activeへAbortを通知し、新queryでpendingを置き換える。旧Promiseがsettleするまで次のsource.queryを呼ばない。setSource後の新sourceに対しても同じ制限を守る。

SourceのPromise settleは、下位readのcleanup／資源利用が終わった時点を意味する。Abortは中断要求だけである。transport adapterは途中でPromiseだけをrejectし、下位queryを裏で動かしながら次要求を開始する契約にしてはならない。

sourceがAbortを無視する場合はpendingがwaitingのままになる。controllerのhard timeoutでactive枠を解放し、並列queryを増やすことはしない。実transportのQueryControl deadline／取消・join対応は後続adapterの責務である。今回controllerは無期限の下位資源を強制終了できると主張しない。

loading中のcancel、setSource(undefined)、disposeはpendingと表示を即座に消してtokenを退役させ、activeへAbortを通知する。完了済み結果を消すのは新load／source付替え／disposeであり、遅延cancelではない。activeが遅れて成功・失敗しても状態を戻さない。disposeはterminalで、新loadを受け付けない。

pumpはmicrotaskでまとめ、同期listenerや同期throwするsourceに再入されてもactiveを二つ起動しない。active identityを設定してからsourceを呼び、同期throwもsettle経路へまとめる。finallyは自分のactiveだけを解放し、その時点の最新pendingを検査する。旧応答は大きなpayloadのparse前にtokenで捨てる。listenerの再入や例外でcleanup／次pumpを失わない。

## ownership、byte予算、完全一致

既存parseHistoryContractはstructuredClone後にcanonical JSON Schemaと意味検査を行う。これを再利用し、別のH1 validatorを増やさない。その前に、構造化JS入力のownership／有限サイズだけを扱うhelperを置く。

| 対象     | 上限／規則                                                             |
| -------- | ---------------------------------------------------------------------- |
| query    | UTF-8 JSON表現8192 bytes                                               |
| response | UTF-8 JSON表現8MiB                                                     |
| depth    | 最大32                                                                 |
| node     | 最大250000。JSON value一つを一nodeと数え、property名はnode数に含めない |
| H1点数   | 最大8系列、2000点／系列、総8000。既存意味検査を維持                    |

plain object／array／有限number／string／boolean／nullだけを受け付ける。own accessor、function、symbol、bigint、undefined、custom prototype、cycleを拒否する。getterを評価してcloneしない。文字列は先にlengthの保守上限を確認してからJSON escape／UTF-8 bytesを計数する。配列／objectの列挙数も予算で制限する。巨大な入力を無制限にstructuredCloneしてから初めて拒否する構造を避ける。

元のJS objectが既に持つ巨大property集合の列挙は、JS object APIの限界がある。これをネットワーク受信のhard CPU／memory上限と称さない。製品wire adapterは受信body bytesとJSON parse制限も別途必要である。

結果はowned JSONを既存parserへ渡し、kind=resultを確認する。応答queryはrequestIdだけでなく、version／kind／seriesIdsの順序／fromMs／toMs／mode／maxPointsPerSeriesが要求全文と一致しなければ拒否する。property順序の違いで拒否せず、値と配列順序を比較する。

controller所有の結果をdeep freezeする等により、sourceやsubscriberの後続mutationで表示内容を変更させない。Sourceへ渡すqueryも元caller入力と分離する。loadが不正だった場合も旧論理要求を退役させ、invalidとし、古い結果を再表示しない。

## Trend projectionの境界

projectionは検証済みHistoryResultから有限の描画modelを作る純粋関数とする。Project、SDK、DB、source lifecycle、テーマ設定を読み取らない。rendererは投影modelと表示状態を受け取る。

一つのseriesを選択して表示できる。複数seriesを単一y軸へ強制統合しない。同series内もsegmentごとにlaneを分け、unit／型／sourceの違いを混ぜない。metadataにあるだけのsegmentに架空sampleを作らない。unknownSeriesは系列不明、queryUnavailableは取得不能として表示し、値ゼロや空の正常期間へ置換しない。

UTC時間軸はquery.fromMs／toMsの実比率で配置する。category番号の等間隔へ置き換えない。範囲は[from,to)で、to上に点を補わない。safe epoch値がJS Dateの表現範囲外でも例外を起こさず、UTC epoch ms表記へfallbackする。

有限f64の両端が非常に大きい場合でも、max−minのoverflowでSVG座標をNaN／Infinityにしない。max absolute valueで正規化して差を求める等の安定したscaleを使う。定数値は中央配置、数値が無いlaneは無データとし、ゼロ点を作らない。

## rawは実sample点だけ

初期rendererはrawを**点だけ**で表示する。sampleTimeMsをx、実numberまたはboolの0／1をyにする。sourceTimeMsをxへ代入せず、sourceTime／ingestedAt／recordId／session／clockEpoch／segment／Quality／reasonは診断情報として保持する。

同timestampの複数recordを一つに潰さない。座標が重なっても各recordのidentityと件数を保持する。時刻順に並んでいてもrecord sequenceが別順序やclock rollbackであることを隠さない。

Bad／Stale／SIM／UnknownSource／その他の無値sampleは数値pointを描かず、時刻付きの無値診断mark／件数／理由を示す。falseと0を欠測扱いしない。

rawの点間を線形補間、階段補間、carry-forwardで結ばない。H1 rawは内部SourceEpochを公開しないため、SDK世代変化をすべて検出したとは言えない。点のみならsession／clockEpoch／segment／coverage／null境界を跨ぐ偽の連続線を作らずに実観測を表示できる。将来raw連結を追加する場合は別の明示契約とする。

## minmaxはbin内の範囲

numeric binのmin／maxは時間順序を持たない範囲として描く。bin.fromMs／toMsの幅とmin／maxの上下を持つ矩形、または範囲を示す独立barを使い、tooltip等にbin半開区間を残す。minmaxの中点を実sampleへ変換せず、bin間を一本のlineで結ばない。

complete／partialを見分けられるようにする。partialでも有効値があるなら包絡を表示できるが、invalidCount／coverageがあることを明示する。validCount／invalidCountは観測件数であり、Hub通知総数ではない。

bool binは0／1の離散状態だけを示す。min=0,max=1なら両状態が観測された印を描き、その間に0.5の値や遷移順を作らない。min=maxの場合も観測範囲の事実であり、bin全期間その状態だったと保証しない。

gapはbounds無し、mixedSegmentもbounds無しの診断領域として表示する。mixedSegmentを適当なsegment laneへ割当てたり、前後binのunit／minmaxで補ったりしない。stateに反するboundsはcanonical validatorで拒否済みでなければならない。

## coverageと診断

coverageは系列共通の別帯／説明一覧として表示し、各segment laneへ同じ帯を大量複製しない。expired、unrecorded、pendingFlush、samplingMissed、storageLoss、unknownCoverage等の理由を保持する。unknownCoverageを「無値」「記録停止」「正常連続」のどれかへ推測変換しない。

unknownCoverageが全域にあっても、保存済みraw点／minmax包絡を消さない。coverageは完全性についての証拠であり、実在観測と共存する。提供されていないcoverage区間を勝手に正常／不明で補完しない。watermarkを最新時刻とみなさず、ライブ値とのhandoff／flush補修は今回行わない。

見た目だけに依存せず、status、mode、UTC範囲、series／segment／unit／source、観測／無値件数、coverage理由を読めるテキストで示す。SVGに説明を付け、色だけでBad／partial／unknownを区別しない。通常Banto theme token（--banto-text、--banto-border等）を使い、独自テーマ基盤を作らない。

## ローカルfixtureと受入

fixture componentは採用されたcontroller／projection／TrendViewを使い、test-only sourceからH1 fixtureを返す。入口差替え以外にproduction global hookを作らない。通常buildや通常Appがサンプルsourceへ自動接続しないことも確認する。

- full query mismatch、invalid schema／semantic、秘密field混入、unsafe integer、accessor／cycle／過大入力を拒否し、source/caller mutationで結果が変化しない。
- 応答順序逆転、source付替え、同requestId再利用、cancel／dispose後の成功・失敗を無視する。
- Abort無視sourceでもactive1＋pending1を維持し、最新pendingだけが旧Promise終了後に実行される。listener再入／throw／source同期throwでpumpを失わない。
- offline、waiting、cancelled、invalid、取得error、ready／partial／unavailable、unknownSeries／queryUnavailableを区別する。新要求時の古いグラフを成功結果として残さない。
- raw0／false、Bad／Stale／SIM／UnknownSource無値、同timestamp別record、時計逆行／異session／異segmentを点と診断で保持し、連続lineを作らない。
- minmaxの山を中点へ潰さず、partialとmixedSegmentを明示する。bool binから中間値や順序を作らない。unknownCoverage全域でも実観測を表示する。
- 実時刻の不等間隔x、[from,to)境界、極端な有限number、JS Date範囲外、空値laneでNaN／Infinity／架空ゼロを出さない。
- light／darkのbrowser fixtureで読みやすさと状態差替えを確認し、「ローカル検証データ・実DB未接続」を常時表示する。

H4b1の完成は安全なフロント配送と実観測／包絡の表示である。正式AppへのTrend配置、Projectモデル、Rust HistoryHostとのtransport、認証、liveとのmerge、長期検索、ChronoGazerへの共通package還元は後続に残す。

## 実装・検証結果

`apps/banto-scada/src/lib/history`にbounded plain JSON所有、controller、純粋projection、TrendViewを分離した。H1 moduleには既存型のaliasを公開追加し、schema／validatorの意味は変更しない。通常App／main、Project、DB形式、外部依存は維持する。受入fixtureはe2eでentryのmountだけを差し替えて起動し、通常buildには接続口を追加しない。

TypeScript全体1,443件（新規36件）、型検査0error／0warning、build、関連Chromium12件（新規6件）が成功。controller試験は所有・凍結、全query照合、active1＋pending1、source変更、取消／dispose、safe error、subscriber／Abort再入、UTF-8 byte・構造／depth／node制限を確認した。projectionは既存SQLite結果fixtureを使い、観測・bin・coverageの保存、極端finite値とDate範囲外時刻を確認した。

browserではライト／ダーク、0／falseとBad／Stale無値、未知系列、unknownCoverageでも観測を保持すること、minmaxとbool、混在bin／expired、取消待ちと旧応答・不正応答拒否を受け入れた。画像でも両テーマを確認し、Astra最終レビューに必須修正はない。buildの既存chunk-size警告は残る。Rust／H1 schemaは変更せず、Rust回帰は前工程CIを前提とし全体CIで再確認する。

これは再利用する表示基盤とローカルfixtureの完成であり、通常Appで履歴を開ける機能や実SQLiteへのbrowser接続ではない。H4b2以降でApp呼出し／正式Trend定義／HistorySource adapterを検討する。ChronoGazerへは未還元、上流・S7・実環境へ接続していない。
