# Historian H1: 版付き契約と共通fixture

2026-11-01（日本時間）。状態: **H1の採用契約**。ユーザー指定に従いAstraが主設計した。[P5](historian-trend-contract.md)をtransport非依存のJSONと純粋な検証へ具体化する。実store／recorder／Historyサービス／HTTP／UIはH2以降であり、本契約の検査成功は記録・永続化・検索の実装成功を意味しない。Project0.35.0、SDKの固定rev、Banto6.9.0を変更しない。

## 正本と実装境界

- [canonical JSON Schema](../../../crates/scada-historian/schema/history-contract.schema.json)はdraft2020-12。rootと全nested objectを閉じ、未知field・未知versionを拒否する。
- [共通fixture](../../../examples/history-contract-cases.json)は`[{name,input,expected}]`。expectedは`accepted | schema | semantic`のいずれか。RustとTypeScriptで同じファイルを読む。
- Rustの`scada-historian`とフロントのhistory-contract moduleは、構造検査→意味検査の順でstructured JSON valueを検査する。schema失敗が先ならsemanticとして分類し直さない。
- [保存方式の決定](historian-storage-decision.md)はH2の設計入力であり、H1にSQLite接続やDB試験を追加しない。Industrial／SOAK対象へのアクセス・変更・サービス実行を行わない。

版は整数`version: 1`、kindは`query | sampleBatch | result`。この版番号はProject版・DB format版・SDK版から独立する。JSON Schemaのintegerは数学的な整数を表すため`1.0`の表記も整数として扱い、Rust／TSで同じ意味に検査する。JSON wire contractのcamelCase `derivedSimulation`はSDK sourceの`derived_simulation`の明示的投影であり、実機sourceへ変換するものではない。

## 共通の値と予算

| 項目               | v1の決定                                                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| ID                 | 1〜64文字、先頭はASCII英数字、以後は英数字と`.` `_` `:` `-`。全体がこの文字集合。URL／パス／credentialをIDに使わない                    |
| 時刻               | UTC epoch msの整数、−9,007,199,254,740,991〜＋9,007,199,254,740,991。JSON／JSとRustの共通safe integer範囲                               |
| sequence           | 1〜9,007,199,254,740,991の整数。上限前に新sessionへ移り、丸めない                                                                       |
| count              | 0〜9,007,199,254,740,991の整数                                                                                                          |
| 数値の値・包絡     | finite number。boolをnumberに暗黙変換しない。NaN／Infinityは受理しない                                                                  |
| externalName／unit | 名前1〜512 Unicode code point、unitはnullまたは0〜64 code point。現在のcatalogの512上限と合わせる                                       |
| 記録周期           | 100〜3,600,000msの整数。初期の周期snapshot方式の許容範囲。100msの性能保証ではなく、H3の負荷試験で有効なdeployment予算をさらに制限できる |
| query              | 1〜8系列、1〜2000点／系列、系列数×点数≦8000、0より大きい期間で最大1時間                                                                 |
| sampleBatch        | 1〜32個のsegment descriptor、1〜8000観測、unique seriesは最大8                                                                          |
| result             | 1〜8系列、各系列descriptor最大32、raw／bin各最大2000、coverage最大256区間。実際の点数はqueryの予算以内                                  |

許可文字外を`not`でも拒否し、JSの正規表現`$`が終端改行の直前に一致する問題でIDを通さない。metadataの長さはbyte数ではない。H1はstructured valueの検査であり、未信頼JSON textの巨大なparse負荷を抑えるtransportのbyte上限やHTTP body制限を提供しない。将来の入口はparse前のbyte上限も必須で、この純粋validatorをネットワーク防御全体と呼ばない。

sourceは`real | computed | internal | db | simulation | derivedSimulation | unknown`。Qualityは`good | bad | stale | unknown`。未知ラベルの原文や内部エラー文字列はv1 DTOに含めない。長さ・秘密情報の管理を持つserver内部診断を後続に分離する。sourceがunknownでも、realへ置換せずその分類を維持する。

queryの1時間はライブTrend初期窓の初期予算であり、保存できる期間の上限ではない。長期検索のcapabilities／cursor／query jobはP5の契約を維持してH6で追加する。v1に未完成のpagination fieldを置かない。

## query

```json
{
  "version": 1,
  "kind": "query",
  "requestId": "request-a",
  "seriesIds": ["series-a"],
  "fromMs": 1000,
  "toMs": 3000,
  "mode": "raw",
  "maxPointsPerSeries": 20
}
```

期間は半開区間`[fromMs,toMs)`。両端の型・safe integerはschema、`from < to`・期間差・総点予算はsemanticで検査する。減算前の値も検査し、言語ごとのoverflowや丸めに依存しない。

