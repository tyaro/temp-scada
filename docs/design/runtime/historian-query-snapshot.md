# Historian H2b1: raw履歴の有限予算とsnapshot検索

2026-11-01。状態: **H2b1実装・ローカル検証済み、全体CIはPRで確認**。ユーザー指定に従いAstraが主設計した。[H1公開契約](historian-contract-fixtures.md)と[H2a保存コア](historian-atomic-store.md)を前提に、まずraw検索、snapshot整合、仕事量制限、取消と資源寿命を実装する。実装・試験結果は[実装状況](../../project/implementation-status.md)に記録する。

## 区切りと非推測の原則

H2b1はライブラリと隔離された一時SQLiteの試験まで。通常App、Historyサービス、Hub／PLC、上流Industrial、実環境のDB・設定・資格情報へ接続しない。Project0.35.0、固定SDK、Banto6.9.0、H1 JSON versionを維持する。

H2aにはsession開始・終了のUTC時刻、保持削除記録、未commitキュー、coverageの永続根拠がない。従って次を検索結果から推測生成しない。

- 保存点がないことからunrecorded／expiredと断定しない。
- closed／interruptedや最終sample時刻だけからrecorderStopped／storageLossの時刻区間を作らない。
- 最新のcommit位置や現在時刻の差からpendingFlushを作らない。
- 周期metadataから欠けたtickを数え、samplingMissedを確定しない。

既知seriesのready結果には、要求全域の`unknownCoverage`を**1区間**返す。これは「保存済みrawが存在しない」という主張ではなく、期間の連続記録と欠けた部分の理由を現storeから証明できないという意味である。rawとunknownCoverageは共存できる。rawに含むBad／Stale等の理由はrecordの事実として保持し、1点からその前後の継続時間を推測しない。

minmaxはH2b2へ分離する。とりわけ複数segmentの系列で空binへ適用すべきsegment／sourceをH2a metadataから確定できないため、最新segmentを無条件に付けてH1のgapを作らない。H2b1のraw完成をminmax・保持・復旧を含むH2全体の完成と記載しない。

## Rust APIと所有

| 操作／型                                              | 意味                                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `SqliteStore::reader()`                               | storeからownedなHistoryReaderを発行する。別のREAD_ONLY接続を使う                                              |
| `HistoryReader::query_raw(&mut self, query, control)` | H1 queryを検証してraw resultまたは型付きQueryErrorを返す。JSON Valueを入力とする場合もkind／versionを検査する |
| QueryControl                                          | 共有取消token、単調時計のdeadline、下げることだけ可能な仕事量予算                                             |
| cancel                                                | 共有AtomicBoolを立てる。query終了・資源解放の完了通知ではない                                                 |
| ReaderのDrop                                          | 自分の接続を閉じ、reader枠とwriter lockの共有所有を返す                                                       |

最終的なRust型名・メソッドの綴りは公開実装に従う。H2b1のqueryは同期処理で、背景task、timer、spawn-and-forgetを作らない。`&mut self`により1readerで同時に1queryを実行する。storeが発行する**live readerは最大2個**とし、idle readerも枠を消費する。3個目はBusyで待機queueを作らない。

readerはDB pathを外部から受け取らず、既に所有・identity確認したstoreのfactoryから発行する。writerの接続を共有せず、`open_existing`も呼ばない。reader発行でactive sessionをinterruptedにしてはいけない。DB／sidecarのpath検査と専用directoryの前提はH2aと同じである。

writerと全readerは`Arc<File>`等で同じwriter.lockの所有を共有する。writerをdropしてもreaderが一つ残れば、次のwriter ownerはBusyとなる。idle readerも明示的にdropするまで所有権を保持する。接続を閉じてから最後のlock所有を解放する。read-onlyだからとquery途中にlockを解放しない。

この方式は同一host内の所有であり、複数hostのfencingや外部writerへの保証ではない。libraryで接続・仕事量を有限にしたことを、将来のサービス全体の認証・負荷制御の完成と扱わない。

## 入力と予算

入力Valueのserialized sizeを8KiB以内に制限してからH1のquery validatorを使い、整数、半開区間、重複series、1時間、8系列、2000点／系列、全体8000点を検査する。H1として正しいminmax要求も、H2b1ではUnsupportedModeと明示し、rawへ読み替えない。invalid query・unsupported mode・事前取消はDBの検索開始前に拒否する。

| 資源       | 初期hard cap                                         | 検査                                                                    |
| ---------- | ---------------------------------------------------- | ----------------------------------------------------------------------- |
| deadline   | 受理から最大10秒                                     | `Instant`基準。要求が長すぎる／期限切れなら拒否またはdeadline結果       |
| SQLite VM  | 全要求で5,000,000命令を予算とし、1,000命令間隔で監視 | 各SQL開始時に1,000命令を先払いし、callbackごとの1,000命令も全要求で累積 |
| decode行数 | 全要求で9,000行                                      | rawだけでなくmetadata・session等の取得行も数える                        |
| 結果JSON   | UTF-8で8MiB                                          | 出力生成時も有限。超過を検知した結果は返さない                          |
| metadata   | 1系列32 descriptor                                   | SQLのLIMIT 33で超過を検知。全件取得後の制限にしない                     |
| raw        | query指定数、最大2000／系列                          | `LIMIT(maxPointsPerSeries + 1)`で超過検知。総予算も維持                 |
| reader     | 2個                                                  | idleを含む。待機queueなし                                               |

