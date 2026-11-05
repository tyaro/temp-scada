# 記録wireのlocal表示と元call配送の境界

状態: **H5d4c4c-prep2dの採用詳細設計。prep2d1の純粋表示・元返信読取を実装済み、d2は後続**。2026-11-05（日本時間）。主設計はユーザー指定のAstra。

[prep2c receiver](historian-recording-wire-receiver.md)はPR84でworkへ統合済み（`cec4ab003aedcdc2c73e9001b27c89e6c022650a`）。本書はその次の独立したclient境界を定める。Project 0.37.0、DB7、H1、wire schema、SDK、Banto、依存版を変更しない。

## 1. 採用する区切り

**prep2d1: read-only表示projectionと保存済みAttach／Control terminalの取得** を実装した。pure TS receiverへ小さい取得APIを追加し、未知入力をもう一度信用する表示用receiverや第二のregistryは作らない。

その後の **prep2d2: 元call配送の独立台帳** は別PRの対象とする。lease／admit／受付照会／cancel／observationとCallInspectionの対応を保持し、正常元配送と状態表示を分ける。次実装にそれらを先取りしない。Promiseを持つportへの接続はさらに後のlocal-v2契約と製品host接続のgateを必要とする。

prep2d1は、通常App／既存coordinator／monitor／local portを改版・接続しない。network listener、transport、認証、実lease、native dispatch、Rust registryへの通信、実Hub／S7／本番DBを追加しない。pure receiverに渡したJSONは認可証拠ではなく、試験入力を実hostから取得済みの情報と称さない。

## 2. 現実装から分かる不足

根拠は以下の現行実装と採用設計である。

- [receiver](../../../apps/banto-scada/src/lib/recording-wire-receiver.ts)はopaque generation／control tokenを発行し、元ACK保存とsnapshot昇格を二段階で行う。
- [ReceiverState](../../../apps/banto-scada/src/lib/recording-wire-receiver/types.ts)のcurrent()はscope、表示snapshot、停止理由、pending件数を返すが、元ACK本文を返さない。d1では以下のtoken別getterを追加した。
- [local port](../../../apps/banto-scada/src/lib/recording-async/port.ts)は同realm test-only契約で、ownerEpoch、closed、ControlFrame、元call terminalが無い。
- [coordinator](../../../apps/banto-scada/src/lib/recording-async/coordinator.ts)はframeの結果知識と元Promiseの正常settleを別に保持する。frame先着で元call枠を解放しない。
- [monitor](../../../apps/banto-scada/src/lib/recording-async/monitor.ts)はProject／service／view所有を検査する。wire scopeをProject object identityへ自動変換する仕組みではない。
- [wire・host設計](historian-recording-wire-host.md)はCallInspectionによる元dispatcher terminalと、後から進むadmission knowledgeを明確に区別する。

従って `ReceiverState.latest as LocalOwnerFrame` や、frameをPromise.resolveで包む実装は採用しない。`terminalStored:true`、`duplicate`、pending件数0は本文を復元する方法ではない。正常terminalの取得には、そのcallに束縛された元本文そのものが必要である。

## 3. d1の所有と公開API

receiver factoryの引数・既存methodの意味・既定上限は変えない。次の三methodを `WireReceiver` へ追加した。別factory／別scope登録／public mutable Coreは追加しない。

```ts
type StoredTerminal<Q, R> = Readonly<
  { kind: "pending"; request: Q } | { kind: "terminal"; request: Q; reply: R }
>;

interface WireReceiver {
  // 既存methodは維持する。
  currentDisplay(): RecordingWireDisplay;
  attachTerminal(
    generation: AttachGeneration,
  ): ReceiverResult<
    StoredTerminal<RecordingWireAttachRequest, RecordingWireAttachReply>
  >;
  controlTerminal(
    call: ControlCall,
  ): ReceiverResult<
    StoredTerminal<RecordingWireControlRequest, RecordingWireControlReply>
  >;
}
```

`currentDisplay()` は最後にcommitされたReceiverStateから作った表示を返す。入力を受けず、呼出先callback／getterを実行しない。外部の型付きに見える任意ReceiverStateを信用する公開projection関数はd1に設けない。内部の純粋なprojection helperは利用してよい。