v1は**正規化後のquery**を表すためseriesIdsの重複を拒否する。外側の入力フォーム等がP5の重複除去を行う場合は、最初の順序を保って正規化してから渡す。validator自身は入力を変更しない。raw／minmax以外を代替処理しない。

## identity descriptorとsampleBatch

identity descriptorは次の全fieldを持つ。

| field         | 意味                                                                                    |
| ------------- | --------------------------------------------------------------------------------------- |
| seriesId      | Historianの永続系列ID                                                                   |
| hubInstanceId | deploymentで確定するHub個体ID。endpointやrun_idではない                                 |
| incarnationId | そのHub内のタグの生存期間をHistorianが確認・割り当てたID。SDKの数値IDを不変と仮定しない |
| externalName  | このsegmentでの参照名。別Hubや再作成で同名になってよい                                  |
| segmentId     | source／型／単位等の意味の区切り。renameを明示継続した場合も新descriptorで名前を残せる  |
| valueType     | numberまたはbool                                                                        |
| unit          | 当該segmentの単位またはnull                                                             |
| periodMs      | 当該segmentの採用周期                                                                   |
| source        | 当該segmentの値source分類                                                               |

`(seriesId,segmentId)`は一意。同seriesIdに複数descriptorを含める場合、hubInstanceId／incarnationIdを変えない。同じhubInstanceId＋incarnationIdを別seriesIdへ二重に登録しない。同じ名前を別Hubへ、または新incarnationで新seriesへ割り付けることは合法。名前一致だけから継続を推測しない。ここで検査できるのは一つのdocument内の整合だけであり、過去の対応表を越える継続性確認はH2以降の管理storeの責務である。

sampleBatchは`version, kind, sessionId, series, samples, committedThrough`を持つ。seriesは上記descriptor配列、samplesは下表の観測配列。これは受理済み観測とcommit位置を説明する**契約fixtureの形**であり、外部clientがcommittedThroughを指定して実storeを進められるappend APIではない。

| sample field        | 意味                                                           |
| ------------------- | -------------------------------------------------------------- |
| seriesId／segmentId | 同じdocument内descriptorへの参照                               |
| recordId            | `{sessionId, sequence}`。seriesIdと組にして一意なrecordを表す  |
| clockEpoch          | 記録時計の連続区間。壁時計補正を跨ぐ場合は別epoch              |
| sampleTimeMs        | 周期tickでHistorianが観測した時刻。履歴の検索軸                |
| sourceTimeMs        | Hub値が持つ時刻、または未観測ならnull。PLC測定時刻と断定しない |
| ingestedAtMs        | 記録経路で受領した時刻                                         |
| quality／source     | 観測できたラベル、または未観測ならnull                         |
| value               | finite number／boolean／null                                   |
| reason              | 無値の理由、または有効値ならnull                               |

batch内sampleのrecordId.sessionIdはrootと一致する。`(seriesId,sessionId,sequence)`は一意で、系列ごとにsequenceが厳密昇順。同時刻の異なるsequenceは合法。sampleTimeMsの昇順は要求せず、clockEpochを変えた時計逆行のfixtureも受理する。異なる時計を比較してsourceTime≤sampleTime≤ingestedAtを強制しない。時計が逆行していないという事実を純粋DTOだけで証明はできないため、実時計変化の検出はrecorder試験へ残す。

committedThroughはnull（このsnapshotでcommit位置未確認）またはこのbatchの最大sequence以下。最大sequenceより小さくてよい。部分commit位置を越えるsampleは受理済み・未commitを表す。sampleの存在だけをcommit済みの証拠にしない。連続したtick全件の処理、DB transactionのcommit、flush・fsyncをこの検査で実行／証明しない。

### sampleの意味検査

1. 対応descriptorが必要。sourceが非nullならdescriptor.sourceと一致する。
2. valueが非nullならQuality=good、sourceはreal／computed／internal／db、sourceTimeMsは非null、reasonはnull。number／boolがdescriptorの型と一致し、数値はfinite。
3. valueがnullならreasonが必須。bad／stale／unknownQualityは対応Qualityを必要とする。simulationExcludedはsimulationまたはderivedSimulation、unknownSourceはunknown sourceを必要とする。
4. sourceUnavailable／unresolved／identityPendingはQuality／source／sourceTimeMsがすべてnull。観測できていない値を古いprovenanceで埋めない。
5. missingValue／nonFinite／typeMismatchはQuality=goodで、sourceは実値記録を許可する4分類。値はnull。非有限値の原数値や型不適合の内容を公開DTOへ残さない。

