# Historian H3a: 位相を累積させない周期recorder

2026-11-01。状態: **Astra 主設計の採用契約、Rust library実装・ローカル受入済み**。[P5の周期記録](historian-trend-contract.md)、[保存コア](historian-atomic-store.md)、[時刻付き証拠](historian-recording-evidence.md)に基づく。

## 今回の目的

1秒周期の収集でも、処理後に1秒sleepすると処理時間や待機誤差が累積し、1時間の予定3600点に届かなくなる。H3aはこの問題をabsolute deadlineと整数slotで解消し、mock latest sourceから実SQLiteへ書き込む、UI寿命に依存しない最小recorderを追加する。単なるschedule計算の提供では終えない。

対象は明示設定された固定group一つ、同期snapshot採取、同期commitである。実Hub／SDK専用購読adapter、Project記録計画の配布、複数周期groupのscheduler、queue／spool、製品サービスは後続。通常AppやIndustrial／S7／実環境には接続しない。DB format 5、H1、固定SDK／Project／Bantoを維持する。標準ライブラリのInstant／SystemTimeで薄い時計adapterを実装でき、新依存は不要である。

## APIと所有

最終の綴りは実装に従う。

- RecorderConfig: SessionSpec、PlanRef、period_ms、任意slot_count、明示max_clock_skew_ms。
- ClockReading: monotonic_ms、wall_time_ms、clock_epoch。
- RecorderClock: readとwait_until。wait_untilは絶対monotonic deadlineと取消状態を受け取る。
- SnapshotSource: captureで全memberのTickObservationを一度に返す。ネットワーク待機ではなく、既に取得済みの最新snapshotを同期コピーする境界を想定する。
- Recorder::start: storeとconfigとclockを受け、開始readingをanchorとして固定し、新しいtimed sessionを開始する。
- Recorder::step: store、source、clock、取消状態を受け、待機・採取・必要なgap保存・tick保存を最大一回ずつ行い、状態とStepReportを返す。
- Recorder::stop: 新しい受理を止め、取得済みの正常時刻で明示close可能ならcloseし、それ以外はinterruptを試みる。

periodはH1の100..3_600_000msで、全memberのperiod_msと一致させる。member数は1..8。slot_countを指定する場合は正のsafe整数で、anchor＋slot_count×periodのoverflowも拒否する。未指定時も各加算をcheckedにし、無限の整数wrapを許さない。max_clock_skew_msは明示の非負safe整数とし、製品defaultを作らない。

同sessionへ他のcallerがappend／gapを追加しないことをrecorder所有契約とする。store全体のwriter排他は既存コアが担う。startは新session専用であり、既存receiptを見て失われたmonotonic anchorを推測再構成しない。restartは新session／新anchorとし、旧active sessionの復旧は既存open処理に従う。

## 戻り値とterminal結果

startはまだrecorderが成立していないためResultを返せる。step／stopは処理途中のreceiptやcounterを失わせないよう、RecorderReportを返す。reportはstate（Running／Stopped）、counters、任意ObservedSlot、任意tick_receipt、任意gap_receipt、任意TerminalReportを持つ。StoreErrorを保持するreportはDebugのみでよく、Clone／Serializeを要求しない。

TerminalReportはcauseとcleanupを分離する。causeはCompleted、Requested、Cancelled、Clock、Source、Store、InvalidObservation、ArithmeticOverflow。cleanupはClosed(SessionStatus)、Interrupted(SessionStatus)、Failed(StoreError)。ClockError／SourceErrorは有限enumまたはstatic messageの小さい型でよい。停止後のstep／stopは明示AlreadyStoppedのNoOp結果とcounterを返し、再度capture／write／cleanupしない。元の非Clone errorの再生を要求しない。

Countersはcaptured_snapshots（capture成功回数）、committed_ticks、missed_slots、committed_gaps、resolved_slotsを区別する。capture成功後に取消された未保存snapshotもcapturedに含める。ObservedSlotはclock／slot検査が完了した場合だけ返す。capture中に取消されたら次の検査で停止して未commitとし、DB commit後の取消ではreceiptとcounterを保持して停止する。

有限Nの最後のtickを保存しただけではsessionを早くcloseしない。次stepでhorizonまで待ち、実readingを検査して終了する。明示stopでは待機せず現在readingでcleanupする。clock読取／検査の失敗は隠さず原因へ残し、時刻を必要としないinterruptへ進む。

## absolute deadlineとslot

開始monotonicをA、周期をPとする。slot nの予定deadlineは **D(n)=A+n×P**、slot領域は **[D(n),D(n+1))**。slot0を開始時刻で予定する。次deadlineを処理完了時刻＋Pへ変更しない。DB commitの所要時間もanchorに加算しない。

