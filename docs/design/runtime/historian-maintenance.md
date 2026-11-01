# Historian H2c2: 容量診断と明示 PASSIVE checkpoint

2026-11-01。状態: **Astra 主設計。実装・ローカル検証済み、全体CIはPRで確認**。[H2c1 保持削除](historian-retention.md)と既存の writer ownership／query snapshot を前提とする。

## 選択した小区切り

H2c2 は DB／WAL の限定診断と、明示的な PASSIVE checkpoint の library API とする。保持日数、timezone、信頼できる現在時刻、製品設定や常時 recorder がなくても、DELETE と物理容量の違い、reader の snapshot pin、checkpoint の未完了を独立して検証できるためである。

自動日次保持、時計異常による cutoff 保留、active recorder と trim の協調、receipt GC、disk-full 運用の完成は後続。今回の診断・checkpoint 成功を H2c 全体の完了としない。通常 App、実 Hub／PLC／DB、上流へ接続せず、隔離した一時 DB だけで受入を行う。

format 3、H1 JSON、trim／receipt／expired、SDK、Project、Banto、既存依存を維持する。新しい永続表や migration は追加しない。SQLite の `wal_autocheckpoint=1000` も維持し、手動 API が唯一の checkpoint 起点であるとは説明しない。

## API と診断値

以下を公開 API の意味とする。最終の型・field 名は実装へ合わせる。

| API                                             | 結果                 |
| ----------------------------------------------- | -------------------- |
| `storage_diagnostics(&mut self, &QueryControl)` | `StorageDiagnostics` |
| `checkpoint_passive(&mut self, &QueryControl)`  | `CheckpointReport`   |

StorageDiagnostics は page_size、page_count、freelist_count、logical_bytes、free_page_bytes、db_file_bytes、wal_file_bytes、live_reader_leases を返す。

- page 値は main の SQLite PRAGMA から取得する。logical_bytes=`page_size*page_count`、free_page_bytes=`page_size*freelist_count`。積は checked arithmetic、負値や freelist>page_count は CorruptData とする。
- logical_bytes は現 snapshot の論理 DB page サイズ。free_page_bytes は SQLite が再利用できる page の概数であり、OS の空き容量や直ちに縮小できる file byte 数ではない。
- db_file_bytes は固定 store.sqlite3 の file length、wal_file_bytes は固定 store.sqlite3-wal の file length の Option。WAL が存在しないときだけ None。存在する長さ0の file は Some(0) として区別する。
- file length は filesystem 上の論理長であり、sparse file の実割当量や volume の free disk space ではない。任意 path、接続文字列、資格情報は結果へ含めない。
- live_reader_leases は idle を含む現在の owned reader 数。active snapshot 数、WAL を pin している reader 数、checkpoint blocker 数とは呼ばない。

page_size／page_count／freelist_count は同じ有限 read transaction で取得し、transaction を閉じてから API を返す。filesystem 長と lease 数は別の測定であり、page 情報との厳密な同時 snapshot を主張しない。History snapshotId や再送 receipt として使える結果ではない。

診断で observations を全走査したり、全 table の正確な byte 内訳を取得したりしない。DELETE 後に freelist が増えることはあり得るが、小さな削除や page 配置によっては増えないため、削除件数と空き page 数の比例を受入条件にしない。

## checkpoint の結果

`PRAGMA main.wal_checkpoint(PASSIVE)` を一回だけ実行する。FULL、RESTART、TRUNCATE、VACUUM、再試行 loop や reader 終了待ちへ自動昇格しない。checkpoint のために reader を取消したり Drop させたりしない。

CheckpointReport は status と `log_frames: Option<u64>`、`checkpointed_frames: Option<u64>` を持つ。

| PRAGMA の結果                        | status                         |
| ------------------------------------ | ------------------------------ |
| busy=0、非負 count、checkpointed=log | Complete                       |
| busy=0、非負 count、checkpointed<log | Incomplete                     |
| busy=1                               | Busy。count が利用可能なら保持 |
| busy=0、log=-1 かつ checkpointed=-1  | NoWal。count は None           |

busy は0/1だけを受理する。count は両方非負か両方-1でなければ CorruptData、非負時は checkpointed<=log を要求する。busy=1 かつ両方-1なら Busy／未知 count として扱える。

PASSIVE では reader が古い snapshot を保持すると、busy=0 でも checkpointed<log になり得る。busy フラグだけで完了判定しない。checkpointed_frames は、この呼出し以前に checkpoint 済みだった frame を含む累積値であり、今回移した frame 数や書き込んだ byte 数ではない。