複数の無効要因が併存した場合、reasonは満たされる原因の一つを示し、Qualityとsourceにその他の事実を保持する。v1ではreasonの優先順位を強制しない。Bad＋SIMを無値として拒否せず、どの原因を選んでも有効値には昇格させない。

P5のsourceEpoch（Hub run_id／catalog revision／SDK generation）はこの最小公開DTOには含めない。H2の内部記録metadataでは同一snapshotから保存し、失わない。clockEpochをその代用にしない。詳細は[保存決定](historian-storage-decision.md#source世代を保持する内部metadata)に従う。

## result

rootは`version, kind, query, status, snapshotId, series`。queryを含め、要求の端点・順序・予算を同じvalidatorで検査できる。seriesのID列はquery.seriesIdsと順序も含めて一致する。各系列結果は`seriesId, status, segments, raw, bins, coverage, watermark`を持つ。identityのHub＋incarnation一意性は系列内だけでなくresult全体のdescriptorに適用し、別系列への偽装を拒否する。

| 系列status       | 内容                                                                              |
| ---------------- | --------------------------------------------------------------------------------- |
| ready            | segmentsが1件以上あり、すべて当該seriesId。値、欠測、未記録、期限切れを回答できる |
| unknownSeries    | segments／raw／bins／coverageは空、watermark=null。不明IDという正常な回答         |
| queryUnavailable | 同じく内容を空にしwatermark=null。I/O／破損／timeout等でこの系列を回答できない    |

全体statusはqueryUnavailableが0ならready、一部ならpartial、全系列ならunavailable。unknownSeriesだけでもready。ready／partialはsnapshotIdが非null、unavailableはnull。snapshotIdは将来のquery snapshotの識別子で、H1がsnapshotを発行・固定するわけではない。

P5のinvalidRequest／busy／cancelled等はサービス操作の結末であり、H1のデータresultには含めない。無効なqueryはvalidatorのエラーとなる。transportのresponse unionを追加するときに別途対応させる。

### raw

raw modeではbinsが空。sampleの検査は同じdescriptor規則を使うが、batchと異なり複数sessionを含められる。`(sampleTimeMs,sessionId,sequence)`の昇順で安定整列し、同系列のrecordId重複を拒否する。clock逆行でsequence順と時刻順が異なっても合法。すべての点は`[from,to)`内で、系列点数と全体点数はqueryの予算以内。

同系列の`expired`／`unrecorded` coverage内（`fromMs <= sampleTimeMs < toMs`）にraw recordがあれば、値がnullでもsemantic拒否する。coverageはclockEpochで限定されないため、別epochのrecordも例外にしない。coverageのtoMs上の点は重複ではない。Bad／Stale等のcoverageは無値recordそのものを説明でき、pendingFlushは同時刻の別の未commit recordを表し得るので、一律に重複を禁止しない。

watermarkはnullまたは`{sessionId,committedThrough}`。同sessionのrawがあればsequenceはcommit位置以下。別sessionの過去rawのcommitはquery snapshotの構築責務で、v1の単一watermarkから各sessionのcommitを捏造しない。このwatermarkは直近sessionのflush進行を表示するための値であり、全期間が連続記録されたという証拠ではない。H6で複数sessionのcursorを公開する際は別版または別resultを設計する。

### minmax

minmax modeではrawが空。ready系列には少なくとも1個のbinを返し、binの半開区間は隣接してquery範囲全体を覆う。bin数は指定点数以内。複数のready系列はbinのfrom/to列が一致する共通gridを使う。v1は区間の連続・共通境界・予算・意味を検査し、均一gridの作成アルゴリズム自体は実装しない。

binは`fromMs,toMs,min,max,validCount,invalidCount,state,segmentId,source`を持つ。

| state        | 検査                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| complete     | validCount>0、invalidCount=0、finite min≤max。単一segmentと許可sourceに対応し、coverage区間と交差しない                               |
| partial      | validCount>0、finite min≤max、単一segmentと許可sourceに対応。invalidCount=0も、未実行tickなど観測数に含まれないcoverageを表すため許す |
| gap          | validCount=0、min/max=null。単一segment/sourceを指定する。SIM／unknown sourceも数値を含まないので合法                                 |
| mixedSegment | min/max=null、segmentId/source=null。複数source／型／単位／clockEpochを単一包絡に混ぜない                                             |

complete／partialはvalidCount=1ならmin=maxを必須にする。1観測から異なる極値は作れないため、元データなしでも検査できる。complete／partialのsourceは実値記録を許可する4分類。gapもsegment参照とsource一致を検査する。bool descriptorの包絡は0／1だけを許し、0.5を実状態にしない。mixedSegmentにはclockEpoch境界も含むので、descriptorが1個でも合法。countsは有効／無効の保存済み周期観測数であり、Hubの全変化件数ではない。

この純粋検査だけではmin/maxが元の全recordの真の極値か、countが真の件数かは証明できない。H2の実query fixtureで検証する。包絡rendererとピークが消えないブラウザ受入はH4へ残す。

### coverage

coverageは`{fromMs,toMs,reason}`の最大256区間。非空の半開区間でquery内にあり、from昇順かつ互いに重ならない。隣接は許す。公開前に一つの主理由へ正規化し、無制限に細分化しない。複数原因の詳細は将来の診断契約へ残す。

理由はunrecorded／expired／pendingFlush／sourceUnavailable／recorderStopped／samplingMissed／storageLoss／unknownCoverageと、sampleの無値理由。全unrecorded／expiredもquery正常完了ならreadyであり、サービス停止と混同しない。pendingFlushは値の確定欠測ではない。実commitが進んだ後に狭い窓を再要求するP5のhandoffを維持する。

coverageが256を超える結果を切り捨ててreadyにしない。v1ではその系列をqueryUnavailableとして返すか要求を狭める。将来detailTruncatedなどの拡張を入れる際は明示的に版を更新する。v1のreadyに存在しないフィールドを勝手に添えない。

## 検査の分類とfixtureの範囲

schemaが担当するものはfieldの存在／禁止、列挙値、文字数、safe整数、配列上限、周期範囲など。semanticはquery期間と総予算、identity対応、重複、sample値とQuality／sourceの整合、result状態、点の順序・端点・予算、bin包絡とcoverage、watermarkとの整合である。いずれも副作用を持たず、入力を修正しない。

fixtureはGood 0／false、Bad／Stale／Unknown、SIM除外、同名の別Hub／再作成／明示rename、同時刻別record、時計逆行、未commit／部分commit、半開区間、包絡／bool／mixedSegment、pendingFlush／unrecorded／expired、unknownSeriesとqueryUnavailable、上限超過、unsafe整数、余分な秘密field、改行IDを含む。

受理した時計逆行batchは検知器が動作した証拠ではない。同じrecord再送をfixtureで拒否することはstoreの冪等appendを否定しない。**一つの公開結果に重複recordを含めない検査**と、**別append要求の同ID再送を同じcommitとして返す保存契約**を分ける。真の恒久identity、原子的commit、crash recovery、retention、flush後補修、取消・負荷、UI寿命から独立した常時記録はH2以降の実装試験で確認する。

## H1完了と次工程

H1の完了条件は、このcanonical schemaと意味検査がRust／TypeScriptで一致し、共通fixtureの期待分類が一致すること、保存方式の比較とtransaction／recoveryの設計がレビュー可能なこと。通常Appへの接続は行わず、Project schemaを変えない。

H2は[新しいSQLite保存・検索層の暫定採用](historian-storage-decision.md)を基に、SCADA内の隔離された一時DBで実store契約を実装・検証する工程として準備できる。Industrialへの切出しやChronoGazer変更はSOAK後へ分ける。今回のfixture成功を理由に実Hub・実DB・本番サービスへ進まない。

## H1の実施結果

`scada-historian::validate_history_contract`と`lib/history-contract.ts`を実装した。canonical Schemaの後に同じ意味規則を検査し、通常AppやDBへ接続しない。Astraによる実装と契約の静的整合レビューでは具体的な不一致は見つからなかった。

- 共通fixture97件がRust／TypeScript／実Chromiumで一致した。
- Rust workspace77件成功。H1の2 test関数は共通97 fixtureと、JSON整数が1.0表記でもpanic・丸めを起こさないことを含む。Clippy `-D warnings`／rustfmt成功。
- TS114ファイル・1,366件成功。非有限値と入力accessorの例外も検査し、parseは入力を所有コピーにする。型検査0エラー・0警告、build成功。
- `e2e/history-contract.spec.ts`の1件がブラウザで全fixtureと所有コピーを確認した。既知のbuild chunkサイズ警告は残る。全体CIの確定結果はPRに記録する。

実store・原子commit・crash recovery・実Hubの継続記録は検証していない。この受入はH1のJSON契約の一致であり、H2の永続化保証ではない。

### PR #15のレビュー修正

[P2コメント](https://github.com/tyaro/temp-scada/pull/15#issuecomment-6550528324)で、raw recordとexpired／unrecorded coverageの重複を受理する矛盾が見つかった。両言語で4件の新しい負例が修正前に失敗することを確認し、同じ半開区間条件で拒否するよう修正した。無値record・別clockEpochも対象とし、toMs上の点、Bad／Stale recordを説明するcoverage、同時刻のpendingFlushは受理する。追加10件により共通fixtureは97件となった。これは既存v1契約の矛盾検査を補う修正であり、schema／contract版は変更していない。