stepは未処理slotのdeadlineまで待機する。早く起きた場合は同じdeadlineまで再待機し、未到達のslotを採取しない。遅く起きた場合は現在slotまでの過去slotを飛ばし、一回だけ最新snapshotを採る。source capture直後にclockを読み直し、その観測完了時刻のslotを最終割当とする。capture中にslot境界を跨いでも、capture前のUTCをsampleTimeに流用しない。跨いだ過去slotはmissedに加える。

各slotに観測を割り当てるのは最大一回。すでに扱ったslot内で再度stepを呼んでも次deadlineまで待つ。同じ最新snapshotを過去の予定slot数だけ連続保存して追いついたことにしない。DB処理が遅れれば次stepで飛ばしたslotを数える。

有限slot_count=Nのhorizonは[A,A+N×P)。観測完了がhorizon以降なら新tickに割り当てない。残る予定slotはmissedとして報告し、範囲外のsnapshotを最後の予定slotへ押し込まない。終了予定時刻を実際のsession終了UTCとして捏造しない。

P=1000ms、N=3600なら予定slotは0..3599のちょうど3600件である。これは相対sleepの累積ずれを防ぐ保証であり、非リアルタイムOS上で任意のUTC正時区間に必ず3600実測recordが入る保証ではない。大きな遅延・停止・I/O失敗時の実件数は別に示す。

## sampleと予定根拠の分離

sampleTimeはcapture直後に読み取った実観測完了UTC、ingestedAtも実際に取得したreadingを使う。同じreadingなら同時刻でよい。sourceTimeはsourceが返した値を保持し、周期予定時刻や観測時刻で上書きしない。最新値が前slotと同じでも、正常なsample-and-hold観測なら別recordとして保存できる。

sequenceは記録tickの番号であり、slot番号ではない。slotを飛ばしてもDBが要求する次sequenceでappendする。予定slot／scheduled_monotonic_ms／観測reading／latenessはStepReportに分離して返す。無制限のイベントvectorをrecorder内部に蓄積せず、callerが必要な診断を収集する。

format 5はslot台帳を持たない。session start／periodとprocess中のreportは予定の説明根拠になるが、restart後に全slot割当をDBだけから再現できるとはしない。scheduled UTCをsampleTime列へ代入することでこの不足を隠さない。永続slot台帳と原子的なslot・gap・tick commitは後続の保存契約である。

sourceが返すQuality、source、sourceEpoch、sourceTimeをそのままコア検証へ渡す。SIM除外やUnknownSource等は既存の無値契約を守る。sourceエラーをGood値や過去snapshotの複製へ置き換えず停止する。正常に取得した無値observationはsourceエラーと区別して通常tickに保存する。

## 時計検査

すべてのclock readingはsafe UTC、妥当epoch、単調monotonicを要求する。開始以後epoch変更、UTC逆行、monotonic逆行を検出したら停止する。隣接readingのwall差とmono差の乖離がmax_clock_skew_msを超える場合も停止し、UTC前進jumpを通常の遅延と混同しない。整数差は広い整数型またはchecked演算で判定する。

この検査は時計の信頼を外部から保証するものではない。少しずつの時計driftや時刻同期の運用は後続。時計異常後にanchorを自動で付け替えて同sessionの記録を続けない。

std adapterはInstantの固定originからmonotonic経過を測り、SystemTimeをUTC epochへ変換する。wait_untilは固定deadlineとの差を再計算してsleepする。取消を確認できる短い待機単位を使っても、deadline自体は変えない。OS sleep／同期source／SQLite I/Oのhard deadlineは保証しない。

## samplingMissedと保存の境界

missed slotを検出した場合、同じ検証済みclock domainで実際にrecordを作らなかった観測間区間をGapEvidenceへ残す。直前に保存したsample UTCがt、今回観測UTCがuなら候補は **[t+1,u)**。初回遅延なら **[startUTC,u)**。非空区間だけを保存し、observed_at_ms=u、reason=SamplingMissedとする。

これは予定monotonic区間をUTCへ推測変換したものではない。前record自身と今回recordを含めず、このrecorderが記録しなかった実時刻範囲を説明する。missed slotがない通常jitterにはgapを作らない。時計異常時は区間を作らずunknownを残す。UTCが同値などで安全な非空区間を作れなければ、missed件数だけを報告する。

gapを先にcommitし、その後tickをappendする。各々は既存コアの原子操作であり、二つを合わせた原子性は主張しない。gap成功後tick失敗でもgapは今回tickの時刻を含まないため、保存済みの事実は矛盾しない。どちらかの失敗でrecorderをterminalにし、勝手に次slotへ進めない。crash後に未保存gapを推測補完しない。

slotを処理しなかった数、保存された無値tick数、gap interval数、gapが説明するUTC長さは別概念である。欠測率をgap区間長から単純にslot件数へ逆算しない。