Complete はその呼出しの frame 処理状況を表す。WAL file が0 byteになる、縮む、消える、以後の append が WAL を増やさない、という意味ではない。正常 NoWal／Busy／Incomplete はデータ破損ではなく、writer を poison しない。

## 有限な呼出しの範囲

初期 guard として `MAX_PASSIVE_WAL_BYTES = 64 * 1024 * 1024` を採用する。checkpoint の直前に WAL file を確認し、存在する場合の file length が64 MiBを超えたら typed MaintenanceLimit 等で SQL を実行せず拒否する。診断 API は大きな WAL に対しても取得できる。

この上限は初期 library の保守的な作業規模制限で、実測済み製品容量ではない。物理 WAL が大きくても未処理 frame が少ない場合があり、その場合も今回の guard は拒否する。上限を超えたときに自動 TRUNCATE やデータ削除を行わない。上限変更や大規模保守は後続の容量運用で決める。

SQLite PASSIVE は reader／writer が終わるまで busy-handler で待たない。ただし内部 page 転送と同期 I/O には時間が掛かる。progress_handler の VM 間隔、deadline、64 MiB guard のいずれも、checkpoint 内部 I/O の経過時間を硬く制限する保証ではない。OS I/O 停滞を10秒で停止できると説明しない。

## 取消・予算・cleanup

既存 QueryControl を入場時に検証し、取消済み、期限切れ、不正 limits は SQL を始める前に拒否する。診断の各 SQL／decoded scalar／結果 byte は既存 Budget に課金する。checkpoint も SQL ごとの VM 先払いと progress handler、結果の検査・byte上限を使用する。

checkpoint の正常な SQL 結果が得られた後に届いた late cancellation／deadline 超過だけで、その結果を「未実施」に変換しない。成功した操作は取得した CheckpointReport を返す。SQL が実際に中断された場合は Control エラーを返せるが、checkpoint は transaction で巻き戻せる操作ではなく、既に一部 frame を処理している可能性を残す。

呼出し後の結果検証や byte limit エラーについても「checkpoint が行われなかった」とは保証しない。再呼出しは新たな観測であり、以前の結果と同じ count を返す冪等 receipt API ではない。小さな固定 DTO なので、出力 budget も十分な値を指定する通常経路を受入で確認する。

診断の read transaction は全経路で終了する。取消を外してから rollback し、解除／rollback 失敗時には既存の直接 needs_reopen guard 規律を用いる。panic 中も poison をローカル変数だけに残さない。checkpoint は autocommit 状態で実行し、診断 transaction や writer transaction を保持したまま起動しない。

SQL／I/O の実障害は既存の after_write／NeedsReopen 方針に従う。期待される Busy／Incomplete や、正常 cleanup 済みの協調取消を媒体破損と同一視しない。progress handler の解除を全経路で確認し、次の append／trim／query へ古い deadline を残さない。

## ownership と filesystem

両 API は既存 SqliteStore の `&mut self` からのみ実行し、任意 DB path を開く静的メソッドを作らない。check_writable と autocommit 状態を確認し、poison された connection で保守を継続しない。

active session はあってよい。同期的な `&mut self` により、この writer の append／trim と直列になる。query は別 read connection から既存 snapshot を継続できる。ただし PASSIVE が呼出し thread を I/O 処理で占有する時間はあり、将来の recorder に接続する際は scheduler／host の応答時間設計が必要である。

固定 directory の DB／WAL は symlink_metadata 等で symlink・非 regular file を拒否する。WAL の NotFound は正常な不在として扱い、permission error や他の I/O error を0 byteへ変換しない。診断のために file 本文を読まない。filesystem 観測と SQL との間の外部書換えを完全に排除する機構を今回追加するわけではなく、既存の単一 owner・専用 local directory 契約を維持する。

writer と owned readers の共有 lock を維持する。保守を別 background thread に投げて先に成功／取消完了を返す API は追加しない。呼出しが戻るまで owner 資源を保持する。writer Drop 後も生存 reader が ownership を保持する既存動作は変えない。

## snapshot と永続状態

checkpoint は WAL page の配置を進める操作で、History の logical transaction を作らない。global commit counter、cutoff、retention revision、expired ledger、tick sequence、元 receipt を更新しない。

reader の old snapshot は checkpoint 中・後も同じ raw／coverage／metadata を返す。Incomplete を無理に完了へ変えるために snapshot を破棄しない。reader が終了した後に新たな PASSIVE を呼び、frame 処理が進むことを確認する。以前の report を現在の file 状態とみなさない。