terminal取得は既存WeakMapでtokenのinstance帰属と種類を確認する。別receiverのtoken、似たplain object、wrong-kind tokenは `foreignToken`。JSON IDだけで元callを検索する公開APIは設けない。tokenは認証資格ではなく、同realmの当該receiverへの参照能力に限る。

取得は非破壊であり、pendingをterminalへ変更せず、取り出したことをACK済み・送信済み・消費済みとしない。retire／transport切断／receiver停止／dispose後も、正しい旧tokenについて正常保存済み本文と未回収pendingを取得できる。取得で新しいgenerationを作らない。

同期更新中のterminal取得は `busy`。token検査も含め更新途中のCoreを公開しない。`currentDisplay()` と既存current()だけは更新前のcommit済みcacheを返す。全てfinallyで既存busy guardを解除し、例外経路でもcache更新の順序を統一する。

## 4. 独立したlocal表示型

これはwire rootでも `LocalOwnerFrame` のv2でもなく、receiverのread-only表示型である。全fieldは必須、nullableは省略しない。

```ts
interface RecordingWireDisplay {
  readonly scope: RecordingWireScope;
  readonly transportConnected: boolean;
  readonly receiverStatus:
    "ready" | "awaitingAttach" | "resyncRequired" | "stopped";
  readonly receiverStoppedReason:
    "protocolViolation" | "invalidDocument" | "capacity" | "disposed" | null;
  readonly generation: ReceiverState["generation"];
  readonly ownerClosed: boolean;
  readonly nativeRecoveryRequired: boolean;
  readonly authorizationLost: boolean;
  readonly highwater: number | null;
  readonly snapshotRelation: "none" | "currentSubscription" | "lastKnown";
  readonly snapshot: RecordingWireOwnerSnapshot | null;
  readonly usage: ReceiverState["usage"];
}
```

`nativeRecoveryRequired` はReceiverState.ownerBlockedを名称付きで投影するだけである。wire上のownerBlockedを変更せず、operation／reconciliation結果から独自に再計算しない。閉鎖・切断・capacity・認可失効・unknownをここへORしない。receiverが既に保持するsticky flagsはそのまま保存する。

`snapshotRelation` は次の純粋規則とする。

1. latestがnullなら `none`。
2. latestが存在し、connected、status=ready、generation.phase=attached、ownerClosed=false、authorizationLost=falseなら `currentSubscription`。
3. その他でlatestが存在すれば `lastKnown`。

`currentSubscription` は「このreceiverで現在の購読表示として保持している」という意味だけであり、現実の時刻に対する鮮度、nativeの健康、SDK Live、Good、変更権限を証明しない。nativeRecoveryRequired=trueでも購読表示はcurrentSubscriptionになり得る。UIは「回復要求あり」を別軸で併記する。時刻由来のfreshness fieldや受信時刻を追加しない。

表示の参考表現は「未受信」「購読中の観測」「保持している以前の観測」「再同期が必要」「接続切断」「owner終了」「認可失効通知」「回復要求あり」とする。まだ画面や日本語formatterを実装しない。raw error.message、stack、host内部例外、資格情報を表示DTOへ追加しない。

例えばownerClosed controlの後には、snapshot.closed=falseの古い本文と上位ownerClosed=trueが共存する。snapshot本文をtrueへ書き換えず、snapshotRelation=lastKnownと上位sticky事実を併記する。authorizationLost等も同様に、snapshotの生成時点とは別の受信事実として保持する。

scope全体（context／ownerRef／ownerEpoch）は保持する。別epochを同じownerRefという理由で統合しない。authorizationLost=falseは権限があるという意味ではない。ownerClosed=falseもnative operationが稼働中という意味ではない。

## 5. 表示結果と操作許可を分離する

表示には canApply／canPause／canPreflight／canResume／canCancel／canReconcile を持たせない。receiverStatus=ready、snapshotRelation=currentSubscription、正常receipt、known acceptedのいずれからも送信資格を発行しない。

