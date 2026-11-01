# Historian H2c9: 保持policy変更の実データ影響preview

2026-11-01。状態: **Astra 主設計の採用契約、Rust library実装・ローカル受入済み**。[P5の設定適用と短縮preview](historian-trend-contract.md)、[elapsed policy](historian-retention-duration.md)、[復旧状態](historian-recovery-state.md)を前提とする。

## 選定理由と範囲

P5は、保持短縮の適用前に削除対象previewを返し、設定保存だけでは削除を開始せず、適用済みpolicyによる掃除と分離する契約を採用している。追加の人手承認フローや多段階approval tokenを要求しているわけではない。

H2c9はこのうち、**明示policy変更が現存データのどこへ影響するかを同snapshotで説明するpreview**を閉じる。旧／新durationから同じ参考UTC時刻でcutoffを計算し、実際の残存tick／observation／seriesと、追加対象／対象外化の区間をSQL集約で返す。小さなguard wrapperではなく、短縮判断に必要な実データ情報を追加する工程である。

現storeはapplied保持policyを永続化していない。したがって旧policyはcallerが指定する比較基準であり、実際に適用済みと偽称しない。永続policy適用／expected-applied revision、製品設定配布、管理認証、信頼時計、暦日timezoneは別工程。DB format 4、H1 JSON、SDK／Project／Banto／依存を維持する。上流・通常App・実Hub／PLC／DBには接続しない。

## API と結果

`preview_retention_change(&mut self, &RetentionPreviewRequest, &QueryControl) -> StoreResult<RetentionPreview>` を基準とする。最終の綴りは実装に従う。

Request は reference_wall_ms、proposed_policy、任意comparison_policy。policyは既存RetentionClockPolicyの全文で、今回はElapsedのみを受け付ける。参考時刻はsafe整数の明示UTC ms。実時計を取得せず、trustedを宣言したことにもならない。

| 結果              | 内容                                                                        |
| ----------------- | --------------------------------------------------------------------------- |
| recovery          | 同snapshotのStoreRecoveryState。fence出典／active session／active jobを含む |
| reference_wall_ms | 両policyに共通の計算基準                                                    |
| proposed          | PolicyImpact `{policy,cutoff_ms,targets}`                                   |
| comparison        | 比較指定時だけPolicyImpact。未指定ならNone                                  |
| difference        | 比較指定時だけPolicyDifference。未指定ならNone                              |

PolicyDifferenceはchange（Shorter／Longer／SameDuration）、newly_targeted、no_longer_targetedを持つ。各RangeImpactは任意range `{from_ms,to_ms}` とtargetsを持つ。

Targetsは `ticks:u64, observations:u64, series:u64, earliest_sample_ms:Option<i64>, latest_sample_ms:Option<i64>`。byte回収量や物理容量削減率を返さない。SQL整数countからの変換と集約結果は検査し、負値をu64へcastして成功させない。

## cutoff と差分区間

両policyのcutoffはH2c8のderive_cutoffを同じreference_wall_msで呼んで得る。policy不正、ExplicitCandidate、unsafe reference、underflowは要求エラーであり、短いdefaultやclampへ切り替えない。両入力を検証してから部分的なpreviewを作らない。

新durationが短いと新cutoffが大きくなる。追加対象は **[旧cutoff,新cutoff)**。長いと逆になり、今回のpolicyでは対象外になる範囲は **[新cutoff,旧cutoff)**。同durationなら差分区間はない。空差分はrange=None、全count0、両extrema=Noneとする。非空区間でも実recordがなければcountは0・extrema=Noneであり、range自体は残す。

各policyの全対象は `sampleTime < cutoff`。cutoff上のrecordは対象に含めない。期間差分と全対象の端点規則を一致させる。

分類はdurationの大小だけである。ID／revision／clock条件が異なっていても同durationならSameDuration。policy全文を結果へ残すことで、保持量の差がないことと設定全体が同一であることを区別する。同ID／同revisionで内容が異なるpolicyも比較計算自体は許す。これは設定適用の許可ではなく、実行時のfull-policy snapshotによるPolicyChangedを迂回しない。

comparison=Noneのとき、仮想の旧durationや旧policyを作らない。新policyの全対象だけを返す。初回適用の承認やinitial cutoff ceilingをこのpreviewで代用しない。

