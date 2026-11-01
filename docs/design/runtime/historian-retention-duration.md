# Historian H2c8: 明示duration policyからのUTC cutoff計算

2026-11-01。状態: **Astra 主設計の採用契約、Rust library実装・ローカル受入済み**。[時刻guard](historian-retention-clock-guard.md)、[一回分coordinator](historian-retention-coordinator.md)、[保持job](historian-retention-jobs.md)へ接続する。

## 今回閉じる境界

これまで保持cutoffはcallerの任意UTC値だった。H2c8では、明示された保持durationから同じ呼出しのclock sampleを使ってcutoffを再現可能に導出し、その設定変更もclock guardの停止対象へ含める。純粋な計算関数だけを追加して統合をcaller任せにせず、guard／coordinatorがpolicy由来の候補を内部計算する入口まで実装する。

初期の計算方式は **elapsed duration**。1日相当を86,400,000msと明示した場合は24時間であり、保存先のローカル日付境界で日数を数える方式ではない。[P5のローカル日付・timezone保持](historian-trend-contract.md)は共通利用候補／後続設計のままであり、今回実装済み・置換済みとはしない。timezone／DST／暦日を暗黙にUTC24時間へ変換しない。

DB format 4、H1 JSON、固定SDK／Project／Banto／依存は維持する。Rust policy／guard入力には明示的な小変更を行う。製品設定ファイル、policy配布、認証、実時計取得、schedulerは追加しない。通常App・上流・実Hub／PLC／DBに接続しない。

## 明示modeと設定全体の保持

既存RetentionClockPolicyに必須の `cutoff_rule` を加える。

| CutoffRule              | 意味                                      |
| ----------------------- | ----------------------------------------- |
| ExplicitCandidate       | 従来の明示UTC候補。計算policyを仮定しない |
| Elapsed {retain_for_ms} | sample.wall_time_msから明示durationを引く |

retain_for_msは1〜MAX_SAFEの整数ms。0、負値相当、過大値を許可しない。保持時間の暗黙default、未設定を短期間に読み替える処理、無制限の暗黙選択は作らない。既存呼出しもExplicitCandidateを明示する。

cutoff_ruleはRetentionClockPolicyの全体snapshotに含まれる。retain_for_msだけを別structに置き、policy_id／revisionの一致だけで旧guardを使い回す方式は採らない。duration、mode、revision、その他clock上限のどれかが変われば、同ID／同revisionでも次のsample評価でPolicyChangedへ停止する。callerの明示rearmと再warmupを経ない変更を通さない。

短縮だけでなく延長も設定変更として停止する。延長すれば既に削除した過去が戻るわけではなく、計算結果が現在fence以前ならNoAdvanceのまま。guardはfenceを後退させない。

## 純粋な計算関数

`derive_cutoff(&RetentionClockPolicy, reference_wall_ms) -> Result<DerivedCutoff, CutoffError>` を提供する。型の置き場はretention/policy.rs等でよい。clock_guardからのimport／reexportは許すが、policy検証を二重実装して条件をずらさない。

DerivedCutoff は `{policy_id,revision,reference_wall_ms,retain_for_ms,cutoff_ms}`。計算式は `cutoff_ms = reference_wall_ms - retain_for_ms`。checked subtractionまたは十分に広い整数で計算してからsafe整数範囲を検査する。飽和、0への切上げ、日境界への丸め、浮動小数変換は行わない。

CutoffError は次を区別する。

- InvalidPolicy: ID／revision／duration／clock上限等がpolicy契約に違反。
- NotElapsed: 正当なExplicitCandidate policyに計算を要求した。
- InvalidReferenceTime: reference_wall_msがsafe整数範囲外。
- OutOfRange: 正当なreferenceとdurationでも差がsafe整数範囲外。

負のUTC epoch msも許可する。例としてreference=1000、duration=1500ならcutoff=-500。最小safe時刻から正のdurationを引く場合はOutOfRangeであり、最小値へclampしない。duration=MAX_SAFEでも、結果がsafe範囲に入るreferenceなら計算可能。durationが正なので計算成功時のcutoffはreferenceより厳密に過去になる。

