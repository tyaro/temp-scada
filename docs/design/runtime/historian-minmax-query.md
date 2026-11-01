# Historian H2b2: 共通gridのmin/max集約

2026-11-01。状態: **H2b2実装・ローカル検証済み、全体CIはPRで確認**。ユーザー指定に従いAstraが主設計した。[H2b1 snapshot検索](historian-query-snapshot.md)へSQL側のminmax集約を追加する。H1 JSON version、DB format、Project、SDK、Bantoの版を変更しない。実装・検証結果は[実装状況](../../project/implementation-status.md)へ記録する。

## 範囲とAPI

ライブラリと隔離一時DBでminmaxを検証する工程であり、通常App、描画、HTTP／認証、上流Industrial、実Hub／PLC／DB／設定へ接続しない。H2b1のraw動作を維持する。保持・時刻付き計画metadata・確定coverageの追加も今回に含めない。

HistoryReaderにminmax要求を実行する入口を追加する。公開入口は`HistoryReader::query_minmax(query, control)`。query_rawにminmaxを渡してrawへ読み替える動作は作らない。実装内部ではreader、snapshot、control、metadata取得、watermark、H1 resultの最終検証、cleanupを共通化できる。

H1 queryのmode以外の制約は共通。最大1時間、8系列、2000点／系列、要求系列数×点数≦8000、半開区間を維持する。成功は全要求のreadyで、未知IDだけunknownSeries。一部系列の失敗や仕事量超過では型付きエラーとし、部分的な包絡を正常結果として返さない。

## 共通grid

整数ミリ秒の`width = toMs - fromMs`、要求点数を`P`とする。H1検証後に次を計算する。

```text
N = min(P, width)
boundary(k) = fromMs + floor(k * width / N)   (0 <= k <= N)
bin(k) = [boundary(k), boundary(k+1))        (0 <= k < N)
```

全てのready系列が同じN個のbinを返す。N≧1で空幅のbinはなく、先頭はfrom、末尾はto。幅は最大1msだけ異なる。タグ周期・series数・現在metadataによってgridを変えない。未知seriesにはH1どおりbinを返さない。

範囲内recordの`offset = sampleTimeMs - fromMs`に対するSQL bin番号は次とする。

```text
binId = (((offset + 1) * N) - 1) / width
```

SQLite INTEGERの除算で求める。素朴な`offset*N/width`はfloor境界と一致しない場合があるため使わない。例としてwidth=10、N=3では境界は0,3,6,10で、offset=3はbin1。to上のrecordはWHEREの半開条件で除外する。

H1検証済みwidth≦3,600,000、N≦2000なので中間積は最大7,200,000,000。32bitを使わず、Rust／SQLとも整数で計算する。UTC時刻が負でも、範囲内offsetは非負であり除算の丸め差が起きない。絶対UTCを浮動小数へ変換してbinを求めない。

## SQL集約の形

各seriesについて、既存observation_time索引で範囲を絞り、SQL側でbinごとに集約する。raw queryの`maxPoints+1`制限を観測数へ流用しない。例えば10,000観測を100binに集約する検索は、ほかの予算内なら成功できる。

概念上の処理は次の通り。実SQLはbound parameterと、検証済みmetadataから構成する有限の対応表を使う。

1. `series_id = ? AND sample_time_ms >= ? AND sample_time_ms < ?`で観測を選び、整数binIdを計算する。
2. 各観測を当該segmentのdescriptorと照合し、有効値・正しい無値・破損を区別する。
3. `GROUP BY binId`で総観測数、有効数、無値数、finiteな極値、segmentと時計・source世代の混在、破損件数を計算する。
4. 最大N行の非空bin要約だけをRustへ渡す。RustがN個のgridを作り、SQLに存在しない空binを下記規則で補う。

必要な集約情報は`totalCount, validCount, invalidCount, min, max, segmentCount, oneSegmentId, clockDomainCount, sourceEpochCount, corruptCount`等。最終的な列名・CTE分割は実装に従う。複合distinctに曖昧な文字列連結を使わない。実装はsession_idとclock_epochそれぞれのMIN/MAX差のORで複合domainの混在を判定する。segmentとsource epochもMIN/MAX差を使い、NULL source epochを世代差へ加算しない。

中間domainのGROUP BYを使う場合も、Rustへ返すのはbin要約までとする。多数のrecord／domainをRustで列挙してから間引く方式にはしない。SQL内部の走査・集約・distinctの費用はVM／deadline予算で制限する。

## 有効値と破損の区別

validCountは、H1として有効なGood値の周期観測数。numberはfinite数値、boolは整数0／1として極値を計算する。invalidCountは**H1として正しい無値record数**であり、破損行数ではない。`totalCount = validCount + invalidCount`を維持する。同timestampの別recordは別観測として数え、timestampでdedupしない。期間内recordが同source時刻を繰り返し持っていても、周期観測の件数として数える。