snapshotのadmission／operation／reconciliationは同snapshotで渡された完全な値をそのまま保持する。nullを前snapshotの値で埋めず、最新snapshotと歴史結果の合成を行わない。別requestのreceiptを「最後の成功」として勝手に蓄積しない。receiverの履歴は矛盾検査のための有限証拠であり、d1は履歴一覧・検索APIを追加しない。

結果本文にquiescenceがあればその値を表示できるが、表示更新は元callの正常配送とは別である。receiptFoundからnative recovery解除や元operationの静止を推測しない。readUncertain、admission unknown、transport切断は異なる情報として残す。

Project選択／旧ownerの表示資格／通常Appモーダルの寿命はd1の入力にしない。後続UIは独立したProject／service exact-owner guardを必要とし、本projectionを使っただけでその検査を済ませたとは扱わない。

## 6. 保存済み元terminalを公開する順序

既存acceptAttach／acceptControlReplyの二段階適用を維持する。

| 段階             | 確認・保存                               | d1で取得できる結果                                                                                      |
| ---------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 元call検査失敗   | token、schema、echo、immutable本文の不正 | foreign tokenはforeignToken拒否。登録済みcallの初回不正replyはpendingを維持し、既知terminalは変更しない |
| 元call検査成功   | 正常reply全文を事前予約へ保存            | terminal。rejected branchも正常な元reply                                                                |
| projection成功   | 履歴・highwater・flagsを原子的に更新     | 同じterminalと更新後display                                                                             |
| projection失敗   | 矛盾、ref再使用、容量不足、resync等      | terminalを維持しdisplayは停止／退役、旧snapshotを維持                                                   |
| 旧callの正常後着 | 元reply保存、退役世代を再昇格しない      | terminal。現在表示へ旧snapshotを入れない                                                                |

正常replyとはwireの構造・元request全文と対応が検証された返信である。実hostが正しくdispatchしたことをpure receiver単独で証明する意味ではない。

同じterminalの再取得は同じ本文を返す。member配列順を保持し、object key順や整数の同値表記は既存equality helperに従う。元replyを最新snapshotへ置き換えない。後から矛盾replyが届いても元terminalを上書きせず、停止事実だけを追加する。

getterが返すwrapperとnested値はreadonlyかつfreezeする。owned request／replyは既存recordの不変参照を共有し、取得のたびにcopy／JSON化しない。cacheは各record一件まで、又は保持しない小wrapperとする。呼出側が無制限に取得結果を保存するheapまでreceiverの上限と称さない。

## 7. d1の容量と停止

既存receiverのsnapshot64件／8MiB、call8MiB、Attach／Control ID各4096の縮小可能上限をそのまま使う。元replyはbegin時の最大2MiB予約で保存済みであり、terminal getterに第二のreply予算や追加IDを要しない。

表示cacheは最新一件だけで、ReceiverStateのowned scope／generation／snapshot／usageへの不変参照と有限なenum／booleanを保持する。snapshot本文を別予算へ無断複製しない。旧表示を利用者が保持しても内容は不変。表示cacheの更新をreceiverのquota消費・revision追加・GCの理由にしない。

raw入力のwire byte上限、bounded parse、保守数値24byte／control escape計数、nested既存root予算は従来通りである。d1は新しいraw JSON parserやlocal表示schemaを作らない。外部から届いたReceiverState風objectを本物のreceiverと認定するvalidatorでもない。

capacity停止後でも正しいtokenのterminal取得を許す。停止後のgetter成功を復旧・送信許可・未使用creditの返却としない。receiver.dispose()もcall／履歴を消去する操作ではなく、既存の回収可能性を維持する。

## 8. 元call配送はprep2d2へ分ける

d1はPromiseを生成／resolve／rejectしない。将来adapterが元callを登録してからdispatchし、返った正常replyを保存・配送する境界は別責務である。次のd2はpure poll型の有限台帳から始め、transportや時刻変換を含めない方針とする。

