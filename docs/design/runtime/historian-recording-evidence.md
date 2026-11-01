# Historian H2b3: 時刻付き記録計画と欠測の証拠保存

2026-11-01。状態: **H2b3実装・ローカル検証済み、全体CIはPRで確認**。ユーザー指定に従いAstraが主設計した。[H2a原子保存](historian-atomic-store.md)、[raw snapshot](historian-query-snapshot.md)、[minmax集約](historian-minmax-query.md)を前提に、記録期間を説明する根拠を永続化する。実装・試験結果は[実装状況](../../project/implementation-status.md)へ記録する。

## 今回の単位

次PRは**時刻付きsession境界・固定計画snapshot・明示欠測intervalの原子的保存**に限定する。公開History queryは全域unknownCoverageを維持し、保存した証拠のcoverage投影は次の区切りで実装する。証拠を保存しただけで期間の完全性や全変化記録を保証しない。

通常App、実Hub／PLC、実環境DB・設定・資格情報、上流Industrialへ接続・変更しない。隔離一時DBのlibrary試験のみを行う。H1 JSON version、Project、SDK、Bantoを維持する。DBは新規作成用format **2**へ進め、format 1を自動migrationしない。

既存の時刻根拠なしbegin_session／close_sessionはuntimed session用として残す。過去のfirst／last sampleやSQLite commit時刻から開始・終了を後付けしない。timed sessionに対する時刻なしcloseは拒否し、明示的な終了境界または時刻不明のinterruptionを要求する。

## APIと根拠の型

以下はRust APIの意味。最終の綴りは公開実装に従う。

| 操作／型                              | 契約                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------ |
| PlanRef                               | plan_idとrevision。IDは既存の1〜64 ASCII規則、revisionは1〜MAX_SAFE      |
| TimedStart                            | PlanRef、clock_epoch、at_ms。開始のlower-inclusive境界                   |
| begin_timed_session(spec, start)      | 固定SessionSpecと計画snapshot、開始根拠を一つのtransactionで登録         |
| ClockStamp                            | clock_epochとat_ms。UTC epoch msとclock domainを組にする                 |
| close_timed_session(sessionId, stamp) | 正常終了のexclusive境界をsession状態と同transactionで保存                |
| interrupt_session(sessionId)          | 時刻を付けずinterruptedへ変更。時計不連続や終了時刻不明に用いる          |
| record_gap(GapEvidence)               | 固定member全体について明示的に観測／保存できなかった区間を登録           |
| session_evidence(sessionId)           | 開始・終了・plan参照・既知の観測frontierを照会。History coverageではない |

begin／close／interruptはSessionStatusのbegin_commit_version／end_commit_versionを安定した結果識別に使える。追加の時刻・planはsession_evidenceから取得する。gapは`GapReceipt {session_id, gap_id, commit_version}`を返す。gap保存でtickのcommittedThroughを進めたように表示しない。

GapEvidenceは`session_id, gap_id, clock_epoch, from_ms, to_ms, observed_at_ms, reason`。各時刻はH1と同じsafe整数ms、区間は`[from_ms,to_ms)`で非空。gap IDも既存ID規則とする。期限・保持日数やqueryの1時間上限を証拠区間の長さへ流用しない。

## 計画snapshotの意味

PlanRefに対応する内容は、今回の固定同周期SessionSpec.membersのcanonical snapshotだけとする。session IDは計画内容に含めず、memberはseriesIdで整列し、descriptor・source・型・単位・periodを保持する。

同じ(plan_id,revision)へ異なるmember内容を登録したらConflict。同内容なら別sessionでも再利用できる。hashだけで比較せずcanonical本文を照合する。名前変更やsegment変更を計画の同revisionへ上書きしない。

これはそのsessionがどの記録集合を使用したかの根拠であり、Projectのdesired／deploymentのapplied配布、管理権限、適用要求のCAS、複数計画の合成を完成させるものではない。revision間の数値順だけからUTCの有効期間を推測しない。別revisionへの明示的な切替や過去計画の再利用は、新sessionの開始根拠と組にして残す。