削除条件は従来どおり `sampleTime < cutoff`。cutoffちょうどのrecordは残す。この計算は有限query窓の1時間制限を保持durationへ流用しない。

計算成功は削除の認可やclockの信頼証明ではない。関数はOS時計を読まず、trustedも検証しない。DerivedCutoffを外部で保存して将来の削除tokenとして使わない。実行経路には以下のguard統合を使う。

## guard入力と評価順

assess_retentionのcandidate引数、およびCoordinatorInput.candidate_cutoff_msを **Option<i64>** にする。

| policy mode       | 入力                                   |
| ----------------- | -------------------------------------- |
| ExplicitCandidate | Some(safeなUTC候補)が必須              |
| Elapsed           | Noneが必須。同呼出しsampleから内部導出 |

ElapsedへSomeを渡すことも、ExplicitCandidateへNoneを渡すこともInvalidInput::Cutoff。外部で計算した候補をElapsedの安全検査へ紛れ込ませず、古い候補を再利用する経路を閉じる。

順序を次のとおり固定する。

1. policy、保存guard state、recovery DTO、candidate modeを検証する。構造不正のInvalidInputは既存のcaller fail-closed／明示rearm契約に従う。
2. sampleで既存advanceを実施する。MalformedClockSample、UntrustedClock、PolicyChanged、epoch／経過異常等は従来どおりSuspendedへ保持する。
3. active jobがあればExistingJobを返す。clock状態は更新するが、新cutoffは計算しない。明示継続する既存jobの固定cutoffを新policyで変更しない。
4. clockが安定していなければWaitForClock。Unarmedの最初のsample、重複sample、既存Suspendedで計算を先行させない。
5. 安定clockで新job候補を評価する場合だけ、ExplicitのSome値またはElapsedのderive結果を取得する。
6. Elapsed導出が失敗したら、新しい `SuspendReason::CutoffComputationFailed` でSuspendedを返す。更新直後のTrackingや古いbaselineへ戻さない。actionはWaitForClock。
7. 候補が得られたら既存のfuture／NoAdvance／max advance／initial ceiling／記録停止待ち／ProposeJobを適用する。

新sampleのunsafe wallや不正epochは、deriveのInvalidReferenceTimeを先に返して終わらずMalformedClockSampleとして停止する。trusted喪失やclock driftも計算失敗に置き換えない。duration変更は保存snapshotとの差としてPolicyChangedを優先し、単なる候補値の違いとして通さない。

初回sampleでは計算結果が範囲外になり得ても、まずPrimedで待機する。次の安定sampleで実際に導出不能ならCutoffComputationFailedへ停止する。停止後の正常sampleや時間経過で自動解除せず、明示rearmと二sample確認を必要とする。

## coordinatorとの接続

coordinatorはpolicy-derived専用の別wrapperを作らず、同じOption入力をguardへそのまま渡す。ElapsedのNoneを受けたcoordinatorが、guardより先にderiveしてErrだけ返す設計にはしない。これにより、異常sample／導出不能によるSuspendedを既存CoordinatorReport.next_stateへ確実に保持する。

Observeは計算・判定結果を取得するだけで削除しない。Beginでは、今回guardがProposeJobしたcutoffとcallerのJobRequest.cutoff_msが一致し、expected_cutoffも一致する場合だけ開始する。elapsed modeだからといってrequestを自動補正しない。job IDも生成しない。

callerがBeginの明示requestを準備するためにderive_cutoffを利用することはできる。ただしその値を信用してguardを省略せず、同じfresh sampleの内部計算とcoordinatorの一致検査を通す。事前計算が失敗した場合、古いrequestで処理を継続してはならない。Observe入力でguardの停止状態を受け取るか、自動経路を止めて入力を明示的に再設定する。

ContinueExistingはH2c7と同じく指定job／step／max_ticksだけを実行する。active jobがあるため新cutoffを導出しない場合でも、policy変更や不正clock sampleによるSuspendedはreportに残す。既存jobの継続と、新しい保持期間の適用は別の操作である。

policy短縮により計算cutoffが大きく進んでも、max_cutoff_advance／initial ceilingを迂回しない。既存P5の短縮プレビュー／applied policy管理が完成したと扱わず、製品統合前に別途その境界を実装する。今回のlibraryは任意durationが設定された瞬間に削除を始める仕組みではない。