利用者は仕事量予算を小さくできるが、0・無制限・hard capを超える値を受理しない。これらは最初の実装をfail-closedにする採用値であり、実運用タグ数・保持期間に対する性能保証ではない。実測を踏まえた引上げは独立した判断とする。

VM handlerで見えない短いstatementの端数を見落とさないよう、SQL開始時の先払いも予算へ含める。これは保守的な仕事量計上で、実VM命令数の測定結果や1命令単位の停止を約束しない。SQLite外のOS I/Oが停止した場合まで10秒で強制終了できる保証もない。busy timeoutは0とし、待ち行列や長いlock待ちを隠して作らない。Rust側の行decode・result生成・validation／serializationの節目でも取消・deadlineを確認する。

SQLはbound parameterを使い、seriesIdと`sampleTimeMs >= from AND sampleTimeMs < to`を索引で絞る。ASCの`sampleTimeMs, sessionId, sequence`でrawを安定整列する。既存のobservation_time索引を使い、全DBをRustへ展開して範囲を絞る実装にしない。metadataやwatermarkの履歴検索もVM予算から除外しない。

## 1回のquery snapshot

1. 入力・controlを検証し、専用read connectionでDEFERRED transactionを開始する。
2. factoryで確認したstoreのstore_meta.last_commitを最初に読む。このSELECTでSQLite snapshotを確定する。BEGIN文だけでsnapshot確定と扱わない。
3. 同じtransactionでseries存在、descriptor、raw、session進行を取得する。query途中にwriterがappend／close／beginしても別接続の最新値を混ぜない。
4. 全系列を構成し、H1 result validatorと出力予算を検査する。未知・不整合のDB内容をGood／空結果へ修正しない。
5. handlerを解除してread transactionを終了し、statement／rows等の資源を解放してから結果を返す。

snapshotIdはUUIDv4等の64文字以内のopaque IDで、**1回のquery snapshotを識別**する。最大64文字のstoreIdとcommitを単純連結してH1上限を超えない。実装は既存lockのuuid 1.28.0をv4 feature付きで直接利用する。rusqlite 0.41.1へhooksを追加し、既存packageのversionは変更していない。IDを受け取った後に同じsnapshotへ再接続するAPIやcursorはH2b1にない。last_commitは内部の整合確認に使い、時刻によるflush watermarkへ変換しない。

取得データはcommit済みのSQLite snapshotから読み、sourceTime／sampleTime／ingestTime、clockEpoch、Quality／source／reason、number／boolをそのままH1へ投影する。source世代の内部u64はH1非公開なので返さないが、現在のHub状態で過去値を上書きしない。読み出した型・参照・公開整合が壊れていればCorruptDataとして失敗させる。全DBを完全監査したという保証ではない。

## 系列metadataとwatermark

series tableにIDがなければunknownSeries。現在のsession memberにないことだけでは不明扱いしない。既知seriesは、期間内にrawが0件でもreadyとなる。

既知seriesのdescriptorは永続segmentsから最大33件を取得する。32件超ならMetadataLimitを返し、期間内rawで参照されたdescriptorだけへ黙って縮めない。既知seriesなのにdescriptorがない場合はCorruptDataとする。返す全descriptorはH1 identity整合を満たす。これは各segmentが要求窓全域で有効だったという主張ではない。

watermarkは同snapshot内で当該seriesをmemberに含む**最新begin_commitのsession**を選ぶ。そのsessionのlast_sequenceが正なら`{sessionId,committedThrough}`、0ならnull。0の場合に過去sessionへfallbackしない。既知seriesに該当sessionがない場合はH2a原子登録の不変条件に反するためCorruptDataとする。raw窓の最後の点をwatermarkとせず、検索期間と独立した直近sessionのcommit進行を返す。

複数sessionのrawが含まれる場合、各rawのcommit済み性は同じDB snapshotによって得る。単一watermarkで過去全sessionの連続性を証明したと扱わない。writerがquery中に新tickをcommitしても、watermarkだけを後で最新化しない。

## 結果とエラー

成功はH1の`kind: result, status: ready`。query順に系列を返し、既知seriesはraw・descriptor・unknownCoverage・watermark、unknownSeriesはH1どおり空配列とnull watermarkを返す。全件unknownSeriesでも正常readyである。

H2b1は全要求を一つの成功単位とし、失敗時に部分rawを返さない。QueryErrorはInvalidRequest／InvalidLimits／UnsupportedMode／Cancelled／Deadline／TooManyPoints／MetadataLimit／WorkLimit／ByteLimit／CorruptData／Database／ReaderUnusableを区別する。reader発行上限のBusyはStoreErrorとして返す。

