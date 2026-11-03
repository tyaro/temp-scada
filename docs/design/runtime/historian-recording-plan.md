# Historian H5: 記録計画の保存・適用・稼働管理

2026-11-03（日本時間）。**Astra主設計の採用契約。H5aの独立desired JSON契約は実装・ローカル受入済み。H5b1の永続台帳も実装・ローカル受入の対象。H5b2のnative activation bindingも実装した。supervisor、Project fieldは未実装。** [P5 §3](historian-trend-contract.md#3-記録設定の所有と配布)の責務を、現行の単一group実装へ段階的に接続する。実環境、Industrial/S7、実Hub、実DB、設定、資格情報にはアクセスしない。認証・製品transport・通常Appの実接続は引き続き保留する。

## 採用範囲と現行との違い

初期は一つのdeployment/storeにつき一つの適用済み記録計画、一つのgroup、一つの論理Hub、一つの周期、1..8系列とする。複数Projectのmerge、group並列writer、queue、変化時記録、deadbandは導入しない。表示画面やTrendペンの集合から記録対象を生成しない。

現行[SdkRecorderPlan](../../../crates/scada-runtime/src/recorder_source/plan.rs)はcallerの固定SessionSpecとSDK pinを照合し、同HubInstance・同周期100..3,600,000ms・1..8 membersを要求する。[RecordingHost](../../../crates/scada-runtime/src/recording_host.rs)のstart成功はworker受付であり、記録開始成功ではない。[PlanRef](../../../crates/scada-historian/src/store/evidence.rs)はplan_idとrevisionだけを持ち、hash検証・desired配布・applied台帳ではない。

現行SQLite format5、[保持policy適用](historian-retention-policy-application.md)のCAS/receipt、[記録と保持の協調](historian-recording-retention.md)は利用できる基盤である。ただし保持policyのapplied revisionを記録計画のrevisionとして使わない。SDK taskとSQLite transactionを一つのcommitにするAPIも現在存在しない。

設計PR #42は文書だけの変更としてマージ済み。続くH5aで独立した純粋契約を実装した。Project 0.36.0、SDK、Banto、DBformat、H1は設計区切りとH5aで維持する。

## desiredの意味と独立JSON（H5a）

```ts
interface DesiredRecordingPlan {
  version: 1;
  kind: "recordingPlan";
  planId: string;
  revision: number;
  enabled: boolean;
  group: {
    groupId: string;
    hubRef: string;
    periodMs: number;
    members: {
      memberId: string;
      externalName: string;
      valueType: "number" | "bool";
    }[];
  };
}
```

これは独立JSONの採用shapeであり、現行Projectのfieldではない。UIが保持するdraftと明示保存したdesiredを分け、Projectへの組込みはH5dに行う。planIdは計画の論理ID、revisionはその内容版で1..MAX_SAFE_INTEGER。Project revisionとは別で、無関係な図形編集では上げない。planId/revisionの組は一度配布したらimmutableである。

hubRefはdeploymentが解決する論理参照。memberIdは計画内の管理キーで、タグの永久identityではない。externalNameはSDK Bindingの要求名であり、同名再作成やHub移設の継続性を証明しない。desiredにはseriesId、incarnationId、segmentId、SDK run_id、URL、資格情報、保存先、保持設定、sessionId、clockEpochを持たせない。

| 制約                           | 決定                                                                  |
| ------------------------------ | --------------------------------------------------------------------- |
| planId/groupId/hubRef/memberId | canonical H1 IDの1..64 ASCII制約、末尾改行拒否                        |
| members                        | 1..8、memberId一意、externalName完全一致重複を拒否                    |
| externalName                   | 1..512 Unicode codepoints、空白だけを拒否、元文字列を保持しtrimしない |
| periodMs                       | safe整数100..3,600,000ms、全memberで共通                              |
| enabled=false                  | groupとmembersを保持した無効計画。空計画や削除命令ではない            |
| JSON                           | 64KiB、depth32、node4096、未知field・孤立surrogateを拒否              |

空白集合・Unicode scalar・正規化整数compact UTF-8 byte計数は[Trend契約](historian-trend-definition.md#h4c1-独立した保存契約)と同じ。独立入力はstructured JSONであり、wire長の制限を代替しない。membersの順はdesiredでは保存するが稼働意味を持たない。canonical比較時だけmemberId順に整列する。sourceの数値型細分、unit、Quality/SIM方針はこのJSONから推測しない。初期のSIM/UnknownSourceの値除外は既存Historian契約を維持する。

共有Schemaは `crates/scada-model/schema/recording-plan.schema.json`、fixtureは `examples/recording-plan-cases.json`。H1 resourceを両言語へローカル登録し、外部取得しない。Rustのowned wrapperとTSのowned/frozen parser、boolean validatorを用意する。H5aはidentity発行やSDK plan生成まで行わず、resolverの純粋受理と実在確認を混同しない。

## deploymentによる解決と永久identity

deploymentはStoreIdentityのstore_id/deployment_id、hubRef→hubInstanceIdと接続clientの対応、記録計画の管理owner、適用済み保持policy、時計設定を所有する。初回の管理libraryではcallerが明示提供する。認証が未実装だからといって公開の匿名apply endpointを作らない。

enabled計画の適用候補はmemberごとの次の解決結果を必要とする。

- desiredのmemberIdに対応する、Historian管理側で登録済みのH1 IdentityDescriptor全体。
- memberId/externalName/valueType/periodとdescriptorの完全な対応。同一HubInstance、series/incarnation/segment整合、同名重複禁止を既存SessionSpec検証でも確認する。
- deployment側のmappingRevisionと、hubRef→hubInstanceId対応。mappingRevisionは1..MAX_SAFE_INTEGERのsafe整数で、同版の別内容を拒否する。登録自体は明示の管理操作とし、現在mapping headへのCASと再送IDを持つ。登録だけではappliedや稼働中の固定planを変更しない。

seriesId/incarnationIdは管理側が発行・継続性確認する。UIのタグ選択だけで発行済みとみなさず、外部名/SDK StableTagId/tag_keyから自動導出しない。初期登録手続は明示のlibrary入力と隔離fixtureで検証し、製品自動発行UIは別工程とする。別Hubの同名、削除後同名再作成、継続性不明は新identityの登録またはidentityPendingで止める。既存系列へ黙って結合しない。

SDK run_id/catalog revision/generation、stable ID、tag_key、collection modeは**activation時の検証pin**であり永久identityの代用ではない。activation時にはappliedへ保存したmapping版と保持policy版がそれぞれ現在headに一致することを要求する。どちらかが進んでいれば新applyが必要であり、古い版を最新とみなさない。これは稼働中のplanを自動変更する命令ではない。稼働前に一つのcoherent generationから現在pinを作り、SdkRecorderPlan::new/projectionの既存gateを通す。適用時のpinを再起動でそのまま信頼しない。現在SDKのrun/source変化で停止する保守的な契約を弱めない。

descriptor変更は既存永久metadataの制約に従う。新unit/type/period/source等の意味変更は新segmentを明示し、既存segmentを上書きしない。desiredが同じでもmappingが変われば新apply revisionとなる。namespaceを実Historianへ結び付ける製品adapterは後続であり、これだけでTrendのnamespace認証を完成したとしない。

無効計画はresolution=nullで適用できる。Hubがofflineでも停止設定を保存できるようにするためであり、既存seriesや対応履歴を削除しない。再有効化には新desired revisionと全memberの再確認済みresolutionを要求する。無効計画を適用する際も旧workerの停止/joinは必要である。

## 原子的applyの決定点（H5b）

**applyは「記録可能な固定計画を永続設定として切り替える操作」であり、接続・初回sample・常時稼働成功を意味しない。** P5の「失敗時は旧applied維持」はこのcommit前のapply失敗に適用する。commit後のactivation失敗は別の稼働失敗であり、新appliedと失敗状態を保持する。成功receiptを返した後に旧設定へ黙ってrollbackしない。

初期applyは全group原子的。停止前のread-only preflightで純粋型/予算、ID/revision範囲、immutable定義、既知receipt、対応未解決、現在CASと台帳容量を検査し、拒否できる要求では旧workerを止めない。preflightはreservationではなく、停止/join後のtransaction内でCAS/容量/対応を再確認する。既知receiptの再送はこの段階で返し、stopもactivateも行わない。SQL transactionへ入る前に旧workerをstop/joinし、SDK shutdown結果、session cleanup、保持job、clock/retention latchを確認する。台帳だけが旧workerを止めたことにしない。DB自身もactive session/jobなしをtransaction内で検査する。旧worker停止はSQLiteと原子的ではなく、apply失敗時に旧appliedが残っても旧workerは停止済みであり得る。状態をStoppedとして明示し、自動で旧workerを再起動しない。

採用する管理library入力の概形:

```text
ApplyRecordingPlanRequest {
  request_id,
  expected_applied_revision: Option<safe_u64>,
  desired: DesiredRecordingPlan,
  resolution: Option<ResolvedRecordingGroup>,
  expected_mapping_revision: Option<safe_u64>,
  expected_retention_applied_revision: Option<safe_u64>
}
apply_recording_plan(request, QueryControl) -> ApplyRecordingPlanReceipt
recording_plan_state(QueryControl) -> AppliedRecordingPlanState
recording_plan_receipt(request_id, QueryControl) -> Option<Receipt>
```

初回expected_applied_revision=None、以降は直前recording applied revisionとのCAS。保持policyは別の適用済み台帳を参照し、enabled適用時に明示保持設定があることと期待版を確認する。disabled適用では保持の設定有無で停止を妨げないため、この入力のretention期待版はOptionalとし、enabled時のみSome必須とする。mapping期待版もenabled時のみSome必須とし、disabledはNoneに限定する。これらのOptional条件を実装時Schema/型へ反映する。

同requestIdは同一canonical要求なら保存済みreceiptを返す。receiptを最初に検索し、再送時に現CAS、active job、旧SDK pin、現在の保持設定を再適用条件として課さない。receiptは過去commitの結果であり、現在もその計画が稼働中という回答ではない。同requestId別内容はConflict。同planId/revision別desiredもConflict。違うrequestIdでは内容が同じでもCASを満たす新適用としてrevisionが進む。古いdesired版を明示再適用するrollbackは許容するが、現在版CASと現在resolution確認を省略しない。

canonical本文は型付き検証後、object keyを辞書順、member/mappingをmemberId順、小さい整数を10進表記、文字列は保持したcompact UTF-8 JSONとする。SHA-256 digestをstoreが計算し、desiredHashとresolvedConfigHashを記録する。hashは検索/診断用で、認可・タグ継続性の証明ではない。再送/immutable照合はcanonical本文も比較し、hash一致だけに依存しない。H5aはdigestを出さず新依存を追加しない。H5bで共通digest実装がなければ検証済みSHA-256 crateをversion固定で導入する。現lockにsha2はないため、この依存追加はH5bの明示差分とし、自作暗号実装を行わない。

receiptにはrequestId、appliedRevision、commitVersion、desired planId/revision、両hash、ledger PlanRef、enabled、設定適用成功を返す。UTC適用時刻をcaller clockから記録する場合は観測情報に留め、CASや順序はcommit/revisionを使う。壁時計逆行でrevisionを巻き戻さない。

## 永続台帳と既存PlanRefへの接続

H5bでDBformatを**6**へ進め、未知formatとformat5を明示拒否する。自動migrationは追加しない。既存履歴/H1の公開DTOは変えない。

最小の論理tableは次の構成とする。実SQLのFK/整数型は実装レビューで既存commits規律に合わせる。

| table                         | 主な内容と不変条件                                                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| recording_desired_definitions | (plan_id,revision) PK、canonical desired、desired_hash、first_commit。本文immutable                                                          |
| recording_mapping_revisions   | mapping_revision PK、hubRef/hubInstanceIdとmember対応のcanonical本文。管理更新は独立操作、同版別内容不可                                     |
| recording_plan_applications   | request_id UNIQUE、applied_revision UNIQUE、expected revision、canonical request、resolution snapshot、hash、commit FK、receipt。append-only |
| recording_plan_state          | singleton、store発行ledger_plan_id、current applied_revisionへのFK。最新applicationとの一致を検査                                            |
| recording_activations         | activation_id UNIQUE、applied_revision、session_id UNIQUE、clock_epoch、状態/commit根拠。別のsource開始結果を成功applyへ混ぜない             |

mappingのcurrent headは独立singleton（recording_mapping_state）として保存する。expected_mapping_revisionは履歴行の存在だけでなくこのheadに一致することを要求する。mapping版と保持policy版のSome値はいずれも1..MAX_SAFE_INTEGERとし、0は使わない。未適用はNoneだけで表す。

H5bの適用transactionはdesired immutable照合、mapping/保持版CAS、permanent descriptorの矛盾検査、application/receipt/commit、singleton head更新を一括commitする。descriptorの新規予約もこのtransactionに含め、後のsessionが失敗しても適用済みの系列対応を変更しない。未記録descriptorをHistory APIで既存queryが扱う際は現行「既知だがsessionなし」をCorruptDataにする規則との衝突があるため、**適用台帳のresolution予約は既存query用series/segmentsへ挿入しない**。最初のsession beginで既存表へ登録し、それまでは管理台帳だけに存在する。照合は既存permanent tableを読み、新規予約間の矛盾も台帳から検査する。

ledger_plan_idはstoreが一度発行するH1 ID。既存の手動PlanRefと同じIDを再利用せず、発行時に既存evidenceとの衝突を拒否する。記録sessionのPlanRefは `{plan_id: ledger_plan_id, revision: recording_applied_revision}` とし、対応するapplicationが一意に見つかるようにする。desired planId/revisionと保持policy版は別列で保持する。既存H2b3のPlanRef契約にhash fieldを追加しない。

mapping登録とactivation履歴はH5bに一括で詰めず、H5b1で台帳基礎/登録/CAS、H5b2でsessionとの永続bindingへ分けてもよい。ただしraw queryへ未記録予約を漏らさないこと、apply inputの対応表が実際に登録版と同一であることは最初の台帳PRから保証する。DBformat6へのDDL一括追加自体を各機能の完成とはしない。

最初のmanaged applicationを持つstoreでは、store側のsession開始gateを権威とする。H5b1だけの段階では新activation/session開始をすべて拒否し、b2/H5cのbinding対応入口が完成してから許す。既存public begin_session/begin_timed_session/RecorderConfig/RecordingHostでcallerが任意PlanRefを渡しても、このgateを迂回できない。非managed storeの従来fixture/library入口は維持するが、managed storeを非managedへ黙って降格させるAPIを追加しない。binding対応後も新sessionには現在appliedとenabled/activationの原子的照合を必須とし、matching PlanRefを手入力しただけでは許可しない。保存済みbegin/tick等の同内容再送は過去receiptの照会として先に識別し、新開始として拒否・再実行しない。

## Supervisorの操作とstate machine（H5c）

supervisorはRecordingHostを一つ所有し、UI寿命に結び付けない。worker/保持turn/plan適用turnを同時に持たない。stopは取消要求、joinは終了確認であり、join待ちを取消してもtask/storeを捨てない。Dropもhard停止を偽装せず、既存workerがcleanupするまでwriter所有を保持する。

| 状態/要求                          | 決定                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------- |
| Runningへ新apply要求               | 同時applyはBusy。候補の純粋検証/明示resolution照合を先に行い、明示stop→joinへ進む           |
| 停止/join待ち                      | Starting/Stopping/FinishedUnjoinedを完了としない。有限の一要求だけを保持                    |
| cleanup/source shutdown成功        | Quiescent。active session/jobなしを確認してapply可能                                        |
| cleanup失敗/clock/source異常/panic | Blocked/Faulted。旧applied維持。勝手にtake_store→new Hostでlatchを消さない                  |
| apply SQL失敗                      | 旧applied維持。DBfailureはNeedsReopen、入力/CAS不正は操作失敗。停止済み状態を報告           |
| apply commit成功                   | 新applied＋NeedsActivation、enabled=falseならDisabled。記録成功とは表示しない               |
| 明示activate(appliedRevision)      | current headと一致、enabled、保持/時計/identity条件を満たす時だけ新session/clockでstart受付 |
| worker start成功                   | session begin成功を確認してRunning。SDKが再接続中なら既存null記録規則に従う                 |
| activation失敗                     | 新appliedは残り、ActivationFailed/Blocked。旧計画へ自動復帰しない                           |
| 明示pause                          | stop/joinのみ。appliedは変わらない。次のserver起動で有効appliedの再開候補になり得る         |
| 永続的に停止したい                 | enabled=falseの新desiredを明示applyする。pauseと区別する                                    |

実装入口は `request_apply`/`request_stop`/borrowed `join_operation`/`activate`/`state` の単一ownerとし、受付tokenと永続requestIdを分離する。statusは一つのbounded latest、receiptはjoin/state APIで取得し、全tick/全進捗を無制限queueへ積まない。SDKのasync executorを生かしたまま既存spawn_blocking保存workerを使う。

停止前のDB preflight/receipt再送を行うには、worker所有のSqliteStoreを別threadから直接借用しない。H5b/H5cでboundedなread-only管理snapshot readerを用意し、既存readerと共通の最大2 lease、同一QueryControl/deadline、cleanup規律で台帳を読む。snapshot終了まで資源枠を保持し、writerのSQLite connectionを共用しない。現在のHistoryReader APIにはこの管理照会がないため追加実装が必要である。管理readを確保できなければBusyで、旧workerを止めず再試行を返す。preflightは永続identity予約を書かず、新しい予約はjoin後のapply transactionだけで行う。

apply用の一時store移動も既存hostのretention turnと同じ所有規律で行う。callerへstoreを取り出してhostのclean-pause/rearm情報を失わせるwrapperにはしない。retention job pendingやclock guard Suspendedは明示復旧まで維持し、計画変更をrearmの代わりに使わない。初回のsupervisorからは「適用後に自動activate」を行わず、別の明示操作とする。後続のserver起動driverが同じ条件付きactivateを呼ぶことは許す。

activationIdの再送も同一内容を識別する。sessionを毎回再生成して重複workerを作らない。session開始とactivationのsession/applied bindingは同じSQLite transactionへ追加する必要がある。**これは既存RecordingHost::startにはないH5cの実装変更**であり、別々のpost-write sidecarで達成したとしない。start受付だけで成功activation receiptを永続化しない。

既存session開始済みactivationの再送はそのsession結果を返し、新sessionを作らない。再起動後のそのsessionはinterruptedであり再開不可。再開には新activationId/sessionId/clockEpochが必要となる。SDK pinsはfreshに検証し、source名のrenameや型/意味変更を勝手に既存segmentへ当てはめない。

## 再起動・取消・容量障害

server起動はstore復旧→台帳整合読取→旧active sessionのinterrupted確認→applied enabled状態確認→fresh deployment/identity/clock/保持条件の検証→新activation、の順とする。最後のdesiredファイルや開いている画面から起動しない。接続/資格情報/時計信頼が未提供ならNeedsActivation/Blockedとして停止する。これはP5の「最後のappliedから起動」を実現する条件付き復旧であり、未確認identityで無条件に再開する意味ではない。

| 障害点                           | 再起動/再送の結果                                                            |
| -------------------------------- | ---------------------------------------------------------------------------- |
| 旧worker停止前                   | 旧applied。再送は旧workerを重複起動せず停止状態を再確認                      |
| join後、apply commit前           | 旧applied、旧sessionは終了。設定失敗と稼働停止を別表示                       |
| application transaction途中/FULL | 全rollback。旧head/receipt維持、NeedsReopenの既存規則                        |
| apply COMMIT後応答喪失           | 同requestIdで同receipt、新headを取得。再applyしない                          |
| 新applied、activation前          | NeedsActivation。勝手にRunningへ復元しない                                   |
| session begin COMMIT後応答喪失   | activation/session対応から一意に発見。既存sessionを再生成しない              |
| 稼働中crash                      | 旧sessionはinterrupted、新activationでのみ再開。source/clock検証を省略しない |

取消は未commitなら実行を中止しrollback、commit成功が判明した後ならreceiptを維持する。待機timeoutはworker/SQLite I/O終了を意味しない。SQL failureの原エラーをcancelに上書きしない。FULL/cleanup失敗のhost poisonと再openは[既存復旧契約](historian-write-failure-recovery.md)に従う。

停止区間は管理状態の遷移と実session境界として記録するが、clock domainを跨ぐ時間をsamplingMissedへ変換しない。既存evidenceで証明できない区間はHistoryのunknownCoverageを維持する。apply時刻や新旧sessionの壁時計差だけでunrecorded/欠測区間を捏造しない。P5の休止説明はまず管理診断で提供し、coverageへ投影できる証拠の拡張は別工程とする。

## 有限予算と状態公開

H5b管理operationはQueryControlの元deadline/cancellationを維持し、SQL statement/VM/decoded rows/bytesを課金する。一回のapplyは最大8member、要求/receipt各128KiB、decoded rows最大256、入力/出力合計は既存8MiB hard上限内。初期のVM上限5M、deadline最大10秒を共有し、低予算なら部分適用せず全要求error。これらはI/Oのhard停止や処理容量保証ではない。

初期台帳の件数上限はdesired定義版、mapping版、application、activationそれぞれ4096件とする。各上限はtransaction内の永続counterで確認し、上限に達しても既存receipt再送・状態読取・停止/joinを拒否しない。新application/activationだけをCapacityLimit相当で拒否し、supervisorは停止前preflightでも確認する。恒久運転に必要なGC/容量設定は後続であり、初期libraryの有限な受入範囲を明示する。

台帳全履歴を毎回走査しない。head/直近application、requestId、immutable desired key、mapping revision、series/segment予約を索引で読めるようにする。過去receipt/definitionのGCは初回に入れず、容量無制限が安全だと主張しない。上限不足では新applyを明示拒否し、古いreceiptを捨てて再送を新要求に戻さない。

sourceのcatalog/valuesは既存上限4096、bindings最大8。SDK/stop/joinの待ち時間は任意の最大10秒成功を保証せず、callerがjoin待ちを取り消しても処理枠を保持する。新しい管理要求はBusy、無制限queueは作らない。

公開状態はdesired reference、recording applied revision/hash、実session/activation、設定適用状態、稼働状態、保持の阻害状態、安全なエラー分類を別々に持つ。raw接続errorやcredential/pathをwatch/UIへ出さない。操作監査の主体/権限は将来SCADA serverが供給する。今回のlibrary入力は認証済み主体の証明ではなく、署名/approval tokenを発明しない。

## 実装PR順と受入

| 工程                     | 完了範囲                                                                                       | 主な受入                                                                                                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 今回design-only          | この具体契約・決定点・工程                                                                     | P5と現行APIの保証差を明示                                                                                                                                                                     |
| H5a（ローカル受入済み）  | 独立desired JSONのSchema、Rust/TS validator、共通fixture、browser module評価                   | 1/8 members、100ms/1h、同名別member拒否、disabledでも設定保持、Unicode/ID/64KiB境界、秘密field拒否、Project未変更                                                                             |
| H5b1（ローカル受入済み） | format6管理台帳、明示mapping登録、CAS、stable receipt、復旧照会                                | 同ID同内容再送/別内容Conflict、別Project競合、immutable版、保持CAS、全8member原子性、未記録予約がqueryへ漏れない、FULL/process crash/commit後応答喪失。必要ならb1台帳/b2session bindingへ分割 |
| H5b2（ローカル受入済み） | activation／timed sessionの原子binding、ID別／latest照会                                       | native20、CAS／再送／restart、新epoch、8member、永久metadata欠落拒否、FULL＋取消・process exit                                                                                                |
| H5c                      | 単一group supervisor、stop/join/apply、明示activation、activation/session原子binding、起動復旧 | 旧停止後apply失敗、新適用後source失敗、取消join所有、latch保持、active保持jobでBusy、mockHub→SQLite、仮想absolute周期既存受入、再起動新session/epoch、同名再作成拒否                          |
| H5d                      | Project desired保存/編集と管理状態表示、明示apply操作                                          | 別途Project versionを更新、保存で運転不変、desiredとappliedとRunningの差を表示、UI closeでrecorder継続、権限/製品transportは再開条件を満たすまでlocal injectionのみ                           |

H5aだけで記録計画の配布・実接続・原子適用が完成したとはしない。H5bの成功receiptとH5cの稼働確認を分けることで、再送や障害時に「保存された」と「記録している」を取り違えない。複数group、正式deployment設定、暦日保持、自動容量管理、認証/transport、実運用接続は後続である。

## H5cの詳細分割

[H5c2採用設計](historian-recording-supervisor.md)で、c2a（既存HistoryReaderによる停止前mapping/apply preflight）、c2b（正常pause後の明示管理turn）、c2c（単一supervisorとfresh解決・明示resume）へ分けた。c2aはH5b2から独立実装し、[H5c1の専用Recorder／Host開始](https://github.com/tyaro/temp-scada/pull/47)と別PRで受け入れる。保存済みmappingに対するapply検査とmapping候補検査は別操作で、架空revisionや複合原子適用を作らない。

## H5aの実装と受入（2026-11-03）

共通Schema、`scada_model::recording_plan::{DesiredRecordingPlan, validate_recording_plan}`、TSの`parseRecordingPlan`／`validateRecordingPlan`を追加した。SchemaはH1のID resourceをローカル登録し、外部取得を禁止する。未知fieldはroot／group／memberの全階層で拒否する。owned wrapperはmember順序と文字列を保持し、TSは全体をfreezeする。名前の重複は完全一致だけで検査し、trim・case変換・Unicode正規化は行わない。

共通fixture `examples/recording-plan-cases.json`139件で、1／8memberと上下限、disabledの完全形、別pool ID、同名・同member ID拒否、Unicode codepoint／明示空白集合、孤立surrogate、MAX_SAFE整数／指数表記、未知・秘密field、過大入力をRust／TS／browserで照合する。合法な最大8member文書は64KiBに達しないため、byte上限ぴったりの検証は共通walkerのunitで行い、fixtureでは大きな不正入力の最終拒否を確認する。wireの空白・escape・数値表記の入力byte数は測らない。

nativeの`json_contract.rs`へ既存Trendと共通のcompact JSON byte／node／depth walkerとblank判定を分離した。TSは既存`ownHistoryJson`へ省略可能なnode上限を追加し、H5aでは4096を所有コピー開始時から適用する。既存History／Trendは既定250,000を維持し、文字列のscalar／blank判定は`json-text.ts`で共用する。既存Trend fixtureとbyte正規化の受入を維持した。

構造受理はHub参照・タグidentityの解決、配布済み版の不変性、記録設定の適用成功の証明ではない。Project schema／editor／main・記録Host・DB format 5・H1・SDK／Banto・依存versionは変更していない。次はH5bの永続台帳と適用／再送・復旧照会へ進む。

受入結果: Rust workspace全393件（新規4関数）、TS全1,778件（新規155、121 files）、check 0error／0warning、build、Clippy／rustfmt、全体Prettierが成功した。関連Chromium31件（新規2）が成功し、共通fixtureの一致、remote schema取得なし、member所有とdisabled保持、通常AppのProject書出し不変・未知Project field拒否を確認した。Astraのread-onlyレビューに必須修正はない。全体CIは同PRの最新commitで確認する。

## H5b1の実装と受入（2026-11-03）

[永続台帳の詳細設計](historian-recording-plan-ledger.md)に従い、`SqliteStore`へmapping登録、desired apply、現在状態とrequest別receiptの照会を追加した。現在mapping／applied／保持版のCAS、immutableなdesired版、canonical本文とSHA-256による再送比較を行い、計画・系列予約・適用receipt・head・commit番号を一つのtransactionへ確定する。予約は検索用series／segmentsへ出さず、未記録系列はunknownSeriesを維持する。

DB formatを6へ進め、5と未知版は自動移行せず拒否する。`scada-model`へのpath依存と`sha2 = "=0.10.9"`を追加した。管理台帳は各4096版、member最大8、要求／保存本文各128KiB、decoded rows最大256、元のQueryControlと既存8MiB上限を共有する。検証負荷が上限を超える場合は全操作をerrorで戻す。

一度applyしたstoreではdisabledでもmanagedとなる。過去のsession／tick再送を維持し、新規の手動／時刻付きsession開始は共通入口で拒否する。保存commitはSDK起動やRunningを意味しない。次はH5b2でactivationとsessionの原子bindingを設計・実装し、H5cで停止前preflight、stop／joinと明示activate、再起動復元を接続する。Project編集／保存はH5dへ分ける。

## H5b2の実装と受入（2026-11-03）

[activation詳細](historian-recording-activation.md)に従い、現在appliedとmapping／保持版を照合する専用開始入口を追加した。固定sessionとtimed evidence、開始receiptは同一transactionへ確定する。mutableなsession statusをreceiptと分け、再起動後もlatestを取得できる。旧要求の再送は元結果の照会であり、終了／中断sessionを再開しない。

DB7へ進め、旧6も自動移行しない。既存manual beginのmanaged gateは維持する。nativeの`activation_supported=true`はbinding対応を示し、SDK/workerのRunningや製品接続を保証しない。次はH5cで、実clock取得時に専用開始を行うrecorder戦略と、停止前preflight／stop／join／fresh SDK pinを含むownerへ接続する。
