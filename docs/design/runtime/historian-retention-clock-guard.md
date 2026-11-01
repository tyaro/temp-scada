# Historian H2c6: 明示保持候補の時刻安全判定

2026-11-01。状態: **Astra 主設計の採用契約、Rust library実装・ローカル受入済み**。[保持 job](historian-retention-jobs.md)、[復旧状態照会](historian-recovery-state.md)を前提とする。

## 自動保持へ進むための具体的な単位

H2c6 は、caller が明示した保持候補を、信頼状態付き clock sample と単調時計の変化から評価する純粋 Rust 契約とする。従来の「異常時刻では掃除を保留する」を、テスト可能な状態遷移と数値比較へ具体化する。

保持日数、日付境界、timezone、OS時計、NTP、製品の policy 配布は今回計算・取得しない。候補 cutoff と policy は caller の入力である。新jobを自動生成・実行するdriverも追加しない。現在のstoreと独立して判断できるため、DB format 4、H1 JSON、SDK／Project／Banto／依存を維持する。通常 App、上流、実環境へ接続しない。

この契約は自動保持の時刻 guard と記録停止待ちを具体化する。単なる wall clock の現在値を根拠に削除せず、一方で製品未実装の認証やtimezoneを仮定した設定を増やさない。

## 純粋 API

概念 API は `assess_retention(policy, &guard_state, sample, candidate_cutoff_ms, &StoreRecoveryState) -> Result<Assessment, InvalidInput>`。結果は `Assessment {next_state,action}` とする。最終の型・名前は実装に従う。

### caller が指定する policy

| field                            | 意味                                                                        |
| -------------------------------- | --------------------------------------------------------------------------- |
| policy_id／revision              | 明示policyの識別。既存ID規則、revisionは1〜MAX_SAFE                         |
| tolerance_ms                     | wall経過とmonotonic経過の差に許す絶対値。0も許可                            |
| max_observation_gap_ms           | guardのsample間隔上限。1〜MAX_SAFE                                          |
| max_cutoff_advance_ms            | 現在fenceから新候補へ一度に進めてよい最大ms。1〜MAX_SAFE                    |
| initial_cutoff_ceiling_ms:Option | 初回fenceがない場合に明示許容するcutoff上限。Noneは初回削除候補を許容しない |

toleranceはmax_observation_gap以下とする。時刻上限はsafe integer UTC ms。これらに製品の暗黙defaultを与えない。初回ceilingは保持日数の代用ではなく、fenceのない初回処理にcallerが設定した上限である。

clock sample は `{clock_epoch, wall_time_ms, monotonic_ms:u64, trusted:bool}`。clock_epochは既存ID規則、wallはsafe整数。monotonicは同epoch内の経過msでありUTCと混ぜない。u64の差はchecked subtractionを使う。sourceTime、最後のraw、DB commit時刻をclock sampleへ代用しない。

trustedはcallerの宣言であり、関数が時計の信頼性を独力で認証するわけではない。将来のclock adapterは、どの時刻authority／観測からtrustedとepochを設定するかを別途契約化する必要がある。

## guard state と停止の保持

状態は `Unarmed`、`Primed {policy_snapshot,last_sample}`、`Tracking {policy_snapshot,last_sample}`、`Suspended {reason}` を基準とする。policy snapshotは全fieldを保持し、ID／revisionだけ一致して内容が変わるケースも検出する。

- Unarmedで最初のtrusted sampleを受けるとPrimedへ。まだ削除候補を出さない。
- Primed／Trackingで次のtrusted sampleを検証し、安定ならTrackingへ進みlast_sampleを更新する。
- 信頼喪失、policy変更、clock epoch変更、wall逆行、monotonic逆行、許容間隔超過、wallとmonotonicの経過差超過はSuspendedへ。
- Suspendedは後続sampleが正常でも自動解除しない。callerの明示rearmでUnarmedへ戻し、再び二つのsampleから確認する。

大きな時計前進を観測した直後にそのsampleを自動baselineへ採用すると、次の一周期だけで前進を追認してしまう。停止を保持するのはこの挙動を避けるためである。policy変更やepoch変更も、過去のbaselineを新しい基準へ暗黙変換しない。

同じmonotonic値かつ同じwall値の重複sampleは待機扱いとし、last_sample／Primed・Trackingを進めない。その呼出しでは新しい候補を出さない。同じmonotonic値なのにwallだけ違う場合はmonotonic不連続としてSuspended。monotonicが増えてwallが同じ場合は通常の経過差検査を適用する。

