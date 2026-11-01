# Historian H2b4: 記録証拠からの保守的な coverage 投影

2026-11-01。状態: **実装・ローカル検証済み、全体CIはPRで確認**。ユーザー指定に従い Astra が主設計した。[時刻付き証拠保存](historian-recording-evidence.md)、[raw snapshot](historian-query-snapshot.md)、[minmax](historian-minmax-query.md)を前提とする。

## 今回の単位

format 2 に保存済みの明示 gap を、同一 snapshot で系列全体へ投影する library query の変更に限定する。公開 H1 version、DB format、依存、SDK、Project、Banto を変更しない。通常 App、上流、実 Hub／PLC／DB に接続しない。

公開する新しい根拠は samplingMissed と storageLoss だけである。記録計画の開始・終了から unrecorded、recorderStopped、expired、pendingFlush を生成しない。予定周期どおりの完全な記録を証明する機能も追加しない。欠測理由を説明できる区間が増えることと、全変化記録や minmax complete を保証することは別である。

## 投影規則

対象系列の各 session は `(sessionId, clockEpoch)` の別 domain として扱う。同じ clockEpoch 文字列、同じ plan、同じ descriptor でも session を跨いで同一 domain と見なさない。

候補は query と交差する recording_gaps の区間を query の `[fromMs,toMs)` へ切り詰めたもの。gap の session が当該系列を固定 member に含むこと、時刻・clock・plan 根拠が整合することを確認する。

候補の所有 session 以外が同じ UTC 区間を記録し得る場合、局所的な欠測を系列全体の欠測へ昇格させない。他 session の妨害区間を次のように定める。

| 他 session の根拠                          | 妨害区間                           |
| ------------------------------------------ | ---------------------------------- |
| timed、正常 closed、明示 end あり          | `[start,end)` と query の交差      |
| timed、active または interrupted、end なし | `[start,query.to)` と query の交差 |
| untimed                                    | query 全域                         |

frontier、最後の sample、最後の commit を終了時刻に置き換えない。interrupted は終了時刻不明のため、保存後の別 session まで妨害し得る。untimed session は開始も終了も UTC へ配置できないため、当該系列に一つでもあれば今回の公開 coverage は全域 unknownCoverage となる。この保守性は意図的な採用範囲である。

候補 gap から全ての他 session の妨害区間の和を差し引き、残った部分だけ元の理由を公開する。他 session 自身にも同じ理由の gap がある場合も、今回は妨害を解除しない。domain 間の欠測合成は後続で明示的に設計する。

例: session A の samplingMissed `[1000,5000)` に対し、別の正常終了 session B の期間が `[2000,4000)` なら、公開欠測は `[1000,2000)` と `[4000,5000)`。間は B の実値有無によらず unknownCoverage。B が interrupted なら `[2000,5000)` 全部を unknownCoverage とする。B の Good または無値 record が同じ UTC に存在しても欠測と重ねない。

残存欠測区間に当該系列の保存済み record が存在しないことを SQL EXISTS で最終確認する。value=null も record である。存在すれば採用しようとした証拠・時刻境界に矛盾があるため、全要求を CorruptData とする。正常な別 domain の record は先の妨害区間で除去されるため、この検査で正常な時計逆行を障害扱いしない。

残存区間を整列し、同じ理由の隣接区間を結合する。その補集合を unknownCoverage で埋め、再び隣接同理由を結合する。known series の coverage は query 全域を、隙間・重複なく覆う。unknownSeries の空 coverage は従来どおり。異なる理由の重複が残る場合は CorruptData とし、理由の優先順位で隠さない。

## 根拠検証と snapshot

既存の BEGIN DEFERRED と最初の last_commit 読み取りで固定した snapshot の中で、metadata、session、plan、gap、raw／集約、watermark を読む。query の途中で別 transaction を開いたり、writer の現在状態を混ぜたりしない。

使用する session について、固定 SessionSpec と session_members、plan の canonical members、segments の永久 descriptor を照合する。member 順に依存せず、型付き descriptor の内容で比較する。単に plan ID が存在するだけでは足りない。timed の clock、safe integer 時刻、start/frontier/end の関係、state と end の有無を検証する。closed timed には end が必要、active/interrupted では end は null。untimed は証拠行がないという既存形式の正常状態である。

候補 gap では ID、reason、canonical payload と列値、同 session の clock、start≦from<to≦observed≦frontier、commit 参照の範囲を確認する。途中で発見した破損を unknownCoverage に変換しない。一方、この query は DB 全体の integrity checker ではなく、採用根拠と検索に関係する範囲を検証する。検索外の全 raw や全 gap を復号して監査する必要はない。

## Rust と SQL の実装境界

公開 query_raw／query_minmax は維持する。内部に `coverage::project(connection, seriesId, from, to, budget)` 相当の共通関数を置き、同一意味の coverage を両 mode へ渡す。全要求エラーに EvidenceLimit と CoverageLimit を追加できる。H1 JSON の失敗 DTO や新 version は追加しない。

SQL の取得手順は次を基準とする。

1. session_members を当該 series で絞り、sessions／segments／session_evidence／recording_plans は LEFT JOIN する。欠けた参照を INNER JOIN で消さない。begin commit と session ID で決定的に整列し LIMIT 257。session ごとの spec／plan を検証する。
2. 同系列の member session に属する gap を `from_ms < query.to AND to_ms > query.from` で絞り、session ID・開始時刻・gap ID で整列し LIMIT 1025。参照を検証した上で候補へ変換する。
3. Rust の区間演算で妨害区間の union と差引を行う。query へ先に clip し、無限大の sentinel や end+1 を使わない。safe integer 上下端でも半開比較だけで処理できる。
4. 残存欠測に対し `observations WHERE series_id=? AND sample_time_ms>=? AND sample_time_ms<? LIMIT 1` 相当の EXISTS を実施する。既存 observation_time 索引を使い、raw 全件を Rust へ読み込まない。
5. coalesce と unknown 補集合を作り、出力件数・byte 予算・既存 H1 validator を検査する。

