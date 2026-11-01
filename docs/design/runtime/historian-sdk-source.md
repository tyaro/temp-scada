# Historian H3b: 専用SDK所有者から周期recorderへのsnapshot adapter

2026-11-01。状態: **Astra 主設計、ローカル実装・受入済み。全体CIはPRで確認する**。[H3a周期recorder](historian-periodic-recorder.md)、[P5の記録保証とidentity](historian-trend-contract.md)を前提にする。

## 最小実装の範囲

UIのReadHostとは別に固定banto-tagclientのTagClientHandleを所有し、その最新状態をH3aのSnapshotSourceへ投影する。ローカルmock Hub→固定SDK→専用adapter→周期recorder→隔離SQLiteという経路を実装・検証する。実Hub、S7、通常App、設定／資格情報の読取りは行わない。製品認証／transport、計画配布、複数Hubの同時tick、source変更時の自動segment生成は後続である。

adapterはscada-runtimeに置き、scada-runtimeからscada-historianへの依存を追加する。SDK非依存のHistorian保存／recorderコアは維持する。SDKの接続・再接続・Stale判定・プロトコルをコピーせず、既存workspaceの固定banto-tagclient／tokioを使う。DB format 5、H1、Project、Bantoを変更しない。

## 出典と採用判断

固定上流revは `33410f6d25d36559c5ce81375e243eb6f3e85038`。

