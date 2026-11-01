# Historian H2c3: SQLite 容量不足時の原子性と復旧

2026-11-01。状態: **Astra 主設計。実装・ローカル検証済み、全体CIはPRで確認**。[保持削除](historian-retention.md)、[容量診断・PASSIVE checkpoint](historian-maintenance.md)、[原子保存](historian-atomic-store.md)を前提とする。

## 次の小区切り

H2c3 は、隔離した一時 DB で実際の SQLite `SQLITE_FULL` を発生させ、保存 transaction の rollback、writer の NeedsReopen、receipt を使う復旧判断を検証する。これまでの任意 error／process 終了注入に加え、SQLite 自身が容量不足で transaction を自動 rollback する経路を扱う。

製品設定や時刻信頼を仮定せず、現 library だけで再現・検証できるため、この工程を自動保持や receipt GC より先に選ぶ。DB format 3、H1、保存 API、SDK、Project、Banto、依存を維持する。通常 App／上流／実 Hub・PLC・DB へ接続しない。workspace や OS volume 全体を埋める試験は行わない。

## API とエラーの境界

容量不足のための新しい公開書込み API、容量設定、再送 queue は追加しない。現行 `StoreError::Sqlite(rusqlite::Error::SqliteFailure(...))` の `ErrorCode::DiskFull` を機械判定に使用する。文字列の「full」等で分類しない。既存 Display が path や内部 SQL を UI へ流さない方針も維持する。

| 事象                                                | library の結果と状態                                             |
| --------------------------------------------------- | ---------------------------------------------------------------- |
| SQLite FULL                                         | 元の SQLite 原因を返し、writer を needs_reopen にする            |
| その他の実 SQLite／I/O 障害                         | 既存の保守的な poison 規律を維持                                 |
| 正常な入力拒否、Conflict、RetentionCutoff、予算上限 | 容量不足へ変換しない。副作用・poison は既存契約に従う            |
| progress handler による SQLITE_INTERRUPT            | 対応する取消／deadline／work-limit があれば Control として返せる |
| cleanup 失敗                                        | 直接 needs_reopen を保持。元障害より安全な再open要求を優先できる |

今回の小さな production 修正候補は、retention／maintenance の SQL error→Control 変換を厳密にすることである。現行の「SQL error 時に budget が切れていれば全て Control へ変換」という処理では、FULL／IOERR と取消が併発したとき元原因と poison が失われ得る。変換対象を SQLite primary `OperationInterrupted` に限定する。FULL と同時に cancellation が立っても FULL を保持し、writer を再利用可能にしない。`SQLITE_INTERRUPT` でも対応する Control 原因がなければ、推測で Cancelled を作らず元の SQL error とする。

これは診断分類の精密化であり、すべての storage error を retryable と宣言する変更ではない。容量不足を見つけても library が自動 trim、期限内削除、checkpoint の強制昇格を行うことはない。

## transaction の原子性

SQLite は FULL 等で transaction 全体を自動 rollback する場合がある。エラー後に transaction が存続していると仮定せず、`is_autocommit()` と既存 guard に従う。rollback は cancellation handler を解除してから実施し、すでに autocommit に戻っていれば存在しない transaction を再度 rollback する必要はない。

実 FULL を返した書込みが成功 receipt を返さないこと、counter／metadata／observations／receipt／frontier／ledger が部分 commit されないことを確認する。`is_autocommit()` だけで原子性を証明せず、実表の内容と公開 query を比較する。

- begin: plan／series／segment／session／members／開始証拠と counter をまとめて rollback。
- append: source epoch／commit payload／全 member observations／sequence／frontier と counter をまとめて rollback。
- gap: gap 本文／frontier と counter をまとめて rollback。失敗した区間を成功した欠測証拠にしない。
- trim: operation／expired ledger／observations の除去／fence と counter をまとめて rollback。DELETE 前の ledger 挿入自体が容量不足になり得るため、trim を容量不足時にも必ず成功する救済処理とは考えない。

close／interrupt の値更新だけで新規 page 割当が不要なら、max_page_count では FULL を発生させられないことがある。固定 test fixture の page 配置に依存して無理に各 operation の FULL を要求せず、実際に生じた SQL 経路を明示する。既存の任意失敗／process 終了試験は引き続き別の証拠として維持する。

## 再送と再openの正確な意味