既存索引のままで実装し、DB format を進めない。SQL の走査量は VM／deadline の対象であり、LIMIT は DB 内の走査が一定であるという保証ではない。session_members の系列選択を将来高速化する索引追加は、別途 format 運用と性能測定に基づき判断する。

## 仕事量と資源寿命

系列ごとの初期安全上限を最大256 session、最大1024候補 gap とする。各 LIMIT の1件余分で超過を検出し EvidenceLimit。これらは製品の保持容量や実測性能を保証する値ではない。

最終 coalesce 後の coverage は unknownCoverage の補集合込み最大256件。257件以上なら CoverageLimit で全要求を拒否し、先頭256件だけ返したり黙って全域 unknownCoverage へ戻したりしない。中間候補数と最終公開区間数は別に数える。

全 SQL は既存 Work::statement と progress callback、全 decoded row は Budget::row に課金する。spec／plan／descriptor／payload の JSON は parse 前に長さを制限し、全系列で共有する入力 byte 予算へ含める。最大8 member の既存型を収容する一本文64 KiBを安全上限とし、超過は EvidenceLimit とする。入力合計8 MiB超過は ByteLimit。出力は独立した最大8 MiBの予算であり、利用者が出力上限を下げても入力上限は変わらない。9000 decoded row、5M VM、10秒以内、取消と最大2 reader lease は維持する。Rust の差引・整列・結合ループも work.check を呼ぶ。複数系列を跨いで budget をリセットしない。

全要求失敗時も handler解除→ROLLBACK の cleanup と、失敗 connection の破棄規律を継承する。取消要求だけで reader ownership を解放しない。未知期間の多い履歴や session が多い履歴が上限に達することはあり、長期検索／ページングは今回追加しない。

## minmax と raw の整合

raw の並び、値、recordId、watermark は変更しない。samplingMissed/storageLoss は今回の実装では record と重ならない強い根拠として返すが、H1 の既存汎用 validator に新たな domain 情報は追加しない。既存の expired/unrecorded と raw／bin の矛盾拒否も維持する。

minmax の共通 grid、SQL count/envelope、bool、source/segment/clock domain 混在判定は維持する。単一 domain の有値 bin は partial、混在は mixedSegment、無値または空 bin は既存の gap 規則のまま。coverage の一部が明示欠測へ変わっても complete に昇格させない。bin 全体が明示欠測で覆われるなら保存 record がないため validCount=invalidCount=0 となる。一部だけが欠測なら同じ bin の他部分に有値 record があってよい。

複数 descriptor の空 bin を plan だけで一つに決める機能は追加しない。既存 MetadataAmbiguous を維持する。coverage の説明能力と metadata の時刻有効期間の証明を混同しない。

## 受入と後続

同一の temp DB 操作 fixture に対し raw と minmax の coverage が一致することを確認する。主な受入は次のとおり。

- 単独 timed session の gap、query 端点での clip、gap.to 上の record、隣接同理由の結合、異理由の隣接。
- gap 外の開始前・終了後・未証明の期間は unknownCoverage。gap がなく正常 close しただけでは完全性を作らない。
- 別 timed session の正常期間が gap 中央と重なる場合、左右だけを公開。Good／null／同 timestamp 別 record のいずれも公開欠測内へ残さない。
- 別 session が active/interrupted なら frontier 以後も妨害。untimed があれば全域 unknownCoverage。同理由 gap の domain 間合成もしない。
- 同じ clock 文字列を再利用した別 session、同じ plan を再利用した別 session、開始の時計逆行を別 domain として扱う。
- candidate と raw の同 snapshot 整合。最初の snapshot 読み取り後に writer が gap／新 session を commit しても、その query の答えへ混入しない。
- 256 session と257、1024候補と1025、最終256区間と257の境界。coalesce で減る場合は最終数で判定。多系列の共有 budget と低 VM／rows／bytes／取消。
- plan 内容不一致、gap payload／clock 不一致、state/end 不一致、採用欠測内 record の破損注入は CorruptData。無値 record も例外にしない。
- minmax の gap 全域と部分交差、ピーク保持、mixed domain、複数 descriptor 空 bin の既存失敗を回帰する。
- error／取消／panic 後 cleanup、reader 再利用可否と所有 lock の既存受入を維持する。

停止・保持削除・受理済み未flushの根拠、複数 domain の完全性証明、metadata の有効期間、長期検索の分割 snapshot は後続である。H2b4 はこれらを推測で埋めず、保存した明示欠測のうち矛盾なく説明できる部分を初めて公開する区切りとする。

## ローカル実装と検証

Rust workspace155件（新規14単体と共有fixture統合1関数）、Clippy `-D warnings`／rustfmt、TS114ファイル・1,395件、型検査0エラー・0警告、build、関連Chromium4件が成功。6共有fixtureで実SQLite出力をRust／TS／ブラウザと照合した。DB format 2・H1 schema／110既存fixture・依存versionは変更していない。

Astraの実装レビューで、sessionsのINNER JOINが破損した参照を落として妨害domainを見逃す経路を確認した。回帰試験で拒否失敗を再現後、LEFT JOINと必須列検証へ修正した。さらにspec／planの両方を同じunitへ改変しても、永久descriptorとの型付き照合で拒否する回帰を追加した。修正後の再レビューで追加の必須修正はない。全体CIはPRで確認する。