## 診断と失敗状態

StepReport／累積状態は少なくとも、予定slot数（有限設定時）、経過して判定したslot数、観測回数、commit済みtick数、missed slot数、保存gap数、現在slot、lateness、最新receiptを区別する。sourceを取得したがcommitしなかったケースは観測済み・未commitとして説明する。設定全体の予定数を、まだ到来していないslotまでmissedとして表示しない。

取消、source異常、clock異常、DB失敗はterminal状態として返す。これまでのcommitとreceiptを結果から失わせない。成功commit後の取消はその成功を取り消さず、新規受理を止める。自動retryループや無制限queueは追加しない。

正常stopのclose境界は既存timed close条件（開始・最後sampleより後、frontier以上）を満たす実readingに限る。同時刻や異常時計でcloseできない場合はinterruptを使い、架空の+1ms終了時刻を作らない。cleanup失敗は元の停止原因とは別に保持する。DBがNeedsReopenならinterruptも失敗し得るため、正常終了と報告せず既存再open復旧へ委ねる。stop／Dropで所有者不明の背景taskを残さない。H3aは同期処理であり、別thread化するhostはjoinまでstore ownershipを保持する。

## 受入

- 仮想monotonic／UTC時計、mock snapshot source、隔離一時SQLiteでP=1000ms・N=3600を実行する。各slot内の小さいwake jitter、capture時間、commit処理相当時間を加えても3600予定・3600観測・3600commit・missed0となり、最終slotのdeadlineはanchor+3599×1000である。
- 同じ処理時間を相対sleep方式へ与えた対照計算では半開1時間の件数不足を再現し、採用方式との差を確認する。実時計で1時間待つ試験を必須にしない。
- captureがslot境界を跨ぐ場合、直後readingでslotを選び、飛ばしたslotをmissedにする。DB遅延後も位相を付け替えず、最新snapshotを連続catch-up保存しない。
- 境界ちょうどの観測は右slotへ、有限horizon上の観測は対象外。slotとsequenceを混同せず、正常raw／minmax queryで実recordを確認する。
- skipped slot時のsamplingMissedが前／今回rawと重ならない。gap後append失敗とprocess中断では確定済み情報だけ残し、unknown部分を推測しない。
- Bad／Stale／SIM／UnknownSource無値、同じsourceTimeの連続Goodを既存契約どおり保存する。
- UTC前進jump／逆行、epoch変更、monotonic逆行、算術overflow、source error、DB FULL、取消で停止し、commit件数とcleanup結果を保持する。
- std clock adapterの短時間待機・取消を確認し、仮想試験を実時計の精度保証と混同しない。

H3aの完成は位相固定recorderから実DBまでの経路と診断である。専用SDK購読所有、trust／再接続adapter、永続slot台帳、queueと配送保証、複数group、適用計画配布、retentionとの停止・再開協調は次工程に残す。

## 実装と検証結果

`scada_historian::recorder`へRecorder／Config／Report、Clock／Source traitを実装した。`recorder/clock.rs`のSystemRecorderClockは標準Instant／SystemTimeと絶対deadline待機を使う。停止後はStopped＋already_stopped=true、receipt／terminalなしのNoOpを返す。storeの既存identity／SessionSpec／Tick検証をcrate内で共用し、既存DB契約を弱めない。

ユーザーのS7での点数不足の経験を受け、相対sleepによる累積を明示的な回帰条件とした。仮想時計ではwake 3ms、read／処理相当7msずつ、capture 11msを与え、隔離SQLiteへ1時間分を保存した。

| 指標                           | 結果                       |
| ------------------------------ | -------------------------- |
| 予定slot／観測／commit済みtick | 各3600                     |
| missed slot／保存gap           | 各0                        |
| 最後slotのdeadline             | anchor＋3599×1000ms        |
| 相対sleepの対照モデル          | 周期ごと28ms追加で3600未満 |

Rust workspace330件（新規recorder16単体）・Clippy `-D warnings`／rustfmt・関連Chromium6件が成功。early wake、capture中のslot／horizon越境、実観測UTCとsourceTime保持、raw／minmaxとsamplingMissed、Bad／Stale／SIM／UnknownSource、時計異常／overflow、source／不正snapshot、取消、gap成功後の実FULLとNeedsReopen、DB後取消でのreceipt保持、std時計の短期待機を確認した。SIM／UnknownSourceは別の固定segment／sessionを使い、sourceの不整合を許容する変更はしない。

Astra最終レビューに必須修正はない。全体CIはPRで確認する。仮想時計試験は実S7の取得頻度やOSの実時間精度の測定ではない。DB format 5・H1・依存・固定SDK・Project・Banto・TS／通常Appは維持し、既存ブラウザ契約を回帰した。上流・S7・実環境には接続していない。
