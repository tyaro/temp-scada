# Historian H5d: Projectの記録希望設定と管理workspace

状態: 採用設計（Astra主設計）。2026-11-03（日本時間）。設計PR #52はworkへ統合済み。H5d1のProject0.37.0保存契約を実装した。以下の編集UI・in-process管理serviceは未実装。

[H5記録計画](historian-recording-plan.md)、[独立desired契約](../../../crates/scada-model/schema/recording-plan.schema.json)、[supervisor](historian-recording-supervisor.md)を基準とする。H5cのnative/runtimeと、これから作るbrowserへの境界を区別する。DB7/H1/固定SDK/Banto/依存を維持し、実Hub/S7/本番DB/上流/認証/製品transportへ接続しない。

## 実装PRの順序

| 段階                 | 実装するもの                                                                | 完了の意味                                                                       |
| -------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| H5d1（保存実装済み） | Project 0.37.0へoptional単一recordingPlan、TS/Rust/schema/サンプル/共通受入 | desiredを保存・読込・書出しできる。編集UI/適用はまだ無い                         |
| H5d2                 | 通常Appの希望設定編集Modal、原子的editor command、Undo/Redo                 | 保存する設定を明示編集できる。運転は変えない                                     |
| H5d3                 | 新しい管理表示DTO/optional service/有限controllerと通常Appの診断表示        | injected serviceの観測状態をdesiredと比較できる。操作はしない                    |
| H5d4                 | 既存mappingを用いた明示preflight/pause/join/applyと操作結果表示             | serviceが提供する限定操作を明示実行できる。新mapping自動解決や自動resumeはしない |

d3前にDTO/ownershipだけの詳細契約PRを切ってよい。表のservice概形は採用する責務と上限を定めるものであり、nativeのSerialize型をそのままbrowser公開した既存契約ではない。各段階をReady for Reviewで受け入れてから次へ進む。

## H5d1: 保存契約

Projectへ次のfieldを追加する。

```ts
interface Project {
  manifest: {
    product: "banto-scada";
    schemaVersion: "0.37.0";
    minRuntimeVersion: "0.37.0";
    projectId: string;
    projectRevision: number;
    name: string;
  };
  // screens/symbols/assets等の既存fieldを維持
  recordingPlan?: DesiredRecordingPlan;
}
```

- field省略: このProjectに記録希望設定が無い。deploymentの停止/解除/削除指示ではない。
- null: 不許可。空object/空membersも不許可。
- enabled=false: H5aの完全な1..8member設定を保った無効希望。Project保存だけでは停止しない。明示applyで停止設定になる。
- enabled=true: 記録を希望する設定。保存だけでは適用済み/稼働中にならない。

初回は単一optional field。複数plan配列、複数group、配列のうちどれを適用するかという選択モデルを入れない。H5a version1/kind recordingPlan/planId/revision/enabled/groupの全shapeをそのまま保存する。period100..3,600,000ms、members1..8、memberId/externalName完全一致重複拒否、外部名512 Unicode scalar、blank規則、safe整数版、未知field拒否を維持する。

Project schemaはcanonical recording-plan schemaを外部resourceとしてローカル登録して参照し、H1 ID resourceも既存どおり登録する。ネットワークschema解決を行わない。TSはparse/validateRecordingPlan、Rustはrecording_planの既存validatorをProject semantic validationから呼ぶ。独立64KiB/depth32/node4096予算も保存部分へ適用する。Project全体の既存予算をこの64KiBへ置き換えない。現行TS/RustのProject text normalizationはscreens/symbols内のtext shape本文だけを対象としている。この範囲を維持し、recordingPlanのexternalNameやIDへ改行変換・trim・Unicode正規化を適用しない。

planId/groupId/memberIdはH5aの各poolであり、Project object/assetのglobal UUID poolへ追加しない。Hub参照は論理hubRefだけ。seriesId/hubInstanceId/incarnation/segment、endpoint/credentials、SDK pin、mapping/applied revision、receipt、operation状態、取得時刻はProjectへ保存しない。Trend namespace/series参照とdesired memberIdを自動対応させない。

### 変更対象と互換性

d1はProject現行versionのTS型・parser/serializer/newProject、native version/schema registration/semantic validator、project.schema.json、currentサンプル/fixture/test/browser期待値、保存/読込/ネイティブ往復を揃える。current0.36.0の入力は拒否し、自動migrationは追加しない。現存する0.1.0 legacy入口は対応範囲を拡張せず維持し、その変換出力のmanifest.schemaVersion/minRuntimeVersionを0.37.0へ更新する。変換後recordingPlanは省略する。0.36をlegacy扱いで受け入れない。

