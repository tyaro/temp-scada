# Historian H2a: 1tickの原子的保存コア

2026-11-01。状態: **H2a実装・ローカル検証済み、全体CIはPRで確認**。ユーザー指定に従いAstraが主設計した。[H1の保存比較](historian-storage-decision.md)で選んだ新SQLite層を、隔離した一時DBで検証できる最小単位へ具体化する。H2aの実装・試験結果は[実装状況](../../project/implementation-status.md)に記録し、この設計文書の存在を検証成功と読み替えない。

## 範囲と完了条件

H2aは**固定のsession記録集合に対する1tick原子append**を提供する。series／segmentの永続identity、source世代、型付き観測、commit receipt、連続sequenceを保存し、再送と停止・再openを検証する。通常App、Hub購読、PLC、製品サービス、Project設定配布には接続しない。Industrial／SOAK対象のDB・設定・資格情報へアクセスせず、上流sourceやサービスも変更しない。

History query／minmax／retention／自動coverage生成／capacity監視は後続。H2aはH2全体の完了ではない。特にinterrupted sessionを検出しても、損失時刻・件数を推測してunknownCoverageを自動生成しない。次のH2bで検索snapshotとcoverage、H2後続で保持と容量・復旧を検証する。P5の記録保証を縮めず、H2aの未提供部分を明示する。

Rustの同期保存adapterを純粋なH1 validatorと分離する。公開APIは検証済みの入力と安全な結果を扱い、fault hookや直接SQL接続を製品APIへ公開しない。同期APIは`&mut self`で直列化し、async task／timer／背景flushを作らない。実行時間の取消やserver runtimeとの分離はhost導入時の別契約とする。

## データ単位とAPI

以下はAPIの意味と型の境界であり、Rust identifierの最終綴りは実装の公開型に従う。

| 操作／型                                   | 契約                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| create(directory, StoreIdentity)           | 新規専用storeを作る。StoreIdentityはstore IDとdeployment ID。既存DBを上書きしない           |
| open_existing(directory, expectedIdentity) | 既存storeだけを開く。不存在・別identity・未知format・foreign DBを初期化して救済しない       |
| begin_session(SessionSpec)                 | session IDと固定member集合を永続化する。同時にactiveなsessionは1つ                          |
| append_tick(Tick) → CommitReceipt          | 全memberを1回ずつ説明する1tickをtransactionで保存。呼出し側のcommittedThroughは受け取らない |
| close_session(sessionId)                   | active sessionを閉じる。closeしたsessionへ新しいtickを追加しない                            |
| session_status(sessionId)                  | active／closed／interruptedと最後のcommit済みsequence等を取得する。History queryではない    |

SessionSpec.membersは1〜8系列で、各seriesIdに1個のH1 identity descriptorを持つ。全memberのperiodMsは一致し、**1sessionを1周期group**とする。memberの追加／削除、周期・source・segmentの変更はこのsessionを閉じ、新sessionで行う。複数周期groupの同時記録や適用計画のhot swapは後続recorderで設計する。session IDは再利用せず、同IDの再送は既存状態の照会として扱う。

Tickはsession ID、sequence、clockEpoch、sampleTimeMs、ingestedAtMs、およびmemberごとの観測を持つ。観測はseriesIdとsourceTimeMs／Quality／source／型付きvalue／reason、任意のSourceEpoch。segmentは固定memberに束縛する。recordIdは`(seriesId,sessionId,sequence)`として構成する。tick時刻とclockEpochを各recordに投影し、観測ごとのsource時刻を保持する。

入力のH1部分をsampleBatch（committedThrough=null）へ構成し、既存のschemaと意味検査を通す。加えて全memberがちょうど1回あること、過不足・重複がないことを検査する。H1が許す任意のsampleBatchをそのままappendするAPIにはしない。Bad／Stale／SIM除外等の無値観測も1member分の説明として数える。

sequenceは1から開始し、未保存の新tickは`lastCommittedSequence + 1`だけを受ける。順序外の保留キューや穴の自動補完を作らない。safe整数上限の次へ進めず新sessionを要求する。H2aには実時計のスケジューラがないため、sequenceは入力tickの連続番号であり、壁時計から未実行tick数を算出しない。

## 永続identityとsource世代

同じseriesIdのhubInstanceId／incarnationIdは不変。Hub＋incarnationを別seriesIdへ割り当てない。同じ`(seriesId,segmentId)`のdescriptorは不変であり、unit・source・型・周期・名前の変更を上書きしない。新segmentで明示的に継続する。同名の別Hub、同名再作成の新incarnationは別系列として保存できる。この整合性は一つの入力だけでなく、既存DBの対応表とも照合する。

SourceEpochは`hubInstanceId, runId: Option<u64>, catalogRevision: u64, sdkGeneration: u64`を保持する。観測のsource／Quality／sourceTimeのいずれかが非nullなら必須とし、Hub個体はmemberと一致する。全て未観測ならNoneを許す。これらは同一SDK snapshotから得るべき記録入力であり、H2aのstoreがSDKへ問い合わせたり最新catalogから補完したりしない。