比較は wall_delta>=0、mono_delta>0、mono_delta<=max_observation_gap、`abs(wall_delta-mono_delta)<=tolerance`。境界の等号は許可する。wall差はsafe整数同士でもMAX_SAFEを超え得るため、checked arithmeticまたは十分に広い整数で比較し、浮動小数へ変換しない。monotonicのwrapを小さい経過として受理しない。

新しいsampleのunsafe wall／不正epoch等も `Suspended(MalformedClockSample)` として返す。Errだけ返して以前のTrackingが次回に復活する形にしない。停止理由は MalformedClockSample、UntrustedClock、PolicyChanged、ClockEpochChanged、WallClockRegressed、MonotonicClockRegressed、MonotonicClockDiscontinuity、ObservationGap、ClockDriftExceeded。既存Suspendedでは最初の理由を保持する。

InvalidInputは、不正policy、矛盾した保存guard state、矛盾したrecovery DTO、unsafe candidate cutoffなどAPI契約違反に限定する。Primed／Trackingの保存sampleがuntrusted等の状態も拒否する。Errを受けたcallerは自動適用を停止し、直前のproposal／Trackingを流用して自動処理を続けない。入力修正と明示rearmを行うことがcallerの契約である。入力stateを破壊的に変更せず、成功結果としてnext_stateを返す。

GuardStateは今回Deserializeを提供しない。Clone／Debug／等値比較と必要なSerializeに留め、JSONからの永続state復元を新たな経路にしない。明示rearmはUnarmedを生成する操作で、内部の時刻経過から起動しない。

## action の優先順と意味

入力の構造・相互関係を検証し、clock stateを更新したうえでactionを決める。

1. recovery_stateにactive jobがあれば `ExistingJob {job_id}`。新cutoffや新policyで既存jobを置換しない。このactionはjob継続の新しい認可ではなく、既存の復旧手順へ処理を戻す識別結果である。clockがSuspendedでも既存jobの存在を隠さない。state更新はactionとは独立して行い、ExistingJobを返す場合もclock異常をlatchする。
2. clockがPrimed／Unarmed／Suspended、または重複sample待機なら `WaitForClock`。Suspendedの理由は結果stateで示す。
3. 安定clockでもcandidateがwall_timeより未来なら `Deferred(CutoffBeyondClock)`。
4. fenceがありcandidate<=fenceなら `NoAdvance`。fenceを下げるproposalを作らない。
5. fenceがある場合、candidate-fence>max_cutoff_advanceなら `Deferred(CutoffAdvanceLimit)`。
6. fenceがない場合、initial ceilingがNoneなら `Deferred(InitialCutoffNotAuthorized)`、candidate>ceilingなら `Deferred(InitialCutoffLimit)`。
7. ここまで候補が妥当でもactive_session_idがあれば `WaitForRecordingStop {session_id}`。sessionを勝手にclose／interruptしない。
8. その他は `ProposeJob {cutoff_ms,expected_cutoff_ms,snapshot_commit,policy_id,revision}`。

cutoffによるDeferred／NoAdvanceや記録停止待ちでも、clock自体が正常ならTrackingのbaselineは更新する。これにより保持候補が変わらない間も時計の連続性を検査できる。clock異常のSuspendedと、単に候補が進まない状況を混同しない。

recovery入力は既存APIの検証済み結果を使う。純粋関数も、Initialのcutoff/revision、sourceとID、active jobとactive sessionの併存、jobがActiveであること、step request/receiptとstatusのID・番号・commit・件数関係など、入力DTOから判定可能な矛盾をInvalidInputとして拒否する。DB本文や全過去履歴を再検査する機能ではない。

## proposal と実行を分ける

ProposeJobにはjob IDを含めず、生成もしない。callerは保持の実行責任を持つhostとして、明示的に安定job IDとcanonical JobRequestを確保し、既存begin_retention_jobを呼ぶ。proposalを保存権限や第三者向けの署名済み削除許可証として扱わない。

proposalのsnapshot_commitは判断時点の説明であり、store側の新しいCASや永久leaseではない。実行時には既存begin_jobのexpected_cutoff、active session／active job、単一owner検査が再評価される。stale proposalを使ってConflict／Busyになったら最新recoveryを読み、判断をやり直す。storeが自動でcutoffやIDを補正して進めない。

clock proposalに有効期限付き実行tokenやpolicyの永続適用保証を持たせることは今回しない。判断から実行までに時計・policyが変わり得るため、将来自動hostは実行直前に新sampleとrecoveryで再評価し、入力policyとjob IDを安定保持する必要がある。古いproposalを無期限に実行する運用はこのguardの保証範囲外である。