checkpoint の途中で process が終了した後も、SQLite WAL 回復と既存の interrupted session 処理に従う。アプリ独自の「checkpoint 完了フラグ」を追加しない。通常の reopen は receipt／fence／query の整合を確認し、checkpoint の未完了をデータ消失へ変換しない。

## 受入

- 新規 DB、append 後、trim 後の診断。page 値の範囲、checked 積、file length、WAL 不在と0 byte、lease 数の意味。
- active session でも診断／PASSIVE が可能で、次の append の sequence／receipt が維持される。
- old snapshot を pin し、その後 writer が追加 commit。PASSIVE の busy=0／未完了を正しく区別し、reader の答えを維持する。
- reader 終了後の再 checkpoint が Complete または実際の SQLite 状況に沿う結果になる。WAL の物理縮小を必須としない。
- H2c1 trim の前後で raw／expired／fence／watermark の意味が変わらない。receipt payload が checkpoint だけで消去されない。
- 64 MiB 以下と超過の事前 guard、超過時も診断取得可。大きな WAL を作る試験は専用 temp DB／controlled fixture だけで行う。
- 取消済み・期限切れ・低 VM／rows／bytes、SQL中断、正常結果取得後の late cancellation。handler の解除と、次の操作への影響がないこと。
- Busy／Incomplete／NoWal の結果分類、負値／不正 count 組合せの検証。OSや競合の偶然に頼らない内部判定試験を併用する。
- SQL失敗、panic と cleanup 失敗の poison、autocommit 前提違反、symlink／非 regular file／I/O error の拒否。
- child process 終了後の reopen と receipt／query 回帰。物理的な電源断耐性や disk-full の包括試験が完了したとはしない。

## 根拠と未完了項目

固定依存 libsqlite3-sys 0.39.1 の SQLite API 定義は、PASSIVE が busy handler を呼ばず可能な frame を処理すること、reader／writer により未完了になること、checkpointed count が以前の処理分を含むことを明示している。[SQLite checkpoint API](https://www.sqlite.org/c3ref/wal_checkpoint_v2.html) と [PRAGMA wal_checkpoint](https://www.sqlite.org/pragma.html#pragma_wal_checkpoint) を意味の根拠とする。現 checkout の bundled sqlite3.h の同定義を静的確認した。上流 repository への操作は行っていない。

volume の free bytes、allocated blocks、disk-full 復旧、WAL上限超過時の製品運用、物理縮小、receipt GC、metadata／ledger の圧縮、保持設定・時刻信頼は未完了である。H2c2 は容量を観測し、安全な範囲で明示 checkpoint を実行する基礎を作る区切りである。

## 実装とローカル検証

`store::maintenance`のStorageDiagnostics／CheckpointReportと`SqliteStore::storage_diagnostics`／`checkpoint_passive`へ実装した。超過はStoreError::MaintenanceLimit、取消・予算はControl(QueryError)、SQL failureはNeedsReopen規律に従う。DB format 3・H1 JSON v1・依存versionは変更していない。結果の最大byteをcheckpoint前に予約し、成功後のlate cancellationだけで実施済み処理のreportを落とさない。

Rust workspace190件（保守15単体・query snapshot競合1単体、child worker含む）、Clippy `-D warnings`／rustfmt、関連Chromium5件が成功。trim後のfree page、SQLとFSの別測定、reader pin中Incompleteと解放後Complete、64 MiB境界、NoWal、不正counter、予算・取消・SQL failure・panic cleanup、checkpoint前後のprocess終了後のreceipt／queryを確認した。TS・通常Appは未変更で、新しい製品画面は追加していない。

Astraレビューで、固定main DBの事前確認不足を指摘した。全SQLを拒否するfixtureでDB不存在／symlinkの先行拒否失敗を再現後、両API共通の事前検査へ修正した。page値はstore_metaの最初のreadでsnapshotを固定してから測る。最終レビューに必須修正はない。全体CIはPRで確認する。

## CIの成功再open fixture修正

同一headのpush CIだけがstore drop後の成功再openでBusyとなり、PR CIは成功した。64並列の反復でも既存の別試験から同じ失敗を再現した。複製したUnix lock FDの短時間保持で同じ寿命を再現する回帰を追加し、所有者不在を前提とする再open helper（成功・形式／identity拒否の検証）だけをBusy限定の最大1秒retryへ変更した。これは実際のfork継承をCIで直接観測した試験ではない。製品の即時Busy、writer／reader ownershipとcleanupの意味は変更していない。