失敗した writer は、その connection 上で入力を変えて書込みを続けない。needs_reopen 中の append／begin／gap／trim／新 reader 発行／保守 API は既存の check_writable に従う。poison フラグを public API で解除する経路を作らない。

復旧の手順は次のとおり。

1. 呼出側が未確定の入力 ID と元の typed payload を保持する。値や sequence を勝手に変更して同じ ID を再利用しない。
2. storage の原因を解消する。試験では private な max_page_count 制限を解除／拡大する。製品では容量確保等の運用が必要であり、その自動化は今回含めない。
3. writer と reader を終了して owner lock の寿命を終える。既存 reader が生存していれば次 owner は Busy のままでよい。
4. 同じ store／deployment identity で open_existing。形式・整合・FK 検査と未終了 session の interrupted 化を行う。
5. operation ごとの既存 receipt／状態を使い、成功済みと未保存を区別する。

| 元の操作                      | 再open後の扱い                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------- |
| commit 済み tick の同内容再送 | 元の receipt。新しい observations や counter を作らない                          |
| 未commit tick の再送          | 旧 active session は interrupted のため SessionInactive。旧 session を再開しない |
| 未成立 begin                  | session が存在しなければ同 ID・同内容で再試行できる                              |
| commit 済み begin             | 元の session 結果。interrupted になっていても再開始を意味しない                  |
| commit 済み gap               | 同 ID・同内容は元 receipt                                                        |
| 未commit gap                  | 旧 session が interrupted なら新規登録不可。失敗区間を後付け成功へ変えない       |
| commit 済み trim              | 同 request は元 receipt。再削除／fence 再進行なし                                |
| 未commit trim                 | 期待 cutoff が変わらず他条件を満たせば、同 request で再試行可能                  |

「再openすれば失敗 tick を旧 session に保存し直せる」とは説明しない。記録再開には新 session が必要である。未保存 sample の再投入を許す host/spool 方針は未実装であり、時刻の付け替えや別 recordId での自動複製を library が行わない。既存 receipt があれば同 ID の完了を確認できることと、全入力の無損失再送を保証することは別である。

open_existing 自体も active session を interrupted へ変更する書込みを含む。容量不足が未解消なら reopen も失敗し得る。読み書き可能な store を返すまで復旧完了とせず、再open成功を媒体の将来健全性の保証にも使わない。

## 容量不足の再現方法

SQLite の `PRAGMA max_page_count` を、使い捨て DB の private test connection にだけ適用する。page_count／freelist_count／設定結果を読み、DB 増大が必要な正当な書込みで `SQLITE_FULL` が返ることを確認する。固定ページ数や SQL エラー文字列だけに依存しない。

- 少なくとも通常の append の production SQL 経路で、本物の DiskFull を観測する。
- trim の ledger／operation を増やす workload でも実 FULL を試し、削除や fence だけが進まないことを確認する。
- plan／gap など追加経路は、再現性のある bounded fixture を用意できる範囲で実 FULL を確認する。再現できない経路をテスト済みとして列挙しない。
- 入力は H1 と既存固定 member 制約に適合させ、Schema／Semantic／WorkLimit に先に落ちた結果を FULL 試験成功と数えない。
- test 専用の圧力用 fixture が必要なら production schema・公開設定へ持ち込まず、その役割と失敗した SQL の位置を明記する。
- ループには回数／追加 byte の上限を付け、FULL が得られなければ明示的に失敗する。workspace の空き容量を枯渇させない。

max_page_count は SQLite の論理 DB page 増大を制限する。filesystem の ENOSPC、WAL file の物理増大上限、fsync failure、部分 sector 書込み、電源断を再現するものではない。WAL／checkpoint の容量障害を同じ試験で証明したことにしない。

制限の解除は private test 準備として行い、poison 済み library の公的な操作で継続書込みする迂回路を提供しない。接続を閉じるだけで制限設定がどう扱われるかは実測して確認し、暗黙の設定リセットを製品復旧契約へ組み込まない。

## snapshot と live の分離

FULL 前に確定した History snapshot は、未commitの失敗書込みを含めない。既存 reader を使う試験では、失敗前後で raw／coverage が同じ確定状態を示すことを確認する。storage の破損・I/O障害全般で reader が常に成功するとは保証しない。

再openで interrupted の metadata が増えても、停止時刻や失った tick 数を推測しない。失敗した tick／gap／trim に基づく expired、storageLoss、pendingFlush を勝手に合成せず、既存の unknownCoverage と明示証拠の規則を維持する。

