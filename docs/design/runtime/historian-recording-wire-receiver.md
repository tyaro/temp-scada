# 記録wireの純粋receiver

- 設計日: 2026-11-05 JST。主設計: Astra。
- 段階: H5d4c4c-prep2c。今回は詳細設計のみ、実装は後続PR。
- 前提: [wire/host契約](historian-recording-wire-host.md)、[snapshot/subscriptionモデル](historian-recording-registry-subscription-model.md)、prep2b5aまでの純粋Rust registry。
- Project 0.37.0／DB7／H1／wire/schema／SDK／Banto／依存は変更しない。P3b、実host・認証・transport・native接続は保留。

## 1. 採用する一工程

固定Scopeの受信順序と重複を検査するpure TS receiverを実装する。
server側のregistry、lease、workflow、receipt、native worker状態をTSへ再実装しない。
入力は既存wire文書、出力はowned/frozenな最新表示状態と有限な判定だけとする。
通常App、recording-async/coordinator、既存local portには接続しない。

receiverはcallback、Promise、timer、network、native処理、外部時計を呼ばない。
明示入力とpollに限定し、callback再入やlistener queueを新設しない。
受信frameを既存local frameへcastするadapterも作らない。local portにownerEpoch／closed／control／元call終端がないため、透過変換は不可能である。

## 2. 固定identityと観測軸

constructorで一つのowned Scopeを固定し、ownerRef／ownerEpoch／context全文を照合する。
Scopeの検証は既存wire validatorを用いる有限validation-only envelopeで共用し、未知keyや無効整数を独自に許さない。
Scope変更・epoch更新・principal認証はAPIに含めない。
別epochは別receiverになるが、旧receiverの不明操作を解消した証拠にはならない。

状態は次の独立軸を持つ。

- transport: connected / disconnected。callerの配送状態宣言であり認証・native静止証拠ではない。
- generation: attaching / attached / retired。private ticketで対応付ける。
- receive status: ready / awaitingAttach / resyncRequired / stopped。
- stopped reason: protocolViolation / invalidDocument / capacity / disposed。
- ownerClosed: snapshot.closed=trueまたはownerClosed controlを観測したsticky事実。
- ownerBlocked: snapshot.ownerBlocked=trueを観測したsticky事実。native recoveryだけを表す。
- authorizationLost: 対応するcontrolを観測したsticky事実。再認証解除APIはない。
- latest: 最後に受理した完全snapshot、またはnull。

transport切断、resync、容量不足をownerBlockedへ混ぜない。
closed/ownerBlocked/authLostが立っても既知結果を消さない。
receiverがreadyでもmutation権限を返さず、native適格性や元callの静止は別契約で検査する。

## 3. API案

`apps/banto-scada/src/lib/recording-wire-receiver.ts`を公開入口とし、内部は分割可能とする。

```ts
type ReceiverError =
  | "foreignToken"
  | "busy"
  | "invalidRequest"
  | "protocolViolation"
  | "invalidDocument"
  | "capacity"
  | "disposed";
type ReceiverResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: ReceiverError; terminalStored: boolean };
type ReceiveResult = ReceiverResult<{
  disposition: "applied" | "duplicate" | "ignoredRetired" | "resyncRequired";
}>;
interface ReceiverLimits {
  attachIds: number; // default 4096
  controlIds: number; // default 4096
  snapshotRevisions: number; // default 64
  snapshotBytes: number; // default 8MiB
  callBytes: number; // default 8MiB
}
function createRecordingWireReceiver(
  scope: unknown,
  limits?: Partial<ReceiverLimits>,
):
  | { ok: true; value: WireReceiver }
  | { ok: false; reason: "invalidScope" | "invalidOptions" };
interface WireReceiver {
  beginAttach(request: unknown): ReceiverResult<AttachGeneration>;
  acceptAttach(generation: AttachGeneration, reply: unknown): ReceiveResult;
  acceptState(generation: AttachGeneration, frame: unknown): ReceiveResult;
  acceptControlFrame(
    generation: AttachGeneration,
    frame: unknown,
  ): ReceiveResult;
  beginControl(
    generation: AttachGeneration,
    request: unknown,
  ): ReceiverResult<ControlCall>;
  acceptControlReply(call: ControlCall, reply: unknown): ReceiveResult;
  setConnected(connected: boolean): ReceiverResult<null>;
  retire(generation: AttachGeneration): ReceiverResult<null>;
  current(): ReceiverState;
  dispose(): ReceiverResult<null>;
}
```