untimed sessionにも固定specは存在するが、PlanRefや開始時刻を後から付けてtimedへ昇格させない。

## 同一domainの時刻規則

timed sessionは開始時の単一clockEpochに束縛する。domainは`(sessionId,clockEpoch)`であり、別sessionが同じclock文字列を使っても別domainとする。sourceEpochはHub値の世代で、clockEpochの代用にしない。

開始時に`observed_frontier_ms = start_ms`を保存する。frontierはそのsessionで明示的に観測された操作時刻の最大値であり、欠測なしや永続化済み時間軸を示すwatermarkではない。

| 新しい操作            | 条件とfrontier                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| tick append           | epoch一致、sampleTimeMs≧startかつ≧frontier。同timestamp別sequenceは許す。成功時frontierをsampleTimeMsへ進める      |
| gap登録               | epoch一致、start≦from<to≦observed_at、observed_at≧frontier。成功時frontierをobserved_atへ進める                    |
| 正常close             | epoch一致、end≧frontier、end>start、end>最後の保存tickのsampleTimeMs、end≧全保存gapのto。成功時endとfrontierを保存 |
| interrupt／再open復旧 | end時刻を作らずinterruptedへ。frontierは既知の値のまま保持する                                                     |

sourceTimeMsやingestedAtMsは別時計／別段階の時刻なので、これらの大小でfrontierを進めない。正常closeのendはexclusiveであり、最後のrecordと同じmsをendにしてそのrecordを期間外へ置くことは拒否する。storeが自動で1ms加算したり、値を丸めて正常終了に見せたりしない。

gapは過去に遡って明示できる。例えばstart=0、最後のtick=5000の時点で、既存recordのない[2000,4000)をobserved_at=5000で登録してよい。ただし既存観測や保存gapとの矛盾は拒否する。observed_atを更新した後に、それより古いsampleTimeの新tickを遅れて挿入する動作は今回許さない。

時刻逆行やclockEpoch変更が起きたら、そのtimed sessionへ新tickを追加しない。呼出し側は旧sessionを明示interruptして、新session／新clock domainを始める。旧sessionの終了時刻を最後のsampleから捏造しない。untimed sessionの既存の時計逆行保存は維持する。store自身は実時計を取得せず、入力に付いた観測根拠を検査する。

同一sessionでの既存tick再送は、receiptとcanonical payloadの一致判定をこれらの新tick制約より前に行う。frontierが進んだ後やsession終了後も、保存済みtickの同内容再送を時刻逆行として拒否しない。

## 明示欠測の意味と矛盾防止

初回のgap reasonは**samplingMissed／storageLossの2種類**に限定する。前者はscheduler等がその区間の観測を実施できなかった明示事実、後者は保存経路がその区間を失った明示事実。storeが失敗件数や予定tickを計算してreasonを選ぶ機能ではない。

対象はactiveなtimed sessionの**全固定member**。系列subsetや別epochの範囲を一つのgapへ混ぜない。Bad／Stale／sourceUnavailable等の観測可能な無値状態は従来の無値tickで保存する。unrecorded／expired／pendingFlush／recorderStoppedをこのgap APIで登録しない。

各gapは「このsession/domainのこの時刻区間には保存済みrecordがない」という証拠として扱う。

- 同sessionの既存recordのsampleTimeが`from <= t < to`ならgapを拒否する。value=nullのrecordも例外ではない。
- 保存gap内への新tick appendも拒否する。gapのto上は区間外であり、frontier等の条件を満たせばappendできる。
- 同session内の異なるgap IDによる区間重複は同理由でも拒否する。隣接は許す。自動mergeや既存gapの更新はしない。
- gap保存はglobal commit counterだけを進める。tick sequence／committedThroughを消費・進行させない。次tickは直前の保存tick番号＋1のまま。
- 既存gapの訂正・撤回は今回提供しない。間違った証拠を上書きで消す経路を作らない。