field無しの新規Projectは省略状態で作り、読み込んだ無しfieldを無効planへ勝手に変換しない。serializeProject経由のwhole Project保存/読込ではdesiredを丸ごと保持する。画面/shape/Symbolコピー、画像/部分clipboardへProject全体設定を同伴させない。ProjectのSave As/複製は保存内容としてplanIdを保持するが、それが別deploymentで同identityを証明するとは扱わない。別計画として使う場合のplanId変更は明示編集する。

d1は通常UI、render/Trend shape、recorder/Hostの寿命を変更しない。Project validatorの受理はHub参照解決、desired版の配布先での不変性、権限を保証しない。

### d1受入

省略/有効/無効の往復、null拒否、全8member/Unicode/整数/64KiB境界、秘密fieldとidentity混入拒否、member順の保持、0.36拒否/0.37受理をRust/TS共通fixtureで確認する。通常Appの保存/再読込でfieldが保持され、無いProjectの正常操作が維持されることをbrowserで確認する。native/wireのbyte表現差はH5aのstructured値canonical整数予算に従う。

## H5d2: 編集と版

通常AppのProject管理に「記録希望設定」を置き、Banto Modalを用いる。対象はplanId/revision/enabled/groupId/hubRef/periodMs/memberId/externalName/valueType。最大8memberの行追加/削除/順序編集と、設定全体の作成/編集/Projectから除去を提供する。Catalogを自動fetchせず、手入力は論理参照の編集として扱う。real series IDを生成しない。

編集draftはownedでProject本体を直接mutateしない。明示保存時にH5aを検証し、save-recording-plan commandで一括反映する。remove-recording-planも一つのcommand。Undo/Redoでfield全体を当時の状態へ戻し、Project revisionは既存editor規則に従う。削除UIには「Projectから希望設定を除去する。稼働中の記録は停止しない」と示す。追加人手approvalや署名tokenを作らない。

### desired revisionとUndo

Project revision、desired revision、recording applied revision、保持policy revisionは別物。初期desired revisionは1。内容を変更する通常編集では、同planIdの現在desired版より大きいsafe整数を明示保存する。次版候補は現在版+1として提示できるが、配布先で予約した番号とは呼ばない。MAX_SAFEでは同planIdの新しい版を発行できず、黙ってwrap/clampしない。別planIdへの変更は明示的な別計画として扱う。

順序も含め同じ本文の保存はno-opとして版を維持し、版だけを明示更新した場合はdesired変更として保存できる。memberの並べ替えだけはcanonical上の意味変更ではないため同desired revisionのまま保存できるが、表示順を保存するProject commandとしてUndo/Redo対象にする。新revisionを必須とする本文変更判定はmemberId順canonical比較を使う。同planId/同revisionのまま本文だけを変更する通常編集は拒否する。draft中の入力取消で版を消費したとは扱わない。

Undo/Redoは当時のplanId/revision/本文を丸ごと復元し、再採番しない。Undo後の分岐編集、古いファイルの再読込、別Projectの同planIdは、以前配布した同版別内容と衝突し得る。ローカル編集だけで全deploymentの採番を保証できない。native immutable判定が最終権威で、Conflict時に自動版上げ/新requestId再送で回避しない。利用者が新desired revisionまたは別planIdへ明示修正して再操作する。

Modal ownerはProject object/generationを保持する。Project置換時はdraftと送信資格を破棄し、同Project ID/revisionでも別objectへ古いdraftを保存しない。既存dirty Escape/shortcut遮断/focus復帰を共有する。管理serviceの状態変化だけでProjectのdesiredやrevisionを自動変更しない。

## H5d3: 管理表示の新しい境界

optional injected RecordingManagementServiceをAppへ渡す。通常起動はundefinedであり、「管理サービス未接続」「このProjectに希望設定なし」「設定あり・適用状態未取得」を区別する。ダミーのapplied/Running、外部名から作ったseries対応、サンプルdeploymentを通常Appへ追加しない。

```ts
interface RecordingManagementService {
  readonly context: unknown; // 版付きのbounded contextを検証
  inspect(request: InspectionRequest, signal: AbortSignal): Promise<unknown>;
  // d4で明示操作capabilityを追加
}
```

d3の新JSON契約は少なくともcontext version、contextId、Project id/revisionへの対象宣言、deploymentId/storeIdのcaller宣言、観測時のsnapshot commit、desired/applied比較用の適用済みdesired全文とapplied revision、activation/session状態、稼働観測、保持/回復blocker、安全なerror分類を持つ。store/deployment/contextは役割を分離し、認証済identityとは称さない。Project object/generation/service identityによるUI owner確認も別に行う。

表示は以下を独立させる。