factoryは未知options key／accessor／非plain object／非safe整数／負値／既定上限超過をinvalidOptionsとする。全limitで0を許し、省略fieldだけ既定値を用いる。0のfactoryは成功し、後の該当資源を要するbegin/受信がcapacityとなる。Scope不正はinvalidScope。options→Scopeの順にbounded検証し、外部errorをthrowしない。
初期状態はconnected=false、generation無し、H/latest=null、全sticky flag=false、status=awaitingAttach、ID/予約使用0。Scope本体は既存単一request上限内で固定保持し、snapshot/call台帳とは別の定数一件として扱う。
`ReceiverState`は上記各軸とH、現在generationの有無、未回収attach/control件数、各limit使用量をreadonlyで公開する。private tokenや可変Mapを露出しない。
setConnectedの非boolean実行時入力はinvalidRequest、退役済みretireと既disposeへのdisposeは成功no-op。busy再入時は全mutationを同じReceiverResultで無作用拒否する。terminalStoredはreply受付の保存例外だけtrueとなり、他の拒否ではfalseとする。

AttachGeneration／ControlCallはprivate instance identityを持つopaque JS object。外部objectから復元しない。
foreign tokenは送信資格を作らず、有限なforeignToken拒否。元receiverのstateを変更しない。
acceptState/acceptControlFrameは再入guardの後、tokenのinstance帰属と退役をpayloadのdescriptor/validatorより先に検査する。foreign tokenはforeignToken、既知退役tokenはpayloadを一切parseせずignoredRetired。現行tokenだけがunknown文書を検証する。
acceptAttach/acceptControlReplyは元call回収入口なので退役tokenでもparseする。まずprivate token帰属・登録callを確認し、次に元replyのbounded検証を行う。typedで渡されたことを理由にgetter／予算／schema検証を省略しない。
成功受信はReceiveResultのdisposition、拒否はReceiverResultの閉じたreasonで返す。再接続不能など現在資格で新beginができない場合はbusy、dispose後の新beginはdisposedとする。
外部error文字列を返さない。poll stateはimmutable snapshotで、過去に返した値を変更しない。

begin系の同期拒否はtoken／ID／容量を消費しない。受信不正文書は後述のsticky停止を残す。
begin系は再入guard後、owned文書・scope・必要なtoken帰属を検証し、既知IDの全文と元generationの一致を先に照合する。exactなら保存された旧tokenをreadonlyに返し、退役済みtokenを現行へ戻さない。新規IDだけconnected/stopped/disposed、元call未回収、H floor、容量等の受付gateを検査する。
過去のafterRevisionが現在Hより小さくてもexact再送なら旧tokenを返す。これは新dispatch許可ではなく、callerはそのtokenに新しいcallを生成しない。beginControlも元generationのexact再送を同様に扱う。
同ID別本文または別generationへの付替えはprotocolViolationで停止するが、ID台帳・予約・旧projectionは変更しない。

## 4. attach前後とhighwater