## 予算と失敗時安全性

計算は固定長の整数演算と既存policy検証で、DB／filesystem／network I/Oを持たない。calendar crateやtimezone databaseを追加しない。guard stateを入力として受け取り、新stateを返す既存方式を維持する。

coordinatorのDB呼出し上限は引き続きrecovery一回＋最大一回のbegin／step。共有deadline／tokenと各APIの独立budgetを維持し、durationから古いcutoffが導出されたからといって大量stepをloopしない。保持jobのchunk上限やreceipt再送は変更しない。

設定不正はInvalidInputでcaller自動経路を停止する。正常な設定・sampleからの計算不能はSuspendedで停止を保持する。DB実行時エラーでもassessment／next_stateを落とさないH2c7の契約を回帰する。

## 受入

- 1ms、明示24h、MAX_SAFE duration、正／0／負referenceで正確に計算。0duration、過大duration、unsafe reference、safe範囲underflowを型付きエラーにする。
- cutoff境界のrecordは残り、その1ms前は保持対象になる。丸めやquery窓上限の流用がない。
- Explicit Some／Elapsed Noneのみを受理。Elapsedへ古いSome候補を渡したらInvalidInputで実行なし。
- 初回Primed、安定した次sampleでpolicy由来proposal。同sampleのObserve→Begin再利用は従来どおり待機。
- 同ID／同revisionのduration変更、mode変更、revision変更をPolicyChangedへ停止。延長も停止し、rearm後も既存fenceを後退させない。
- malformed／untrusted／clock異常sampleでは、その停止理由をderiveのErrで消さない。安定sampleからのunderflowはCutoffComputationFailedへ保持し、自動復帰しない。
- initial ceilingなし／超過、max advance超過、NoAdvance、active sessionの停止待ちをelapsed modeでも維持。
- coordinatorのElapsed Beginで内部導出と一致する明示requestだけを開始。不一致はNoWriteでrequestを補正しない。
- activejobの明示継続では新cutoffを計算・置換せず、clock／policy停止状態を保持。完了後の新候補では改めてguardを通す。
- isolated DBでcutoff前・同値・後のrecordsを用意し、明示jobの削除結果とexpiredが計算式に一致。既存Explicit guard／coordinator／job試験を回帰する。

この工程の完了は、明示duration設定から実際の保持job開始まで、計算と時刻安全性・設定変更検知が一貫して接続されたこと。ローカル暦日保持、信頼時計adapter、製品policy適用／短縮プレビュー、recorder制御、receipt GCは別の境界として残る。

## 実装と検証結果

`store::retention::policy`へCutoffRule／DerivedCutoff／CutoffErrorと`derive_cutoff`を実装した。policy検証は既存`clock_guard/validate.rs`と共用する。GuardStateの全policy snapshotへcutoff_ruleを含め、guardとcoordinatorのcandidateをOptionへ変更した。既存呼出しはExplicitCandidate／Someを明示し、Elapsed／Noneではguardが安定sampleから内部導出する。

Rust workspace284件（新規12単体、うち隔離DB統合5件）・Clippy `-D warnings`／rustfmt・関連Chromium6件が成功。正／負／0 referenceと24h／1ms／MAX_SAFE duration、safe端点と範囲外、mode迂回拒否、同revisionの短縮／延長・mode変更、clock理由の維持、計算不能の停止とrearmを検証した。

DB統合では記録停止待ち→明示close→fresh sampleと一致するBegin→一stepを確認した。cutoffの1ms前だけを削除し、同値／1ms後のrawを残し、実削除区間だけexpiredを投影する。古いBegin requestの不一致、初回認可／前進上限／NoAdvance、Malformed／計算不能report、既存jobの固定cutoff継続も確認した。Astra実装レビューに必須修正はない。全体CIはPRで確認する。

DB format 4・H1 JSON v1・依存・SDK・Project・Bantoは維持する。TS／画面は変更せず、ブラウザでは既存H1／SQLite投影契約を回帰した。上流・S7・実環境には接続していない。