| 表示           | 根拠と限界                                                                         |
| -------------- | ---------------------------------------------------------------------------------- |
| 希望設定       | 現ProjectのrecordingPlan。保存済みでも未適用あり                                   |
| 設定比較       | 同planId/revisionかだけでなくcanonical本文を比較。なし/一致/差異/比較不能を区別    |
| 適用済み設定   | 管理viewの現在applied。古いrequest receiptと混同しない                             |
| 開始受付       | service/Hostが要求を受理した。Runningとは別                                        |
| activation保存 | timed session開始commit。SDK Live/初回tickは未保証                                 |
| 稼働           | serviceが観測したHost phaseと元run。DBのactive sessionだけからRunningを推測しない  |
| 保持・復旧     | active job、rearm/plan recovery、source/cleanup障害等。inspection成功でclearしない |

DB viewとHost stateは別時点の観測であり、一つのDB snapshotで両方が原子的に取得されたとは表示しない。Host RunningはRecorderのphaseであってSDK Live/Goodではない。SDK接続状態を表示する場合は独立した観測fieldとし、現adapterが提供しなければunknown/未提供と表示する。Runningや最新tickだけからLiveを推論しない。

desired canonical比較はH5bのmemberId順・object key順・安全整数正規化に合わせ、文字列をtrim/Unicode normalizeしない。順序保存は保持するがmember表示順だけの差を稼働意味の変更としない。browser独自hashを権威にせず、必要なら新DTOのschema/共通fixtureで比較規則を固定する。

1context最大単一plan/単一group、1..8member、単一最新activation/session、各種最新receipt最大1、blocker有限enumを基本とする。context128KiB、response1MiB、depth32/node16384等の新境界をd3詳細契約で確定し、native viewの全過去情報やraw errorsを無制限に公開しない。field数/文字列長/enum/未知fieldをstrict検証する。getter/非JSON/unsafe整数/lone surrogateを拒否し、owned/frozen結果を使う。

App内のcontrollerはworkspace開閉で再作成しない。readはactive1+pending latest1、Abortは要求のみ。sourceがAbortを無視しても古いPromiseがcleanup後settleするまで次を発行しない。Project置換/service変更/closeでは論理tokenをretireして古い表示を即時隠すが、物理枠は保持する。待機をtimeoutで完了扱いにしない。新ownerのreadも旧物理read終了まで待つ。

UI closeはread購読/表示寿命だけを終え、RecordingHost/source/writerをshutdownしない。service context変更で旧結果を新Projectへ投影しない。requestIdと要求contextをexact照合し、stale/invalid/unavailable/errorを正常データへ変換しない。自動pollは初回不要、明示更新で取得する。

## H5d4: 明示操作と継続するowner

初回は**登録済みmappingを使うdesired apply**を対象とする。新mapping生成/自動登録、identity発行、fresh SDK解決や自動resumeは提供しない。 対象は既存RecordingRunの設定変更であり、preflight時点はRunningまたは正常Joined、apply時点はその元runを正常join済みであることを要求する。initialIdleや新規storeの初回applyはd4初回capabilityに含めない。現c2b/c2c1のclean pause gateをadapterが直接store操作で迂回してbootstrapを実装しない。初期設定は現nativeのHost構築前手順に留め、browserからのbootstrapは別capabilityと詳細契約・受入を後続で追加する。serviceのcapabilityが無ければ操作を非提供と表示し、ボタンを有効にして架空成功を返さない。通常Appは未接続のまま、受入はin-process injectionだけで行う。

新操作境界はd3 read契約から分離し、UIが行うのは同一desired/期待版/元runに束縛したpreflight、明示pause/join、同一候補apply。 これらを一回のexecuteで自動連続実行しない。利用者がpreflightを要求し、Candidateを確認して別の明示pause操作を行い、正常joinの完了後にさらに別の明示apply操作で同候補を実行する。pause操作は停止要求とjoin完了待ちまでを担当できるが、join成功からapplyへ自動遷移しない。Replay/errorには候補pause/apply操作を提供しない。安全停止用の独立操作が将来ある場合も、候補applyの資格とは区別する。c2c1のcandidate/token消費をadapterが保持し、ブラウザの文字列tokenを署名認可やDB予約と称さない。Replay/拒否では旧workerを停止しない。enabled=falseも設定applyであり、UI上の一時pauseと区別する。

serviceの操作ownerはModalやProject objectから独立させる。操作開始前にoperationId、対象context、元Project id/revisionとgenerationの表示用binding、desired全文、期待版、native requestIdをowned保存する。受理後はそれを変更せず、同じoperationの再照会へ同じIDを用いる。Project保存/閉じる/別Project読込で別内容へ差し替えない。