SQLは少なくとも、descriptor参照の存在、値列の排他と型、source一致、Quality／source／reasonと値の整合、有限性を検査する。NULLの三値論理で不正条件が検査をすり抜けないようにする。sourceUnavailable等の未観測source=nullは、descriptor.sourceへ無断で補完しない。無値recordの分類にはH1の理由規則を使う。

破損をinvalidCountへ畳まず、`corruptCount > 0`等を全要求のCorruptDataとして扱う。minmaxで見えなくなる不正行を、MIN／MAXのNULL無視やmixedSegmentへの変換で隠さない。特に同一segmentのrecord.sourceがdescriptorと異なる場合は正常なsource混在ではなく不整合である。

既知seriesのdescriptor全体はH2b1と同じLIMIT33／最大32で取得し、identity／型／sourceの契約を検査する。公開resultのH1検査だけでは元recordの異常や極値の正しさを証明できないので、SQL集約の述語と保存fixtureの比較を別に試験する。全DBの完全監査を提供するものではない。

## 混在domain

bin内の観測を次の軸で評価する。有効値だけでなく正しい無値recordもsegment・時計domainの判定対象とし、無効な期間を跨いだ意味変更を隠さない。

| 軸         | 判定                                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------- |
| segment    | 異なるsegmentIdが2つ以上ならmixedSegment。descriptorが同じ型／sourceでもunit等の意味が変わり得るため統合しない        |
| 時計       | `(sessionId,clockEpoch)`が2つ以上ならmixedSegment。別sessionが同じ文字列clockEpochを使っても同一時計区間と仮定しない  |
| source世代 | 非nullのsource_epoch_idが2つ以上ならmixedSegment。Hub run／catalog revision／SDK generationの境界を単一包絡へ畳まない |

source_epochsはH2aで論理内容によりdedupされるため、IDの差は記録時のsource世代の差として使える。内部u64を集約のためにf64へ変換しない。NULL source epochは未観測であり、distinct世代へ加算しない。例えばGood(epoch A)とsourceUnavailable(epochなし)は、それだけで混在とはせずpartialにできる。epoch Aとepoch Bは同じsourceラベルでも混在になる。

source世代境界を混在へ含めるのはH2b2の保守的な集約規則である。H1 shapeは変更せず、mixedSegmentのnull包絡で示す。metadataや現行設定を使って世代の違いを無視しない。

## bin状態と空bin

全ready系列はH2b1と同じく要求全域のunknownCoverageを1区間持つ。従ってH2b2は**completeを生成しない**。保存点の極値と、期間の連続性を分ける。

| 条件                              | 返すbin                                                                                                                            |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 非空で上記domainのいずれかが混在  | mixedSegment。min/max/segmentId/sourceはnull。有効／無値件数は保持                                                                 |
| 非空・単一domain、有効値が1件以上 | partial。検証済み有効値のmin/max、単一segmentとdescriptor.source、両件数を返す。invalidCount=0でもunknownCoverageがあるためpartial |
| 非空・単一domain、有効値0件       | gap。min/max=null、validCount=0、保存された無値件数、観測が参照したsegmentとdescriptor.source                                      |
| 空で永続descriptorがちょうど1つ   | gap。両件数0、min/max=null、唯一のsegment/sourceを返す                                                                             |
| 空で永続descriptorが複数          | MetadataAmbiguous等の型付きエラーで全要求を失敗。最新・直前・直後のsegmentから補完しない                                           |

空binに唯一のdescriptorを添えるのは、seriesについて登録されている唯一の型情報を識別するためであり、その期間に計画が適用されていた証明ではない。unknownCoverageを維持し、unrecordedやexpiredへ変換しない。既知seriesにdescriptorが0ならH2b1と同様CorruptDataである。

複数descriptorでも全binが非空なら、各binの観測根拠から単一／混在を判断できる。全期間を通じてdescriptorが複数という理由だけで常に失敗させない。空binを便宜的にmixedSegmentにするのも、実際に複数のdomainを観測した事実がないため採用しない。

boolの包絡はfalse=0、true=1。両状態があればmin=0/max=1で、0.5を状態として出さない。validCount=1ならmin=max。有効値0ならmin/maxともnull。mixedSegmentでは、内部で極値を計算できても公開包絡を返さない。

## snapshot・予算・取消

H2b1の所有とcleanupをそのまま使う。専用READ_ONLY接続、最大2reader、writer.lock共有、最初のstore_meta読取でsnapshot確定、同transactionでmetadata／集約／watermarkを取得する。UUID snapshot ID、最新begin_commitのsession進行、全要求の成功／エラーという意味も変えない。