別session/domainのrawが同じUTC区間にある場合は、このledgerの局所事実とは直ちに矛盾しない。例えば時計逆行後に再度同じUTC範囲を観測できるためである。H1公開coverageはdomainを持たないので、将来の投影ではこの違いを必ず扱う。ledgerをそのままseries全体の欠測として公開してはいけない。

## 冪等性とlifecycle

beginはsession ID、closeはsessionの一度の正常終了、gapは(session ID,gap ID)を再送の識別にする。入力はH2aと同様typed canonicalで比較し、field順・数値表記やmember順の違いを別内容にしない。

- 同じbegin IDのspec＋時刻根拠が同じなら既存結果を返す。untimedのNoneとtimedのSome、別plan／epoch／開始時刻はConflict。既存sessionへ時刻根拠を後付けしない。
- 同じgap ID・同payloadは既存receiptを返す。別payloadはConflict。再送判定はactive／frontier検査より先なので、close後・interrupted後にも保存済み結果を確認できる。
- 正常close済みで同じend stampを再送したら既存結果、異なるendならConflict。interruptedを時刻付きclosedへ書き換えない。
- interruptはend時刻なしの明示的終了。既にterminalなら状態を再開・上書きしない。再open時に残ったactive sessionをinterruptedにする既存規律も維持する。
- 旧close_sessionはtimed sessionを終了させない。untimedの正常終了を後付けで時刻付きcloseへ変更もしない。

新begin／close／gapとそれぞれの証拠、receipt／global counterを同transactionでcommitする。SQL失敗時のNeedsReopen、プロセス排他、reader lease、COMMIT後応答喪失時の同ID再照会はH2a／H2bから引き継ぐ。

## format 2とSQL

application_idは維持し、user_versionとstore_meta.format_versionを2へ揃える。createは新しい専用directoryへformat2を作る。open_existingはformat1／未知format／版の不一致をUnsupportedStore等で拒否し、値を2へ書き換えて開かない。旧形式互換を必須としないという開発方針に従い、今回migration APIを追加しない。

追加表の概念は次のとおり。最終DDLの列名は実装に従う。

| 表               | 内容・制約                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| recording_plans  | `(plan_id,revision)`主キー、members_json、created_commit。immutableなcanonical snapshot                                      |
| session_evidence | session_id主キー／FK、plan参照／FK、clock_epoch、start_ms、observed_frontier_ms、end_ms nullable。時刻はsafe整数             |
| recording_gaps   | `(session_id,gap_id)`主キー、clock_epoch、from/to、observed_at、reason、payload_json、commit_version。session evidenceへのFK |

end_msは正常なtimed closeのときだけ非null。untimed sessionはsession_evidence行を持たない。interruptedではend_msをnullのままにする。gapのclockは親session evidenceと一致させ、reason／非空区間／start・frontier等をSQL制約とadapter検査で守る。

observationsに`(session_id,sample_time_ms)`、recording_gapsに`(session_id,from_ms)`の索引を追加する。gap内recordの存在確認はLIMIT1で行う。gap同士が非重複という不変条件を使い、`from_ms < new.to`を満たす直前1区間のtoがnew.fromより大きければ重複と判定できる。tick時刻は`from_ms <= t`の直前1区間を取得し、t<toならgap内となる。毎回全gapをRustへ列挙しない。

beginでは既存session再送照合・active制約を検査したうえで、plan登録、既存series／segment、session、member、evidenceを同transactionで保存する。gapでは再送照合、session／domain／時刻と区間衝突の検査、gap挿入、frontier更新、counter更新を同transactionに置く。tickでは新tickのreceipt／observations／sequenceに加えtimed frontier更新も同transaction。正常closeではstate／end_commit／end時刻／frontierを同時更新する。

## 公開queryとの境界

H2b3のraw／minmaxは従来どおり同一snapshotから読み、全域unknownCoverageを返す。証拠表を作っただけでcomplete binを生成せず、空binのMetadataAmbiguousも自動解消しない。開始・終了境界があることと、その間すべての予定tickを記録できたことは別である。

次のcoverage投影工程では、少なくとも以下を同snapshotで検査する。