| 元経路                                        | 正常配送に必要な根拠                                                          | 代用できないもの                               |
| --------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------- |
| Attach／Control                               | d1 getterの元tokenに対応する正常terminal                                      | 最新snapshot、pending件数0、terminalStoredだけ |
| Lease／Admission／AdmissionInspection／Cancel | 元request全文・scopeに照合した元reply、又はCallInspection.terminalの同じreply | 新しいadmission知識、別IDへの再送              |
| operation／reconciliation観測                 | 元ObservationRequest全文・targetに一致するObservationReplyの結果              | StateFrame内の同ref結果だけ                    |
| 通信喪失                                      | 元callは未回収のまま、明示read-only照会を継続可能                             | Promise rejectで物理枠を解放すること           |

d2の台帳はcallerが正常な受信イベントとして投入した値を検証するだけであり、server registryを再実装しない。opaque call tokenを先に発行し、scope／元request／経路kind／元IDを固定する。ACK取り込みは保存と表示更新を二段階にし、表示失敗で正常元deliveryを捨てない。callbackを呼ばず、pollされたterminalを将来のPromise adapterが一度だけ配送する。

CallInspection.pending／notFound／unavailableは元call terminalではない。notFoundで元requestを再dispatchせず、別leaseで同じ不明admissionを再送しない。元admitの正常unknown返信は不変のまま、後のaccepted知識とは別に保持する。

ObservationReply.pendingから結果への進行と、unavailable終端は既存wire契約を維持する。readUncertainという正常deliveryは読取物理静止の証明に化けず、frame先着で元observation callの正常回収を代用しない。transport再接続時も元callのpending／結果不明／既知terminalを別に扱う。

## 9. d2実装前に固定する追加契約

d2はd1と同じPRへ混ぜない。次の詳細レビューでは、以下を具体的な型・上限・受入へ落とした独立実装境界にする。これらはd1の未決事項ではなく、d1が提供しない機能である。

- generic台帳とreceiverに同じAttach／Control本文を二重保存しない。d1 tokenを参照する構成又は経路分離のどちらかを選び、元callの所有者を一つにする。
- 元request＋最大replyを**送信前**に予約する。通常reply2MiBとCallInspection4MiB包絡を混同しない。照会包絡は一時検証上限、保存済み元replyは元profileで管理する。recovery read用予約をmutation枯渇から分離する。
- caller ID／tokenは有限、同ID別本文を拒否、exact replayは同tokenの参照だけ。退役、timeout、close、App unmountでpending slotを解放しない。全正常terminal後も保持上限で有限停止する。
- CallInspection自身を再帰的に照会しない。照会callが失われる場合の独立物理枠と元callとの関係を、通信実装前に明記する。
- 元call配送、admission knowledge、operation quiescence、read自身のuncertain、native recovery、transport状態を別軸で持つ。rawJSONの別owner証拠で合成しない。
- JSONから読めるownerRef／epochは認証ではない。pure投入経路と将来trusted transport／principal bindingの責任を区別する。

一回のd2に全mutation送信schedulerを実装する必要はない。元配送の保存・poll・照合までを最初の候補とし、新送信許可・native段階進行は既存server権威へ残す。実portへの適用には後述の別gateがある。

## 10. local-v2／製品接続までの明示gate

現local portをそのまま再利用して情報を落とすことは認めない。

| 現local契約の不足           | 将来接続前の必要事項                                              |
| --------------------------- | ----------------------------------------------------------------- |
| ownerEpoch無し              | logical sessionと全call／viewのepoch束縛、交代時の旧owner保持     |
| closed／control無し         | owner終了、認可失効、resyncとnative recoveryを別field／gateで維持 |
| LocalLeaseRequestにrole無し | mutation／reconciliationの明示role。ID prefixから権威を推測しない |
| 元call terminal無し         | 元dispatcher終端とcached frameを別経路として表す                  |
| observation Promiseだけ     | 正常delivery／readUncertain／transport pendingを区別する対応表    |
| connected booleanのみ       | transport喪失、受信停止、native閉鎖、認可情報を混同しない         |
| performance.nowによるUI意図 | native Instant／lease権威との別clock契約。JS数値の直接cast禁止    |

local-v2の版・注入mode・旧port共存／交換は別詳細設計で確定する。d1表示型をlocal-v2として注入しない。通常Appのsync／async mode固定や旧処理監視を迂回するthird propも追加しない。