## 現在のfenceと実在データ

cutoffを現在fenceへ切り上げ・切り下げしない。両policyの計算値と実際のretention_fenceを別々に返す。候補がfence以前なら、新しい記録の受入や掃除ではNoAdvanceになり得るが、previewが計算値を変更してはならない。

対象countは **現在snapshotのobservationsに残るものだけ**。既にexpiredへ移ったrecord、pendingにある削除済みrecord、commits.payload_jsonにだけ残る値は数えない。保持を延長しても削除済み履歴は戻らず、no_longer_targetedは「今残っている中で、比較policyなら対象だったもの」を表す。

active session中もpreviewを許す。active job中もBusyにはせず、recoveryにそのjobを添えて残存rawの影響を返す。同timestampを段階削除している途中では、未削除のtickだけが対象countになる。処理前の総量をpendingから逆算して加えない。

このsnapshotのcountが実際の適用・掃除時にも同じとは限らない。記録やjob stepが進めば新しいpreviewが必要である。短縮適用を実装する後続工程は、適用直前のfresh previewとexpected-applied revisionの検査を組み合わせる。今回の結果をreservation／authorization／lease／実行tokenにしない。

## countの厳密な定義

- tickは異なる `(session_id,sequence)`。同timestampの別tickは別件とする。
- observationsは対象tickの固定member全行。GoodだけでなくBad／Stale／SIM等の無値recordも含む。
- seriesはその区分に一行以上の対象observationを持つdistinct series_id。metadataにあるだけの系列を数えない。
- earliest／latestは対象recordのsampleTimeの最小／最大。sourceTime／ingestedAtを代用しない。

全対象0ならticks／observations／seriesは全て0、extremaは両方None。対象ありなら `1<=series<=observations`、`ticks<=observations<=8*ticks`、extrema両方ありかつearliest<=latestを満たす。さらに各区分の端点と整合することを確認する。

同durationの旧／新は同count。短縮なら新全対象=旧全対象+追加対象、延長なら旧全対象=新全対象+対象外化がtick／observationについて成立する。series数は集合の重複があるため、この加算式を使わない。

## whole tickを保つSQL集約

新旧cutoffの大きい方より前に一行でもあるtick keyを候補として、そのtickの **全member** を読み直すSQLを使う。期間filter済みの行だけをGROUP BYして、壊れた不揃いtimestampを正常な部分tickとしてcountしない。

今回のpreviewはsession_members表を固定member集合の基準とし、検査する構造を次の範囲に限定する。

1. 対象tickの固定memberが1〜8で、欠落／余分なmemberがなく、series／segment参照が一致する。
2. 全memberのsampleTime、clockEpoch、commit_versionが同じ。sampleTimeはsafe整数、識別子は既存規則に適合する。
3. sessions、commits、session_members、segmentsへの必要参照がある。LEFT JOIN等で欠落をcorrupt countへ反映する。
4. `session.begin_commit < tick.commit <= snapshot_commit`、terminal sessionならさらにtick.commit<end_commit。sequenceは保存済み範囲内である。
5. sessionのactive／terminalとend commit、正常な参照範囲を検査する。

spec_jsonとmember表の本文等値、値・Quality／SourceEpochの全内容、全receipt JSONのcanonical等値、過去全履歴の完全監査は今回previewへ追加しない。これは削除対象countの構造検証であり、後続trim／jobが必ず成功する保証ではない。実行側の既存validate_ticksを弱めない。

SQL内で選択tick／member検証と区分ごとの集約を行い、corrupt_countがあれば要求全体をCorruptDataにする。rawや全tickをRustへ大量decodeしない。結果の区分は新全対象、旧全対象、追加対象、対象外化の最大4組で十分である。実行はmax cutoff未満のwhole tick構造検査一回に続き、新全対象／旧全対象／非空の差分側の最大3集約とする。追加と対象外化は同時に非空にならないため、他方にはゼロ結果を置く。seriesは対象のdistinctをSQLで数える。

整合しないtickをWHEREで除外して正しい件数のように返さない。0件の検索でも、recoveryの必須singletonやfence等は正常に検証する。

## snapshot・資源・有限予算