一度に現行generationは一つ。beginAttachで旧generationを退役させる前に、全入力・予算・ID・afterRevision検査を完了する。
既存attachまたはcontrol callの正常terminal未回収中は、新beginAttachをbusyとする。retire/切断だけで未回収callを完了扱いしない。これにより元controlの初回replyが新generation開始後に跨って配送される経路を初回scopeから除く。旧tokenによる正常terminal回収は常に別入口で許す。
既存attach/control双方のterminal ACKを回収した後、他のgateを満たせばresync/disconnectedから明示再attachできる。retired callへ保存したreplyは元call照合証拠として保持し、scopeの正式revision履歴へ自動昇格しない。新generation開始後に届く旧replyは既保存terminalとのexact重複照合だけとなる。

scope全体の受理済みrevision highwater Hをgeneration交換でも維持する。
初回HなしならafterRevision=nullまたは合法U0を許す。
Hがある場合はafterRevision>=Hを必須とし、nullや小さい値への変更で履歴検査を逃がさない。
requestのafterRevisionより大きい値をcallerが指定すること自体は許すが、server側拒否をそのまま受ける。

beginAttach時にHをgenerationのfloorとして保存する。
ACKは元要求全文に一致し、snapshot revision>=floorとrequest.afterRevisionを満たす。
ACK受信前のstateを反映するために、このfloorを後から引き上げない。
ACKがrevision Rを確定した後、保留stateを適用する。途中snapshotをcallback通知せず、pollからは最高revisionの完全stateだけ見えてよい。

ACK前はstateの配送slotを最新一件、controlを独立一件とする。
ただし上書き前の同revision矛盾を忘れないため、受信したsnapshot本文は有限のprovisional履歴へ保持する。
これは配送queueではなく照合証拠であり、上限到達時に捨てず停止する。
ACK前frameのsubscriptionRefは一つに限定し、異なるrefの混在をprotocolViolationとする。
ACK後に全provisional文書のscope/refとrevisionを照合する。R未満のframeは、ACK後更新という契約に違反するためprotocolViolation。
Rと同revisionなら本文完全一致のみ許す。ACK拒否ならprovisionalは表示へ昇格しない。

provisionalだけではscopeの正式H／owner flagsを更新しない。
有効ACKでsubscriptionの帰属を確定した時に、履歴とflagsを原子的に昇格する。
新AttachACKが同scopeの別generationで既にACKに現れたsubscriptionRefを再使用した場合、元callの正常terminalは保存するが、projection側でprotocolViolationとして停止する。ACKのrefは正常terminal保存時にgenerationへ記録し、後のprojection失敗/退役でも消さない。既存generation metadataの有限台帳で照合し、新poolを作らない。同一callのexact ACKだけは冪等であり、別generationへのref再束縛を許可しない。
ACK前controlは帰属確定まで一件保留。同一control重複は冪等、別controlの重なりは容量一件の契約違反としてresyncRequiredへ退役し、無言上書きしない。

### ACK前履歴のpromotion順序

ACK前には正式Hと比較した未知低revision判定をまだ行わず、scope/ref仮束縛とprovisional内・既存正式履歴内の同revision全文矛盾だけを検査する。
ACKの元call検証が成功したら、先に不変terminal replyをその予約区画へ保存する。その後、ACK snapshotと全provisionalをrevision昇順へ並べた有限集合のpromotion planを構築する。
全frameがACK R以上であること、既存正式履歴との一致、正式H未満の未知revisionが無いこと、昇順でclosed/blockedが戻らないこと、全履歴の件数/bytesを検査する。
ACK前の到着順ではなく、この一括集合とACK前からの正式Hを基準とする。例えばfloor H1→preACK R3→R2→ACK R1は、R1同本文ならR2/R3とも履歴へ登録しlatest=R3として成功する。ACK後のR3→未知R2は§5のresyncとなる。
検査成功時だけ履歴/H/latest/flags/subscription確定を一括commitする。R未満frame・本文矛盾・sticky逆行はprotocolViolation、正式H未満の未知revisionはresyncRequired、保持不足はcapacity。
失敗時も保存済みACK terminalは残すが、旧正式履歴/H/latest/flagsを変えない。現行generationは退役、配送slotは公開対象から外す。既存provisional本文/課金は証拠として保持し、途中まで正式化しない。
保留controlはsnapshot集合の成功commit後に適用する。ownerClosed/control等による退役も同じ受信呼出内で確定し、途中状態をpollへ公開しない。