P3bの認証・製品transportとembedded host 1の実装条件は解除しない。server coreがnative ownerを保持する方針は[wire・host設計](historian-recording-wire-host.md)に従う。純粋Rust registryやTS receiverの成功は実native排他、認証principal、lease期限、通信切断後の継続を受入済みとする根拠ではない。

## 11. d1の必須受入

| 項目             | 必須試験                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------- |
| 初期表示         | none、全nullable／enum、未接続で操作資格field無し                                           |
| snapshotRelation | ACK前、正常attach、切断、retire、resync、closed、authLost、ownerBlocked単独の各組合せ       |
| scope            | ownerEpoch／context完全保持、別receiverのtoken拒否                                          |
| 完全snapshot     | nullable欄を旧値で補完しない、member順・数値同値維持                                        |
| pending取得      | begin直後、malformed ACK後、退役／dispose後の未回収                                         |
| 正常terminal     | attached、rejected reply、control snapshot／detach／rejectedの正確な元request／reply        |
| 二段階失敗       | 履歴容量不足、同revision矛盾、subscriptionRef再利用、unknown低revでも正常terminalを取得可能 |
| 旧call           | 世代退役後の正常後着でterminal取得、現在snapshot非巻戻し                                    |
| 不変性           | exact再取得、後の矛盾reply、callerによる元入力変更、freeze、旧poll結果不変                  |
| 再入             | Proxy trap中のterminal取得busy、currentDisplayは旧commit済み、finally後正常取得             |
| 容量             | 既存64件／8MiB履歴とcall8MiB縮小境界、getter反復でusage不変、未回収slot不変                 |
| 非接続           | Promise／timer／callback／network無し、App／Project保存／既存port動作不変                   |

既存receiver59シナリオを回帰させ、d1に必要な追加scenariosを同じpure TS fixture driverとブラウザmodule評価で実行する。ブラウザで通常Appへサービスを注入せず、Project保存の前後一致と不要なschema取得無しを確認する。Rust／wire schema変更は不要であり、TSとRustで第二の同一receiverを作らない。

## 12. 実装順と完了判定

1. 設計PR #85をwork `16cf2e3`へ統合した。
2. prep2d1でreceiverの三取得method、内部readout helper、上記受入を実装した。独立UI・新schema・新依存は追加しない。
3. d1の実装レビュー後、prep2d2の有限元配送台帳の具体型と上限を別途詳細化して実装する。通常Appへ結ぶ前にlocal-v2の情報欠落／寿命／mode契約をレビューする。
4. 製品bridge、実wire取得、実native接続はhost／P3bのgateを満たす別工程とする。

d1完了は「検証済みreceiver状態を情報を落とさず表示用に参照でき、保存済み元ACKをopaque tokenで安全に取得できる」ことに限る。元callを実送信した、native mutationを許可した、実通信を回復したという完了表現は用いない。

## 13. 実装と検証の入口

公開入口は既存receiverのまま、内部[`readout.ts`](../../../apps/banto-scada/src/lib/recording-wire-receiver/readout.ts)が表示と元terminalの小wrapperを作る。両poll cacheは同じcommit済みReceiverStateに束縛し、read-only getterは更新guardを共有しながらcacheを再生成しない。元request/replyは既存台帳のowned/frozen参照で、wrapperの履歴台帳や第二のreply予約を追加しない。

[`recording-wire-readout-cases.json`](../../../examples/recording-wire-readout-cases.json)の19シナリオと[`recording-wire-readout.test.ts`](../../../apps/banto-scada/src/lib/recording-wire-readout.test.ts)を追加し、既存receiver59シナリオのdriverにも全stepの元ACK読取・旧表示不変を加えた。共通fixtureをChromiumの実moduleでも実行し、Project保存前後一致と外部送信無しを確認する。通常Appへのservice注入は行わない。

不変元callとCallInspectionの具体的な有限台帳は[prep2d2aの採用詳細設計](historian-recording-wire-delivery-ledger.md)へ分離した。Lease／Admission／AdmissionInspection／Cancelを先に扱い、Attach／Controlの所有はd1へ、Observationのpendingから結果への進行はd2bへ残す。