SQLごとの1000命令先払い＋1000命令間隔callback、全要求5,000,000 VM予算、9000 decode行、8MiB出力、最大10秒deadlineを維持する。decode行数は**SQLiteからRustへ取得するmetadata・bin要約・進行情報の行数**であり、SQLが集約対象として走査する元観測数ではない。元観測数はVM／deadlineによって有限化する。入力観測数が9000を超えたという理由だけでminmaxをTooManyPointsにしない。

Rustが補う空binにも出力byte予算と取消／deadline確認を適用する。最大2000bin／系列と総8000点を越えない。SQL内部の一時領域やOS I/Oを出力JSON上限で完全に制限できるという保証はしない。VM予算は実測容量保証ではなく、内部費用の保守的な制限である。

集約中のVM中断、metadata曖昧、破損、予算超過、取消のどの経路でもhandlerを解除してからread transactionを終了する。cleanup失敗はreaderを再利用不可にし、接続が閉じるまでownershipを返さない。集約を別threadへ放置してエラーだけ返さない。

## 受入

| ケース                                                      | 合格条件                                                                          |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------- |
| width10／N3、負のUTC、幅より大きい指定点数、from/to上の点   | floor境界とSQL binIdが一致し、全ready系列のgridが同一。0幅や二重計上なし          |
| 9000件超の元観測から少数bin                                 | SQL側で集約し、予算内なら成功。rawを全件decodeしない                              |
| 短い山、Good 0、負値、bool両状態                            | 真のmin/maxとcountを保持。中点化や平均化なし                                      |
| Good＋Bad／Stale／SIM除外等                                 | 正しい無値件数を保持し、有効値だけの包絡。unknownCoverageが残りcompleteを返さない |
| 同timestamp・別sequence                                     | 全recordを数える                                                                  |
| segment変更、同clock文字列の別session、同sessionのclock変更 | mixedSegmentで包絡を隠しcountsを保持                                              |
| 同segment・時計でsource世代A/B、A＋未観測None               | 前者はmixed、後者は単独でmixedにせずpartial/gap規則を適用                         |
| 非空gap、descriptor1つの空bin                               | 正しいsegment根拠とnull包絡。空はcount0/0                                         |
| descriptor複数＋空bin、複数だが全bin非空                    | 前者は全要求のMetadataAmbiguous、後者は観測に基づく正常結果                       |
| 不正値型／source／reason／欠けたdescriptor                  | corrupt行を数値集約やinvalidCountへ隠さずCorruptData                              |
| snapshot確定後のappend・新session・新segment                | 同queryのmetadata／集約／watermarkが旧snapshotで一致。次queryだけ新状態           |
| 低いVM／行／byte予算、集約中取消、deadline                  | 全要求エラーとcleanup。次queryやwriterのappendが継続可能                          |
| 全成功response                                              | H1 validator accepted。元のfixture recordから計算した期待極値・件数とも一致       |

SQLiteの実queryを使う一時DB試験と、gridの整数境界試験を組み合わせる。テストの期待値に実装と同じSQL式だけを複写せず、具体的な境界・極値・件数を照合する。実DBの性能測定、描画で山を保持する受入、retentionや確定coverageの生成は後続である。

## ローカル検証結果

Rust workspace126件（H2b2単体13件とminmax共通fixtureの統合1関数を追加）、Clippy `-D warnings`／rustfmt、TS114ファイル・1,389件、型検査0エラー・0警告、build、関連Chromium3件が成功。実SQLite出力6成功ケースとMetadataAmbiguous1失敗をRustで比較し、成功resultをTS／実ブラウザと共有する。従来のH1共通110 fixtureとraw出力4ケースを維持した。

9,001tickの集約をdecode予算20行で成功させ、短い山と件数を保持した。既存H1のaccepted sampleBatchから観測を再保存してSQLの型・Quality・source・無値理由が一致することも確認。SQLのCorruptData検査はmixedSegmentへの変換より前に行う。集約SQLのprepare中に同期signalで取消し、writerのappendと取消後のreader再利用が成立することを試験した。OS I/Oの厳密な停止時間・実運用規模の容量性能・描画受入を保証するものではない。

Astraのread-onlyレビューで、SQLiteのlength／GLOBがNUL以降を見ないため不正時計IDを受理する問題を発見した。修正前に失敗する回帰例を追加し、session_id／clock_epochへinstr（文字列、char(0)）=0を明示して拒否した。修正後の再確認では必須修正の残りは見つからなかった。依存・DB format・H1 schema／版は変更していない。buildの既知chunkサイズ警告は残り、全体CIはPR本文に記録する。