1. 同seriesの全session/domainと既存raw／bin、記録計画、終了・gap証拠を照合する。
2. 他domainの有効recordと同じUTCにある局所gapを、無条件に全体欠測へ昇格させない。証明できない部分はunknownCoverageを残す。
3. H1のrawとexpired／unrecordedの重複禁止、bin全体をその区間和が覆う場合のvalidCount禁止を維持する。今回この2理由を登録できないことを、将来の検査不要という意味にしない。
4. pendingFlushには受理済み・未commitの実在根拠、expiredには削除transactionと保持根拠が必要。最後のcommit時刻やrecord不在から作らない。
5. 最大256coverage区間、期間端点、取消・仕事量予算・reader所有を維持する。

## 受入

| ケース                                                          | H2b3の合格条件                                                                   |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| timed begin／tick／gap／close                                   | plan、session、証拠、receiptが原子的に一致。gapでsequenceが増えない              |
| 同plan参照・同内容を別sessionで利用、同参照・別内容             | 前者は再利用、後者はConflictで部分登録なし                                       |
| untimed beginからtimed再送、同spec別start／plan、timedの旧close | 後付け／根拠省略を拒否し既存内容を保持                                           |
| 同ID再送をfrontier進行後／close後／再open後に行う               | 同payloadは既存結果、別payloadはConflict。sessionを再開しない                    |
| sampleの同timestamp、epoch変更、時刻逆行                        | 同timestampは許容、timedのepoch変更／逆行は拒否。interrupt→新sessionで保存可能   |
| 最後tickと同msのclose、gap終端より前のclose                     | 半開境界を偽らず拒否。時刻を自動補正しない                                       |
| gap内の既存Good／無値record、gap保存後の新tick                  | 両方向で矛盾を拒否。to上は他の条件を満たせば許す                                 |
| gap隣接／重複、startより前、未許可reason、subset相当入力        | 隣接のみ許可。契約外は副作用なく拒否                                             |
| 過去の穴を後で明示、別domainの同UTC record                      | 同domain既存recordがなければ適切に保存。別domainを理由に局所証拠を勝手に消さない |
| 証拠挿入後／frontier更新後・COMMIT前に失敗／process終了         | plan／evidence／session／counterが一括rollback。孤立根拠なし                     |
| COMMIT直後の応答喪失                                            | 同ID再送で元receipt。重複区間／counter増加なし                                   |
| timed activeのままprocess終了→再open                            | interrupted、end時刻なし。最後sampleを停止時刻へ変換しない                       |
| format1／未知format／版不一致                                   | 拒否し、既存DBをsilent変更しない                                                 |
| evidence保存前後のraw／minmax                                   | query契約とsnapshot整合が維持され、unknownCoverageを推測で消さない               |

既存H1 fixture、H2a保存・再送・process終了、H2b query／minmaxの受入を回帰確認する。実時計によるscheduler、正確な停電時刻、製品のplan配布・認証、保持削除と容量運用はこの工程の試験対象ではない。

## ローカル検証結果

Rust workspace140件（H2b3新規14 test関数、child worker含む）、Clippy `-D warnings`／rustfmt、関連Chromium3件が成功。既存のH1共通110 fixture、実SQLiteのraw4ケースとminmax6成功／1失敗を維持し、公開queryは証拠保存後もunknownCoverageのままである。新しいfrontend／TS実装は追加していない。

新規試験は通常lifecycle／再送、immutable plan、untimedからの後付け拒否、時刻・clock・frontier、gapとGood／無値record、gap同士の区間矛盾、別domainの同UTC、safe整数全域、SQL失敗による全rollbackとNeedsReopen、format1／版不一致の非変更拒否を確認した。子プロセスをbegin・gap・closeのCOMMIT前後とtickのCOMMIT前に終了し、根拠の原子性と終了後の同ID照会を検証した。interrupt／復旧ではend時刻を付けない。

Astraのread-only実装整合レビューでは必須修正は見つからなかった。これらは使い捨てDBの受入であり、媒体I/O・電源断・Windows運用や、実scheduler／正式plan配布・認証の保証ではない。全体CIの確定結果はPR本文へ記録する。