## 5. revisionの検査

既存`recordingWireFrameMatchesSubscription`等は単一文書間のscope/ref／ACK R下限を検査する。
receiverの履歴、generation、low revision扱いはこれらのpure helperだけでは証明されない。
現行generationのframeは、まずowned/schema、scope、subscriptionRef、ACK R下限を検査し、その後にrevision履歴を照合する。
別generation tokenからのstate/controlはignoredRetired。現行subscriptionへrefを書き換えて救済しない。
旧generation後着を現行ACKのR下限へ当てて誤ってprotocolViolationにしない。

| 入力                 | 判定                                                      |
| -------------------- | --------------------------------------------------------- |
| 既知revision・同本文 | duplicate。公開state／Hを変更しない                       |
| 既知revision・異本文 | protocolViolation、sticky stopped                         |
| 未知revision > H     | 全予算・意味検査後に記録、Hとlatestを更新                 |
| 未知revision < H     | resyncRequired、現行generationを退役。stateを巻き戻さない |
| Hなし                | ACK帰属確定後に初期証拠として記録                         |

数値1/1.0、object key順は既存同値helperに従い同値、array順は厳密とする。
完全snapshotなのでrevision飛び越し自体は正常。欠番を補間せず、差分eventとして再生しない。
R3→未見R2という正当な遅延でもresyncする保守的制限を採用する。
低revisionを単に捨てる方式より停止が多いが、未知の同revision内容を正常と推定しない。

新generationのACK/ControlReply snapshotでも同じscope履歴を照合する。
新ACKはgeneration開始floor以上を要求し、未知低revisionではresync。既知低revisionの一致ACKは元callの不変結果として保持し、Hを巻き戻さない。
これはACK到着待ちに現行generationで観測した新しいstateとの順序逆転を許すための規則である。

## 6. snapshotのsticky事実

受理済みsnapshot.closedまたはownerBlockedがtrueになった後の、より新しいrevisionでのfalseはprotocolViolation。
同epoch内でreceiverが解除しない。低い既知snapshotのfalseは歴史重複なので許し、現在sticky値をfalseへ戻さない。
ownerClosed control後に、新しいsnapshot.closed=falseを正式適用することも拒否する。
controlにはrevisionがないため、そのcontrolより前の既知snapshot再送は許すが、未知snapshotを過去だと推測して解除しない。

operation/admission/read内容の業務進行をreceiver独自に推論しない。
request/refの文書内一致、snapshot内部整合は既存validatorに委ねる。
snapshotの入替により前のoperationがnullになっても、callback/Promiseの完了やreceipt消去とは解釈しない。
不変operation結果の回収は別のobservation/call-inspection経路であり、本receiverは実行しない。

## 7. control・detach・再接続

ownerClosed controlはownerClosedを立て、現行generationを退役させる。
authorizationLostはauthorizationLostを立て退役し、新attach/control開始を禁止する。
resyncRequiredは現行generationを退役させ、元call回収後の明示再attachを要求する。
ownerClosed後に本receiverから新attachはしない。既存ACK/元control reply回収とpollは継続できる。

beginControlはACK確定済みの現行generationに対してのみ許し、scope/subscriptionRefを固定する。
同時control callは一つ。snapshot/detachともrequest IDを保持し、同ID別本文は拒否する。
snapshot replyは元要求完全一致とsnapshotの既存意味検査・履歴照合を行う。
detached replyだけがそのcallの正常detach完了根拠であり、begin/timeout/切断で成功を生成しない。
detach成功は購読を退役させるだけで、ownerClosed／operation静止／rollbackを生成しない。