raw点数上限を超えた場合はTooManyPointsとし、先頭だけをreadyにしない。DB障害・取消・timeoutも空のreadyへ変換しない。H1のpartial／unavailableデータresultを構成するサービス側の変換は後続。H2b1がpartialを提供しないことを、H1契約からpartialを削除する変更としない。

安全なエラー分類だけを公開し、SQL、DB絶対パス、metadata全文、内部epochをメッセージへ混ぜない。diagnosticの詳細をどこへ記録するかはhost導入時に決める。

## 取消とcleanup

取消tokenは別threadから立てられる。query実行側はSQLite progress handlerとRust処理の節目で確認する。handlerではSQLite操作を再入させず、atomic flag・deadline・VMカウンタだけを扱う。

query本文を結果を回収できるscopeへ閉じ、成功・失敗の全経路で**progress handler解除→read transaction終了→残り資源解放**を実行する。取消handlerを有効のままROLLBACKして、cleanup自身を中断させない。cleanupは検索の仕事量予算で打ち切らず、終了確認を優先する。`?`による早期returnでこの順を迂回しない。cleanupに失敗したreaderは再利用せず、接続を閉じるまでそのreader枠／lock所有を解放しない。

同期メソッドのreturnがquery作業終了の境界である。呼出し元が独自threadへ載せて待機をやめても、cancel要求だけで終了済みと報告せず、threadをjoinする。H2b1自体は放置可能なtaskをspawnしない。正常cleanup後は別tokenの次queryを実行でき、以前の取消やVM budgetを引き継がない。

## 受入と後続

| ケース                                                                  | 合格条件                                                                        |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 数値0／bool false／Bad／Stale／SIM除外、同timestamp・別record、時計逆行 | H2a保存事実を型と理由を保ってH1 rawへ投影し、安定順・半開区間を満たす           |
| from／toに点、隣接した2窓                                               | fromを含みtoを除外。隣接窓で二重計上しない                                      |
| 窓内0点の既知series、未知ID、過去sessionのseries                        | 既知はready＋unknownCoverage、未知だけunknownSeries。現在memberだけで判定しない |
| close／interrupted／最終sampleより先の範囲                              | stopped／expired／unrecorded／pendingFlushを推測しない                          |
| snapshot確定後、別接続writerがappend／close／begin                      | raw・metadata・watermark全てが古いsnapshotで一貫し、次queryだけ新状態を読む     |
| 1系列の点数予算超過、33descriptor、低いVM／行／byte予算                 | 型付きエラー。切り捨てたreadyや無制限処理にしない                               |
| 事前取消／実行中取消／deadline                                          | handler・transactionが終了し、次queryが成功する。writer appendを停止させない    |
| query失敗や破損decode                                                   | 空の正常結果へ変換せず、cleanupを実行する                                       |
| writer drop中にreader保持、idle reader、3個目のreader                   | reader所有中は次owner Busy。枠／lockは最後の該当所有者のDrop後に返る            |
| 全ての正常response                                                      | 共通H1 validatorがaccepted。schema／版を弱めて通さない                          |

競合試験はprivate hookや同期channelでsnapshot確定点を制御し、sleepの偶然で一致を判定しない。処理量制限と取消の試験も小さい予算／明示signalで再現する。実運用DBやSOAK環境では試験しない。

H2b2でminmaxの共通grid、count・包絡、clockEpoch／segment混在、空binのmetadata根拠を実装する。H1ではgapに単一segmentが必要なため、空binを説明できない場合は推測せずqueryエラーとする方式か、事実を表せる別契約を先に設計する。時刻付き記録計画・確定coverage・retentionを追加する工程も分ける。それらができるまでH2b1のunknownCoverageを確定理由に置換しない。

## ローカル検証結果

Rust workspace112件、Clippy `-D warnings`／rustfmt、TS114ファイル・1,383件、型検査0エラー・0警告、build、関連Chromium2件が成功。H2b1の単体15件に加え、`tests/query_fixtures.rs`の1関数で実SQLiteの期待出力4ケースを照合し、同じresultをTSと実ブラウザがH1として受理した。H1共通110 fixtureは変更していない。buildの既知chunkサイズ警告は残る。

競合・未commit・取消・低予算の各経路と、authorizerでROLLBACKを拒否するcleanup障害、query内panicを試験した。cleanup失敗時は接続を閉じてreaderを再利用不可にし、枠とwriter lockはreader Dropまで保つ。Astraのread-only実装整合レビューでは追加の必須修正は見つからなかった。これらは隔離一時DBでの受入であり、実媒体・停電・Windows運用・大規模性能試験は別途必要である。全体CIの確定結果はPR本文へ記録する。

H2b2の[SQL min/max集約](historian-minmax-query.md)を追加した。`query_raw`のmode制約は維持し、別の`query_minmax`入口から同じsnapshot・control・cleanupを使う。空binのmetadata曖昧は推測せず全要求エラーとし、確定coverageは引き続き後続へ残す。