SourceEpochを正規化した論理内容でdedupし、DB内部のepoch IDで観測から参照する。clockEpochとsource世代は別の概念で、片方で他方を代用しない。Hub再起動／再接続時にSDK世代が変わっても、その値をrecordと同じtransactionで保持する。同じtick・同じHubのSourceEpochは等値を必須とし、異なる世代の混在を拒否する。別Hubの世代差と未観測Noneは許す。

## 型付き論理payloadの比較

同じtick IDの再送は**型付き論理payloadが等しい場合だけ**既存receiptを返す。JSON objectのfield順や整数の`1`／`1.0`表記、member／観測の入力順によって結果を変えない。SessionSpec.membersとTick.observationsはseriesIdで正規化する集合であり、UIの表示順ではない。

- ID、文字列、null、列挙値は意味を変えず保持する。名前をtrim・Unicode正規化して別の名前と同一視しない。
- H1の整数fieldは検証後のsafe整数として正規化する。値のnumberはfinite f64、−0と0は同値。bool trueと数値1は別。
- **SourceEpochのu64を再帰的なf64変換へ通さない。** 2^53を越える世代値が丸められると別世代の再送を同一と誤判定する。内部canonical representationではrunId／catalogRevision／sdkGenerationを10進文字列（runIdなしはnull）にして保持する。公開H1 DTOの時刻・sequenceとは別の内部表現である。
- 冪等比較は内部DB epoch IDではなくSourceEpochの論理内容を使う。自動採番や挿入順が違っても、同じ世代は同じ内容と判定する。
- canonical文字列の一致は上記正規化済みpayload同士で行う。raw JSONのhashだけを一致判定にせず、未知fieldも受理しない。

例としてcatalogRevision=`9007199254740992`と`9007199254740993`は異なるpayloadであり、同tick IDならconflictになる。u64最大値も切り詰めず往復する。

## SQLiteの最小schema

新SQLite依存はH2aで明示追加する。adapterはrusqlite 0.41.1（default-features=false、bundled）とlibsqlite3-sys 0.39.1をlockへ固定した。既存依存versionは変更していない。SQLite設定はforeign_keys=ON、trusted_schema=OFF、journal_mode=WAL、synchronous=FULL、wal_autocheckpoint=1000、busy_timeout=0。全SQLはbound parameterを使う。foreign_keysを有効化し、WALと保守的な同期設定を明示して、driver既定値へ依存しない。format確認は既存DBへwriteするPRAGMAやmigrationより前に行う。

| 表              | 主な内容と制約                                                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| store_meta      | singleton、DB format version、store ID、deployment ID、global commit counter                                                           |
| series          | seriesId主キー、hubInstanceId／incarnationId、Hub＋incarnationのunique制約                                                             |
| segments        | `(seriesId,segmentId)`主キー、正規化descriptor。seriesへのFK                                                                           |
| sessions        | sessionId主キー、active／closed／interrupted、正規化spec、最後のcommit済みsequence、開始／終了状態                                     |
| session_members | `(sessionId,seriesId)`主キー、固定segment。session／segmentへのFK                                                                      |
| source_epochs   | DB内部epoch ID、正規化SourceEpochのunique内容。u64値の精度を保持                                                                       |
| commits         | global commit version、sessionId／sequenceのunique組、正規化tick payloadとreceiptの復元情報                                            |
| observations    | `(seriesId,sessionId,sequence)`主キー。segment、clockEpoch、3種の時刻、Quality／source／reason、型付き値、source epoch参照、commit参照 |

値はnumber用REALとbool用INTEGERを分け、boolは0／1、無値は両列NULL。CHECKで両値の同時保持を拒否し、型・無値理由の整合も検証する。sampleTimeMsを主キーにせず、同timestampの別recordを保持する。検索用索引は`(seriesId,sampleTimeMs,sessionId,sequence)`を基準にするが、H2aはHistory queryを提供しない。

global commit versionはDB transactionで採番する。begin／close等でも採番する実装ならtick receipt間の番号が連続とは限らない。tickの連続性はsession sequenceで判断し、commit versionの穴から欠測を推測しない。DB format版はH1 JSONのversionと独立する。

## transactionと再送

begin_sessionはidentity／segment／member／sessionを一つのtransactionで保存する。sessionを登録しただけで観測がない状態は正常。tick側ではsource epoch、observations、commit receipt、sessionのlast sequence、global counterを同transactionでcommitする。

appendは次の順序で判定する。

1. 入力の構造・H1意味・固定memberとの対応を検査し、正規化payloadを作る。
2. 同session／sequenceのreceiptが存在すればpayloadを比較する。同内容なら同じreceiptを返す。別内容ならconflictで、既存観測・metadata・counterを変更しない。
3. 新tickならsessionがactiveでsequenceが次の番号か確認する。closed／interruptedには追加しない。
4. source epochと全観測、receipt、sequence／counterを同transactionで書く。COMMIT成功後にだけreceiptを成功応答として返す。