in-processのAPI概形は `execute(request): OperationHandle` とし、handleはoperationId、completion Promise、安全な取消要求methodを持つ。serviceはdispatch前にoperationを登録する。同期throwを「未dispatchの明確な拒否」に限定し、dispatch後の通信/応答喪失はcompletionでOutcomeUnknownとして返す。native stable receipt/state照会を行うadapter責務を明示し、結果不明を未適用/失敗確定へ変換しない。具体schema/型はd4前の契約PRで固定する。

操作はactive1、pending mutation queue無し。実行中に別操作を自動予約せずBusy。取消は既存cooperative requestであり、応答/cleanup前に物理枠を解放しない。成功commit後latecancelは成功receiptを維持する。UI close/Project/service切替だけではmutationをcancelしない。利用者の明示取消だけを元operation ownerへ送る。

serviceの差替え時も旧ownerのoperationを捨てない。Appのbounded操作monitorが旧handleを保持し、旧context名とoperationIdで結果を表示する。新Projectの現在applied状態へは流用しない。前の物理操作が完了するまで新ownerへのmutationも受理しない。App全体のunmount時はserviceがownerを保持する責任があり、単にPromiseを放置すればnative処理が継続するという保証はしない。

### 操作結果の表示

- 同期拒否: dispatch無し、旧録画/設定は変わらない。入力/owner/Busy理由を表示する。
- preflight Replay: 元receiptの照会。現在設定/稼働中との同一視や自動stopをしない。
- pause/join完了: 正常cleanupの確認。一時停止でありdisabled applyではない。
- apply成功: 設定commit済み。再開は別操作/後続capability。Runningに自動遷移させない。
- apply error: safe errorとrecovery requiredを表示。自動再試行/版上げ/自動rearmしない。
- 結果不明: request/operationIdを保持し元ownerへ照会する。新IDで同操作をやり直さない。
- mapping成功後apply失敗: service由来の途中成功receiptがある場合、mapping成功とapply未成功を別々に表示する。旧appliedは残ってもcurrent mappingが進んだため再開がblockedになり得る。UI初回にmapping操作を提供しなくてもこの診断を隠さない。

bounded monitorはmapping/applyの各最新成功receiptと現在operation結果を分けて保持する。次の失敗で前段成功を消さない。古いreceiptのrevisionが現在headより小さい場合も、元成功を現在appliedへ上書きしない。

## 各段階のUI受入と制約

- d2: 通常Appで作成/編集/無効化/除去、Undo/Redo/分岐編集/旧ファイル読込、最大版/8member、dirty Escape、Project owner置換、両theme。保存/閉じる操作からservice mutationを一度も呼ばない。
- d3: undefined service、希望無し、適用差異、disabled、同ID版本文不一致、active DBだがHost不明、source/retention/plan blockerを表示。invalid responseとstale context、Abort無視/close-reopen/service交換でもphysical active1。
- d4: Replay/errorでnoStop、明示pause/join/apply、元candidate差替え拒否、成功とRunningの区別、応答喪失/latecancel、partial success、close/Project変更後も元operationの結果を回収。通常entryは接続しない。
- 共通: Projectにはdesiredだけを保存し、管理view/接続/receiptを混入させない。通常Appでhardcoded demo mappingや偽Runningを作らず、fixture注入と実サービス接続を区別する。

H5dの段階完了は製品transport/authの再開条件を満たしたという意味ではない。SDKのfreshnessやHub/incarnation同一性は既存caller/deployment責任を維持し、UI編集だけでそれらを発行しない。

## H5d1の実装と受入（2026-11-03）

Projectのoptional単一`recordingPlan`とH5a/H1のローカルschema登録、既存の意味・文字列・64KiB/node/depth検査をTS/nativeへ導入した。新規Projectは省略、0.1.0 legacy変換の出力版は0.37.0とし、0.36.0は拒否する。whole Project JSONと画像同梱packageへ保持し、部分clipboardには同伴させない。外部名のCR/LF・Unicode区切り・前後空白を正規化せず、member順とdesired revisionを保つ。

独立H5aの139ケースをProject内へ包み、追加のProject共通16ケースで省略/null/有効/無効・旧版・別ID pool・秘密field・legacy・64KiBを超える図面を検証する。画像同梱サンプルはmanifest版と対応checksumを更新し、Project内容と画像原本bytesを維持した。d2以降のUI・管理serviceやrecorderの動作は追加していない。

Rust workspace531件（新規2）、TS1,934件（新規156）、関連Chromium25件（新規3）、型検査0error／0warning・build・Clippy／rustfmtが成功した。Astraの最終実装レビューに重大な指摘はない。全体Prettier・文書リンクを確認し、Ready for Review PRの全体CIを確認する。