自前の一回run_maintenanceとBEGIN DEFERREDを使い、最初のlast_commit実readでsnapshotをpinする。その同transactionで既存recoveryの内部read処理とpreview集約を行い、結果を検証してROLLBACKする。public recovery_stateをnested呼出しして別snapshotを混ぜない。

recoveryのBEGIN〜ROLLBACK内の読取部分を小さな内部helperへ抽出して共有できる。既存recoveryのfirst-read hook／snapshot受入を維持し、fence／active metadata検証をpreviewに複製しない。

全SQLのVM先払い／progress、scalar／decoded row、policyやmetadataのbyte、結果byte、取消／deadlineは単一Budgetを共有する。過大範囲や大量データでVM／deadlineに達したら全要求エラー。LIMITで先頭だけをcountしたり、部分countを完全な結果として返したりしない。

count計算は多くのDB行を走査し得るが、期限処理の1024tick上限をpreview対象件数へ流用しない。SQLの仕事量は5M VM等の既存安全予算で制限する。新依存やformat変更なしで実装し、性能保証や長期履歴の容量目標をこの初期値から推測しない。

読取中の取消／SQLfailure／panicは既存Operation guardによりhandler解除→rollback。cleanup失敗時のpoison、FULL等をControlへ隠さない分類も維持する。成功時にcounter／fence／job／policy／rawを一切変更しない。

## 受入

- 比較なし、短縮、延長、同duration、同durationで異ID／revision、同ID／revision内容変更の意味が明確。
- cutoff前／同値／後、差分区間の両端、負時刻、safe境界、0件と非空区間の0件。計算失敗でdefaultを作らない。
- 同timestamp別tick、複数member、複数series、無値recordを含む正確なcount／extrema。
- current fence以前の候補、すでにexpiredのrecord、activejobのpendingと残存rawを二重計上しない。
- active session／activejob中のpreviewがread-onlyで成功し、その状態を同snapshotのrecoveryに添える。
- query途中の別transaction commitで旧snapshotのcountsとfenceを混ぜない。全logical writeをauthorizer拒否してもpreviewが可能。
- member欠落／余分、同tickのtimestamp不一致、commit／session／segment参照破損をCorruptDataとして全体拒否。
- 1024超tickもSQL予算内なら正確に集約。低VM／row／byte、取消で部分countなし。cleanupとpoisonを維持。
- 後続の明示jobを実行した後にfresh previewが変わることを確認し、以前のresultを固定対象tokenと扱わない。

H2c9の成果は、保持短縮で追加削除される実在範囲と件数を、副作用なく説明できること。applied policyの永続化や短縮適用はこのpreviewを消費する次の契約であり、現在のcaller比較policyをappliedと見せかけない。

## 実装と検証結果

`store::retention::preview`へRetentionPreviewRequest／RetentionPreview／PolicyImpact／PolicyDifference／DurationChange／RangeImpact／PreviewRange／TargetCountsと`preview_retention_change`を実装した。`preview/validate.sql`が選択tickの全member構造を検査し、`counts.sql`が各区分を集約する。`recovery::read_snapshot`を内部抽出し、既存復旧照会とpreviewが同じ検証を共有する。既存のfirst-read hookと予算課金は維持した。

Rust workspace298件（新規preview14単体）・Clippy `-D warnings`／rustfmt・関連Chromium6件が成功。短縮／延長／同duration、比較なし、同timestamp別tick、1／2member混在と無値、境界／負時刻／空区間、fence以前、active session／部分job、read-only authorizer、途中external commitの同snapshot、構造破損、1025tickと低VM／32 decoded rows、取消・panic・SQLfailure・rollback poisonを確認した。既存recovery15単体も共有helper抽出後に回帰した。

Astraレビューで見つかったSQLiteのNUL後方文字見落としは、4識別子の明示`instr(...,char(0))`検査で補強した。全memberを同じNUL clockへ変えた回帰の失敗を再現し、修正後の成功を確認した。tick／observationの差分加算、同durationの全count一致も検査する。最終レビューに必須修正はない。全体CIはPRで確認する。

DB format 4・H1 JSON v1・依存・SDK・Project・Banto・TS／通常Appは維持する。ブラウザでは既存H1／SQLite投影契約を回帰し、製品UIを追加したものではない。上流・S7・実環境には接続していない。