再送判定はsessionのactive判定より先に行うので、close後や再openでinterruptedとなったsessionでも**保存済みtickの確認**ができる。古いsessionを再開する権限は与えない。begin_sessionの同ID同spec再送も既存状態を返し、closed／interruptedをactiveへ戻さない。同ID別specはconflict。

COMMIT前にSQLが失敗した場合はrollbackする。rollbackの完了を確認できない場合やCOMMIT結果が不確かな場合に、確実に未保存と断定して新IDで再送させない。SQL／I/O失敗後はstoreをNeedsReopen状態にして新しいwriteを拒否し、再open後に同tick IDのreceiptを照会する。エラーは安全な分類を返し、SQL・絶対パス・内部payloadを公開結果へ混ぜない。

## ownershipと再open

APIの対象は専用directoryと固定名`store.sqlite3`／`writer.lock`に限定する。directoryをcanonical化し、DB symlinkを拒否する。writer.lockもsymlinkを拒否し、既存lockファイルを削除・再作成して別inodeへ切り替えない。stdのファイルlockでプロセス間排他を取得し、取得できなければDBへ触る前にBusyとする。DBファイルのhardlink、外部からのファイル置換、ネットワーク共有、協調しない別writerは非対応である。

排他取得後のopen_existingはformat／identityを確認し、残ったactive sessionをtransactionでinterruptedへ変更する。これは前所有者が終了確認を保存していない事実の記録であり、正確な停止時刻や損失量を断定しない。新しい記録は新session IDで始める。同一owner内の明示closeと、プロセス消失後のinterruptedを区別する。

接続を閉じてからlockを解放する。H2aには切り離された背景taskがなく、所有権の終了は同期的である。将来async保存・retention taskを導入したときはjoin完了まで排他を保持するP5契約を引き継ぐ。単一hostの排他を複数hostのfencing保証と呼ばない。

## 障害注入と受入

fault hookは保存core内のprivateな試験用機構とし、公開integration用APIや製品設定にはしない。テストは自分で生成した一時directory／SQLiteだけを使う。return-errorによるrollbackとchild processの即時終了を分けて検証し、正常なDropが走った試験だけでcrash耐性を主張しない。

| ケース                                                              | H2aの合格条件                                                                          |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 2系列の正常tick、Good 0／false、無値観測                            | 全member、型、Quality／source／reason、source epochが復元でき、receiptとsequenceが一致 |
| member欠落／余分／重複、異周期session、順序外sequence               | DBへ部分保存せず拒否。次の正しいtickを受けられる                                       |
| 同timestampの別sequence、明示clockEpoch付き時計逆行                 | 古いrecordを上書きせず両方残る。時刻の単調化をしない                                   |
| field順、1／1.0、−0／0、member／観測順だけを変えた再送              | 同一receipt。record数・counterが増えない                                               |
| 同IDの値・Quality・時刻・source epoch変更                           | conflict。既存payloadを保持                                                            |
| u64世代の2^53境界と最大値                                           | 精度を保持し、隣接する異なる世代を同一としない                                         |
| 既存seriesのHub／incarnation変更、別seriesへのincarnation二重登録   | DB全体との照合で拒否。session登録もrollback                                            |
| source epoch追加後／観測の一部追加後／counter更新後、COMMIT前に失敗 | 全てrollback。孤立epoch、部分観測、進んだreceipt／sequenceを公開しない                 |
| transaction途中でchild process終了                                  | 再openで未commit tickがなく、sessionはinterrupted。新tickで旧sessionを継続できない     |
| COMMIT直後・応答前にchild process終了                               | 再open後の同payload再送で保存済みreceiptを返し、二重記録しない                         |
| 2プロセスで同じdirectory、symlink経由の同directory                  | 2つ目はBusy。所有者終了後は再取得できる                                                |
| foreign DB／未知format／別identity／DBやlockのsymlink               | 拒否して対象を初期化・上書きしない                                                     |
| close後／interrupted後の再送と新tick                                | 保存済み同payloadだけreceiptを返す。新tickは拒否                                       |

内部観測の確認用SQLはテストから一時DBだけに使い、UIのDB直読や公開History APIにしない。容量不足・媒体I/O障害・電源断・Windows運用・queryとの競合・retentionとの原子性は、このprivate hookとprocess終了試験だけでは検証できない。H2後続／H3以降の未完了事項として残す。

## H2aのローカル検証結果

Rust workspace96件（新規保存コア19 test関数、child worker含む）、Clippy `-D warnings`／rustfmt成功。H1共通110 fixtureは変更せず成功した。上表の原子性・再送・型・identity・世代・排他・format・process終了を使い捨てDBで検証し、Astraの実装整合レビュー後の再確認では追加の必須修正は見つからなかった。SQL失敗はTEMP triggerによる注入であり、実媒体I/O障害ではない。全体CIはPR本文で確定結果を記録する。