切断はconnected=falseとして保持し、現行generationを退役する。既存callは未回収のまま残る。
再接続connected=trueだけではgenerationを再活性化しない。明示beginAttachが必要。
新送信はconnected=true、stopped無し、ownerClosed/authLost無しの時だけ許す。
resyncを除くprotocol/invalid/capacityのsticky stoppedは本instance内でresetしない。

## 8. 不変元callと旧返信

attach/controlの受理済みrequestと正常なterminal replyは不変で保持する。
同じtokenへのreply同本文重複はduplicate、異本文はprotocolViolation。
frameや別ControlReplyの最新snapshotを元AttachReplyへ差し替えない。
元call結果が古くても正常ACKとして回収できることと、最新stateへ適用することを分離する。

退役generation、切断、resync、stopped、dispose後でも、登録済みcallのreply回収を許す。
元要求全文・scope・ref・構造予算を検証してimmutable replyを保持するが、退役generationを再公開しない。
正常call terminalが既に保存済みなら重複だけを受け、異本文を正常完了として上書きしない。
不正文書受信で停止しても、まだ未回収のcallへ後から正常replyを保存する余地は受付時予約で守る。

reply受付は次の二段階を区別する。

| 検査                                                                                                           | 不合格時の保存                                                                     |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| token帰属、owned予算/schema/独立意味検査、元request echo、元callのimmutable reply一致                          | 新terminalを保存しない。既存terminal/履歴を保持し、foreign以外の不正replyは停止    |
| 正常reply保存後のreceiver projection（正式履歴との同revision矛盾、保持容量、sticky flag、provisionalとの相関） | terminalは保存済みのまま、projectionだけ停止/resync。失敗結果のterminalStored=true |

既存wire helperが要求するrequest.afterRevision等の文書間条件も第一段階で検査する。
receiverが保持するfloorやprovisionalとの比較は第二段階であり、不正な最新表示を公開しないことと元callの正常delivery保存を分離する。
退役/停止/dispose済みcallの正常replyは第一段階だけで回収し、現在projectionへ昇格させない。
同callの完全同reply再送は保存済み結果を照合するだけで、以前失敗したpromotionを再実行しない。

本APIのacceptAttach/acceptControlReply呼出はcallerが「元callからの正常delivery」として渡す入力である。
frame受信はこの入口を代行しない。network/Promiseの物理settle、dispatch後quiescence、認証の証明は外部adapter責務であり、receiverはそれを観測できない。
CallInspection terminalを元callへ配送する将来adapterも、元要求とcall identityの照合が必要。単なるfound snapshotで元callをsettleしない。

## 9. 有限性と予算

全入力は既存rootのowned保守bytes/nodes/depth制限を独立して満たす。
raw string/HTTP bytesは受け取らず、上流decoderのraw wire上限検査は本機能の外。JSON.parse前の無制限wire入力を保護したとは称さない。
既存owned walkerのgetter拒否、Unicode scalar、有限数、plain JSON所有とfreezeを維持する。

初回のreceiver内部上限を以下に固定し、試験用の縮小設定だけ許す。

| 保持資源                     | 上限・課金                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------- |
| attach ID/generation         | 4096、GCなし                                                                    |
| control ID/call              | 4096、GCなし                                                                    |
| snapshot履歴                 | 正式＋provisional合計64revision、保守本文8MiB                                   |
| immutable call request/reply | 合計8MiB。begin時に実request＋元reply最大2MiBを先取り                           |
| generation metadata          | 1件1024bytes、call保持8MiB側へ課金                                              |
| control metadata             | 1件1024bytes、call保持8MiB側へ課金                                              |
| 配送slot                     | 現行state1＋control1。本文は履歴/owned入力から参照                              |
| 不変control証拠              | 各generation最大1件、固定Scopeの実保守bytes＋64KiBをbeginAttach予約に別途含める |