- [SDK handle.rs](https://github.com/tyaro/banto-industrial/blob/33410f6d25d36559c5ce81375e243eb6f3e85038/crates/banto-tagclient/src/handle.rs)は非Cloneの所有者、stateのclone、bounded-latest watch、async shutdown／join、Dropのbest-effort abortを提供する。spawn直後の初期stateはStoppedである。
- [SDK types.rs](https://github.com/tyaro/banto-industrial/blob/33410f6d25d36559c5ce81375e243eb6f3e85038/crates/banto-tagclient/src/types.rs)のGenerationSnapshotはcatalog／resolution／valuesを同一世代で所有する。bindingはpublic APIだが、各集合を線形走査する。SDK generationはprocess内の世代番号で、永続系列identityではない。ValueSourceは各valueが権威を持つ。
- [runtime projection](../../../crates/scada-runtime/src/projection.rs)と[ReadHost](../../../crates/scada-runtime/src/host.rs)は表示投影／UI寿命の所有者である。Quality／source／sourceEpochを欠測理由まで保つHistorian入力として表示DTOを流用しない。

今回は別pumpや投影watch cacheを増やさず、captureでhandle.state()を一回cloneする。これによりSDKが切断を公開した後も古い投影cacheだけをGoodとして採り続ける遅延経路を作らない。SDK自身はlatest方式であり、瞬間的な途中状態やPLC全変化のlossless取得を保証しない。

## 固定planとAPI

型と公開入口は`scada_runtime::recorder_source`に置く。

```rust
struct SdkGenerationPin {
    catalog_revision: u64,
    run_id: Option<u64>,
    collection_mode: CollectionMode,
}
struct SdkBindingPin {
    series_id: String,
    stable_id: StableTagId,
    tag_key: String,
    data_type: String,
}
```

SdkRecorderPlan::newはSessionSpec、catalog pin、binding pinsを受ける。session参照を公開し、callerが同じspecでH3aを開始できるようにする。SdkRecorderSource::startはRestClientと検証済みplanを受け、専用TagClientHandleを開始する。SourceはSnapshotSourceを実装し、async shutdownを提供する。外部から任意SDK状態を注入する製品入口は設けない。

plan検証は既存のSessionSpec内部検証を再利用する読み取り専用の公開`SessionSpec::validate(&self)`を追加して利用し、member1..8、一意series／外部名、単一hub_instance_id、同一Historian周期、一対一pin coverageを要求する。SDK binding_keyはseries_idから構成し、外部名を要求する。未知collection mode、未知datatype、pinとdescriptorのbool／number不一致、空または過大なpin文字列を拒否する。tag_keyは初期最大1024 bytes、datatypeは対応する既知の短い列挙値に限定できる。

StableTagIdとtag_keyは選択時catalogの値をcallerが明示する。hubInstanceId／incarnationIdはcallerの固定identityであり、SDKからその全世界的な一意性や継続性を証明できたとはしない。seriesを外部名だけで自動採番しない。同名再作成や別Hubを自動で旧系列へ継続させない。

catalog period_msはHub側収集周期であり、Historianの記録周期と同値である必要はない。unitはdescriptorと一致させる。数値型はi16/u16/i32/u32/i64/u64/f32/f64、boolはbitを対象とし、選択時datatype文字列そのものをpinする。

## 一回のcapture

1. sourceがStoppedまたはsticky FailedならSourceError。Runningならhandle.state()を一回cloneし、watch guardをすぐ解放する。
2. connection状態を判定する。非Liveの古い値を使用しない。catalogが公開されるLive／Unboundでは以下の世代検査を行う。
3. catalog.tagsとvalues.valuesは各4096以下、resolution全件は8以下を要求する。上限超過はwholegroup terminal error。bindingの線形走査もこの上限内に閉じる。件数上限はSDKネットワーク受信前のメモリ上限ではない。
4. 同じGenerationSnapshotのcatalog revision／run_id／collection modeがplan pinと一致すること、valuesがある場合はそれらがcatalogと整合することを確認する。要求bindingが同じ外部名へ解決されていることを確認する。
5. 各memberのresolved bindingについてstable IDs／tag_key／datatype／unitと有効状態を確認し、同じsnapshotのvalueを投影する。全member分の結果を構築してから一括返却する。途中memberだけをDBへ渡さない。

一度取得したsnapshotの参照だけを使い、途中でhandle.state()を取り直して別generationのcatalogと値を組み合わせない。SDK公開GenerationSnapshotの不変条件を尊重し、SDK内部データ構造や接続アルゴリズムを複製しない。

captureは同期latestコピー／投影だけであり、ネットワークfetch、await、SQLite書込み、時刻sleepを行わない。sampleTimeはH3aがcapture直後の実時計から設定する。SDKのsource timestampをsampleTimeへ代入しない。

## 再接続とidentity境界

catalog revision、run_id、collection modeの変更、stable IDs／tag_key／datatype／unitの不一致はwholegroupのsticky SourceErrorとする。後で元に戻っても同じsourceでは再開しない。callerが新しいplan／session／sourceを明示して再確認する。

初期実装は無関係なcatalog変更でもrevision差で停止する。この保守的な制限を、metadataを読み替えて継続したことにしない。将来の安全な部分変更判定とsegment切替は別工程である。

run_id=Someで同run／revision／collection mode／pinsが保たれる再接続ではSDK generationの増加を許し、その新番号をSourceEpochへ記録する。run_id=Noneも初回は扱えるが、generationが変わった場合は再起動等の継続性根拠が足りないため停止する。generationの減少や不整合も停止する。generationは+1を要求せず、増加の飛びを許す。

単純な一時切断やSDKバックオフはsourceUnavailableの無値を周期保存し、正常復帰後にidentity gateを通った値を再び採れる。unresolvedはunresolved無値として記録する。既に解決済みの名前が消失しても最新catalogのrevision変更は先にidentity gateで停止するため、別identityへ自動再解決しない。

## connection状態

| SDK／owner状態                                   | 採用動作                                                                                      |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Connecting／Handshaking／Rebinding／Reconnecting | 全member sourceUnavailable無値。SDKの接続／再試行を独自に置き換えない                         |
| Live                                             | 世代とpin検査後に値を投影。個別unresolvedは無値                                               |
| Unbound                                          | 世代と要求対応を検査し、unresolved無値。正常な未解決状態をtransport失敗と呼ばない             |
| Unauthorized                                     | terminal SourceError。資格情報の自動変更や秘匿値のログ出力なし                                |
| Stopped                                          | 初期未起動状態のみsourceUnavailable。last_errorあり、または一度初期状態を離れた後ならterminal |
| 明示shutdown／sticky Failed                      | captureはterminal。以前のsnapshotを返さない                                                   |

SDK初期Stoppedとworker終了を判別できる情報には限界がある。初期Stoppedを即fatalにして最初のtickを常に停止させない。接続経過を観測する前に発生・消失した途中状態はlatest方式では検出できない。

## 値、無値、provenance

SourceUnavailable／Unresolved無値はquality、source、value、sourceTime、sourceEpochをNoneにし、対応reasonだけを持つ。disabled tagは有効状態の変更としてidentity gateでwholegroup terminalにし、sourceUnavailableへ隠さない。存在するcatalogのsourceラベルからvalueのsourceを補完しない。

実valueを使う場合のsourceはvalue.value_sourceだけから対応enumへ写す。固定descriptor.sourceと違えば無値で隠さずwholegroup停止する。たとえばReal seriesで途中からSIMになった場合、RealのままSIM値を保存せず、SimulationExcludedを別sourceのdescriptorへ不正に付けない。

固定SDKの[stream_core.rs](https://github.com/tyaro/banto-industrial/blob/33410f6d25d36559c5ce81375e243eb6f3e85038/crates/banto-tagclient/src/stream_core.rs)はREST baselineのsourceを保持してWS値を更新する。したがってadapterのsource gateが検出できるのは、公開ValueEntryに現れたsource変更だけである。WS上のsource変更がSDK公開状態へ反映されていなければ、このadapterがそれを独自に検出したとは主張しない。実接続受入では新しい接続世代のREST baselineをRealからSIMへ変更し、固定run／revisionでもsource差を検出して停止することを確認する。SDKを迂回したWS独自解析は追加しない。

sourceが一致した後の投影優先順を固定する。

1. Simulation／DerivedSimulation: value=None、SimulationExcluded。
2. Unknown source: value=None、UnknownSource。
3. Bad／Stale／未知Quality: value=None、Bad／Stale／UnknownQuality。
4. Goodの欠損／非有限／bitの0・1以外: value=None、MissingValue／NonFinite／TypeMismatch。
5. Goodの有限numberまたはbit0/1: numberまたはbool(false/true)、reason=None。

SIM／UnknownでもQualityは観測されたものを保持できる。sourceTimeはSDKが返したUTC msを保持し、safe整数範囲外ならterminal errorとして丸めない。明示value由来のsource／Qualityを持つ場合は、同snapshotからSourceEpoch `{hub_instance_id,run_id,catalog_revision,sdk_generation}`を生成する。u64カウンタをf64に変換しない。全memberのepochは同世代とする。

Good0とfalseを欠損扱いせず、SDKのBad／StaleをGoodへ補完しない。i64／u64等の数値がSDKのf64表現で既に失った精度をadapterが回復したとは主張しない。

## 非同期所有と終了

SDKの接続workerはtokio runtime上で動く。recorderの同期wait／SQLite処理を同じsingle-thread executorで回し、SDK workerを飢餓にしてはならない。hostはrecorderを専用threadまたはspawn_blockingへ置き、SDK runtimeを稼働させる。H3bは新しい製品hostや自動task supervisorを作らず、この呼出し責務を明記する。

async shutdownは最初のpollでhandleをtakeし、captureを停止状態にしてからhandle.shutdown().awaitする。await中の取消でもsourceが古いhandleへ戻らない。DropはSDKのbest-effort abortに委ね、正常join完了とは報告しない。shutdownの再呼出しでも、成功join済み・失敗・取消により未完了を区別する。handleをtake済みという理由だけで正常join済みのOkを返さない。sourceの停止とSDKエラーは静的な分類で返し、endpoint／API key／生エラー本文をrecordやログへ混入させない。

通常終了はrecorder受理停止・最後の同期write／cleanup完了、source shutdown／SDK join、hostのrecording thread join、writer解放の順で管理する。同時にcaptureとshutdownを呼ばないことは&mut所有で表現できる。別threadへ移す場合も所有者を一人にし、clone可能なUI subscriptionをrecorder ownerの代用にしない。

## 受入

- 隔離loopback mock Hubで固定SDKが接続し、専用sourceをH3aへ渡して実SQLiteへGood0／falseを保存する。raw／minmaxとSourceEpochを確認する。実HubやSDKソース変更は不要。
- UI ReadHostを別ownerで開始・停止しても、recorder sourceは生存し記録を継続する。逆のshutdownもUI ownerへ影響しない。
- 一回captureが同じgenerationのcatalog／valuesだけを使い、run／revision／modeの不整合やpin変更でwholegroup停止する。
- 切断中はsourceUnavailableの無値となり、古いGoodを再送しない。同run／revisionの正常再接続は新SDK generationを保存できる。runなしのgeneration変更は停止する。
- 全unresolved／部分unresolved、初期Stopped、Unauthorized、shutdown中／shutdown後のcaptureを区別する。
- SIM／DerivedSimulation／UnknownSourceは対応固定segmentの無値として保存し、Real→SIMの途中変更は停止する。Bad／Stale／未知Quality、欠損、bit不正値、unsafe sourceTimeを確認する。
- stable ID／tag_key／datatype／unit／catalog revision変更を一度検出すると、その後元の値に戻ってもsticky停止を維持する。
- catalog／values／resolution上限、group一意性、pin不足を検証する。例外／取消／dropで旧値を再公開しない。
- async shutdownでSDK workerをjoinし、loopback接続が終了する。終了futureの取消は正常停止と偽称しない。同期recorderはSDK executorを塞がない形で統合試験する。

H3aの1時間3600予定slot保証は本adapterでも維持するが、SDKはlatest sourceであり全Hub通知の記録保証には変わらない。製品計画の適用、複数Hub同期、identityの再承認／自動segment遷移、queueと容量運用、実環境接続は後続に残す。

## 実装・検証結果

`recorder_source.rs`が専用handle、sticky error、SDK世代の前進、shutdown結果を所有し、`plan.rs`が固定group／選択時pin、`projection.rs`が一世代の検査とH1 observationを担当する。Historianには既存検証を呼ぶ`SessionSpec::validate`だけを公開追加し、保存形式と周期計算を変更しない。workspace内の依存を一方向に追加し、外部依存・SDK revを維持する。

Rust workspace347件（新規8単体・9統合）・Clippy `-D warnings`／rustfmt・関連Chromium6件が成功。spawn_blockingを使ったmock Hub→SDK→H3a→実SQLiteからraw／minmaxまで、Good0／false、部分／全unresolved、Bad／Stale、切断、SIM／未知source、同run再接続、runなし再接続停止、catalog変更停止、UI所有寿命の双方向独立を確認した。exact tick再送が同じreceiptを返し、sourceEpochだけを変えるとConflictになることで内部epochの永続化も検証した。

Unauthorizedの終了失敗と、shutdown future取消後の未確認結果は再呼出しでも失敗を保つ。join成功後だけ再呼出しも成功となる。Dropでは接続abortを確認したが、正常joinとは扱わない。Astra最終レビューに必須修正はない。仮想1時間の3600slot／各系列3600保存試験も既存H3a回帰で成功しており、実S7の実測数・精度保証へ拡張しない。