この関数は壁時計を読むこともstoreを書き換えることもない。callerが明示trimを直接呼ぶ既存機能を撤去するものでもない。将来の自動保持経路が必ずguardを経由するhost統合は後続で検証する。

## 再起動・rearm・記録協調

guard stateは今回DBへ永続化しない。再起動後はUnarmedから始め、trusted sampleを二回確認する。過去epochのmonotonic値を新processへ持ち越して比較しない。stateを失った直後の単一sampleだけで削除候補を出さない。

二回のsampleが安定していても、再起動前に起きたwall時計の絶対的な誤りを独力で見抜けるわけではない。trustedの根拠、initial ceiling、cutoff前進上限は異なる役割を持つ。特に前進上限は一候補の上限であり、多数jobによる累積削除量を一日単位で制限するものではない。

rearmはcallerの明示的な基準再設定であり、guard自身が時間経過や正常sample回数で行わない。UI承認フローを今回発明する意味ではない。将来のhostは、信頼回復・policy適用・管理操作等のどの出来事でrearmするかを定める。

WaitForRecordingStopはrecorder協調の入口となる。hostは現在のsessionを安全に停止／flushしてからrecoveryを読み直す必要がある。guardは最後のrecordから正常endを推測せず、保持jobがactiveの間に記録を再開しない。停止・再開の実装を今回済ませたとは扱わない。

## 受入

- 初回trusted sampleだけではproposalなし、次の安定sampleで条件が揃えばproposal。重複sampleで勝手に進まない。
- wall逆行、mono逆行／wrap、同mono別wall、epoch変更、trusted喪失、policy revision／同revision内容変更でSuspended。
- 前進差・間隔・cutoff前進量の境界ちょうどは許可、1ms超過は停止またはDeferred。safe時刻両端とu64 monotonicでもoverflowしない。
- 異常後の正常sampleでは自動解除しない。明示rearm後も再warmupが必要。
- 初回ceilingなし／超過、future cutoff、fence以下、上限内の前進を区別する。NoAdvance等でも正常clockのbaselineは更新。
- active jobがあれば別proposalを作らずExistingJob。clock異常でも既存job IDを隠さない。
- active sessionでは停止待ち。状態を一切変更せず、quiescentになった新recoveryでproposalへ進める。
- freshなproposalから既存begin_jobを明示実行し、active job discoveryへ繋がるisolated DB統合例。stale fence／新active session／別job開始なら既存CASやBusyで拒否。
- malformed入力と正当なDeferred／Suspendedを区別し、判定前後のstoreや入力guardを変更しない。

H2c6は保持候補の時計安全判定と記録停止待ちを実装可能な契約へ進める区切りである。製品の信頼時計adapter、timezone／日数policy、policyのdesired-applied管理、実行host、recorder協調、receipt GCを暗黙に完成扱いにはしない。

## 実装と検証結果

`store::retention::clock_guard`へ`RetentionClockPolicy`／`ClockSample`／`GuardState`と`assess_retention`を実装した。入力を変更せず、`Assessment {next_state,action}`を返す。policy／guard／recovery／cutoffの契約違反は`InvalidInput`、新sampleの異常はstickyな`Suspended`とする。構造検証は`clock_guard/validate.rs`に分離した。

復旧DTOは出典とcommit、active job／session、直近request／receiptと累積件数を照合する。直近stepを差し引いた過去tick数が`step−1`〜`(step−1)×1024`、過去観測数が過去tick数〜8倍であることも検査する。これによりstep 1で累積件数だけ増えた矛盾も拒否する。DB本文の再監査や実行認可を加えたものではない。

Rust workspace256件（新規22単体、うち隔離DB統合4件）、Clippy `-D warnings`／rustfmt、関連Chromium6件が成功。warmup／duplicate、全停止理由とrearm、full policy比較、safe時刻両端・u64 wrap・広い差分、許容境界、候補優先順・baseline更新、不正DTO、判定の無変更性、明示begin→partial→complete、記録の明示close、新fence／新session／別jobによるstale proposal拒否を確認した。TS／画面の変更はなく、ブラウザでは既存H1／SQLite投影契約を回帰した。全体CIはPRで確認する。

DB format 4・H1 JSON v1・依存・SDK・Project・Bantoは維持する。通常App・上流・S7・実環境には接続していない。

Astraの実装レビューで累積件数と直近stepの差分検査を補強し、正常な複数stepと矛盾入力の回帰を追加した。最終レビューに必須修正はない。