control frameの閉じたschemaはScope一回とkind/version/subscriptionRef/reasonだけを含むため、Scope実計数＋64KiB/4096nodesの固定envelopeを上界とする。depthはmax(scope.depth+1,3)。既存wire予算にも収まることを独立oracleで検証する。
各generationの初回予約は実request＋reply2MiB＋このcontrol上界＋1024bytes。scopeが小さい通常例では複数回の再attachが可能だが、無期限reconnectは保証しない。
初回実装ではexact回収による予約返却をせず、容量停止を明示する。

snapshotは全文を保持しhashだけで衝突検査しない。同revision同本文は既存参照共有で追加課金しない。
新snapshotを保持できなければ現在known stateを残してcapacity停止し、新入力を公開しない。
最新slotの上書きで過去revisionの証拠をGCしない。正当な長時間streamでも64revision/8MiBで停止する初回制限を明示する。
これは無期限運用receiverではなく、後続GC/世代retirement設計前の有限受入である。

ACKに含まれるsnapshot本文は既にcall用最大reply予約に収まるが、履歴へ正式登録する際のsnapshot区画も検査する。
履歴不足でも元ACKは正常terminalとして保存可能で、最新stateへの適用だけcapacity停止とする。
全保持上限を守るために「正常terminalを保存できなかったから未送信」と扱わない。

## 10. 失敗・純粋性・受入

begin系は全計数/ID/token/資格検査後にcommitし、拒否時は旧generation/予約を不変とする。
受信系はowned文書と全比較を計画し、違反では旧最新stateと既知証拠を残して有限停止を記録する。replyの正常terminal保存とprojection失敗を分ける§8の二段階は、この規則の明示的な例外である。
停止reasonの更新、transport状態、immutable call terminal回収をscopeのH更新と混同しない。
全public mutationはvalidator/descriptor確認を始める前からinstance内の再入guardを立て、finallyで解除する。Proxy trap等からのnested mutationはbusyで無作用とし、dispose/setConnectedも例外にしない。current()は直前commit済みstateだけを返す。commit前に計画時のgeneration/sequenceが同じであることも確認する。
current()はcallbackを呼ばず、通常のpublic inputのaccessorも評価しない。Proxyのdescriptor/prototype trapは実行され得るため、任意悪意Proxyをsandbox化したとは称さない。guardはreceiver自身の同期再入による状態破壊を防ぐ境界である。

| 受入       | 例                                                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| attach     | ACK前state複数→最新1、同revision矛盾、control独立、ACK ref/R不整合、別generationでのsubscriptionRef再使用（terminal保持・projection停止） |
| ordering   | R1→R3正常、既知R1重複、未知R2でresync、同R3異本文停止                                                                                     |
| generation | 新ACK前floor、新規afterRevision低下/null拒否・過去exact token再送は無課金、旧generation後着無作用                                         |
| sticky     | closed/blocked true→false新revision拒否、既知歴史false重複許可、authLost再開不可                                                          |
| reply      | frame先着でも元ACK未完了、旧token正常ACK回収、同call異reply拒否                                                                           |
| control    | snapshot古い既知返信、detach未応答/拒否/成功、resyncとdisconnectをclosedにしない                                                          |
| capacity   | 全上限exact/1不足、拒否前state不変、ACK用予約で停止後もterminal保持                                                                       |
| ownership  | caller入力の後変更不反映、freeze、getters拒否、foreign token、同ID別本文、Proxy trapからの各mutation再入とfinally解除                     |
| scope      | ownerEpoch/context全文不一致、新epochへ自動切替しない                                                                                     |
| 未接続     | App/local port/coordinator/native/schema/deps不変、pollのみ                                                                               |

次の実装PRはpure TS receiver＋unit fixture＋既存wire validatorを使うbrowser module試験までとする。
Rust registryはframeの生成fixture根拠として使えるが、TSに第二のserverを作らない。
現行coordinatorへの適用・wire/local mapping・元Promise配送・transport reconnect・認証更新は別設計とする。