Historian の失敗は Hub の値品質を Bad へ変更する根拠ではなく、SCADA server の警報評価や ACK の停止理由にも直結させない。将来 host は Historian の degraded とライブ値の Quality を別の状態として扱う。この工程は library における境界契約であり、未実装の service／recorder の実際の障害分離を検証したとはしない。

## 最小受入

| ケース                       | 合格条件                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| append が実 FULL             | DiskFull、needs_reopen、成功receiptなし。metadata／全member／counter／frontier が旧状態 |
| FULL後の同writer操作         | NeedsReopenで拒否。sequenceを飛ばして継続できない                                       |
| 容量回復・再open             | 旧activeはinterrupted、正常end時刻を作らない。既commit receipt は再取得できる           |
| 失敗tickの旧session再送      | receipt不在ならSessionInactive。新session再開と区別                                     |
| trim ledger等が実 FULL       | raw残存、expired／operationなし、旧fenceとcounterを保持                                 |
| 未commit trim の同要求再試行 | 容量回復後に一度だけ成功。さらに再送しても同receipt                                     |
| FULLとcancel／deadline併発   | FULLをControlへ隠さずpoison。内部分類試験と実FULL経路を併用                             |
| 通常SQLITE_INTERRUPT         | 対応Controlを保持、正常cleanup後の既存再利用契約が維持される                            |
| old reader snapshot          | 失敗transactionの部分データが見えない。owner lock寿命も維持                             |
| 元成功後の応答喪失           | 既存process故障試験を回帰し、元IDの再送で重複しない                                     |
| 証拠／begin等の追加実FULL    | 実際に検証した経路と未検証経路を結果へ明記                                              |

復旧後の table 整合、公開 raw／minmax／coverage、receipt、fence、source epoch の残存／非残存を確認する。新規試験に加え既存保存・保持・checkpoint・取消・process crash を回帰する。意図した所有者がいない fixture reopen では既存 bounded Busy retry helper を使用できるが、所有競合や reader lease の拒否試験は production の即時 Busy を維持する。

## 出典と残りの工程

固定 SQLite header の sqlite3_get_autocommit 定義は、FULL／IOERR 等で transaction が自動 rollback され得ることを説明している。[SQLite autocommit API](https://www.sqlite.org/c3ref/get_autocommit.html)、[max_page_count](https://www.sqlite.org/pragma.html#pragma_max_page_count)、[SQLITE_FULL](https://www.sqlite.org/rescode.html#full)を契約の根拠とする。依存 source は静的参照だけとし、上流のテスト／service は実行しない。

自動保持の設定・timezone・信頼時刻・時計跳躍、active recorder の停止／再開調停、大量削除の継続進行、receipt GC と再送期限、volume free bytes、実 filesystem の disk-full／I/O／checkpoint 障害、媒体故障・電源断は後続である。H2c3 は容量不足を成功に見せず、原子状態と復旧判断を保つための区切りであり、容量運用全体の完成ではない。

## 実装とローカル受入

共通sqlite_failureをretention／maintenanceへ適用し、primary OperationInterruptedだけをControlへ変換する。実FULLと取消併発の2回帰は、修正前にControl(Cancelled)となる失敗を再現し、修正後にSQL原因とpoisonを保つことを確認した。maintenanceは同writer接続で実FULL後に取消を立てる。retentionはaux SQLiteが返した実FULLをprivate hookへ注入し、本writer trimの実FULL原子性とは別の分類試験である。期限切れの分類境界も実FULLで確認した。

`write_failure_tests.rs`の6単体で、pressure triggerなしの通常append自然増大によるFULLと、transaction内のTEMP triggerによる各段階の実FULLを確認した。後者は容量確保用tableへ1 MiBの割当てを試みるprivate fixtureで、append全member後、plan／gap／正常close、trimのoperation／ledger／delete／fence各段階を対象にする。どちらもSQLiteの論理page上限により本物のDiskFullが返る。設定は容量回復を明示してから接続を閉じ、暗黙の上限リセットに依存しない。

Rust workspace199件（新規8単体）、Clippy `-D warnings`／rustfmt、関連Chromium5件が成功。raw／minmax・counter・epoch・frontier・receipt・fence・expiredの原子性と再open後の契約を確認した。既存のprocess故障／取消・SQL中断を回帰し、Astra最終レビューに必須修正はない。公開保存API・DB format 3・H1・依存・TS／通常Appは変更していない。全体CIはPRで確認する。
