# 記録wireの有限な元call配送台帳

状態: **H5d4c4c-prep2d2の採用詳細設計。prep2d2aの純粋TS台帳を実装済み、Observationは後続**。2026-11-05（日本時間）。主設計はユーザー指定のAstra。

[client境界設計](historian-recording-wire-client-boundary.md)のprep2d1はPR86でworkへ統合済み（`c5720812c64df755ed36ebfaceecc8f912a36751`）。本書はその次のpure TS・poll型台帳を定める。Project 0.37.0、DB7、H1、wire/schema、SDK、Banto、依存版は維持する。

## 1. 最初の実装PRと非対象

**prep2d2a** は四種類の不変元callと、その元callに限定したCallInspectionを扱う。

- RecordingWireLeaseRequest / Reply
- RecordingAdmissionRequest / Reply
- RecordingAdmissionInspectionRequest / Reply
- RecordingWireCancelRequest / Reply

Attach／Controlはreceiverのopaque tokenとd1 getterの専用経路に残す。同じ本文をこの台帳へ登録しない。ObservationはCallInspection.originalに入らず、pending→専用結果への観測protocolを持つため **prep2d2b** へ分ける。d2aはObservation、Attach、Control、StateFrame、ControlFrameを入力kindとして拒否する。

元call配送台帳は既存Rust registryの再実装ではない。leaseを発行せず、native受付／workflow段階／quiescence／principal資格を判断しない。登録成功はdispatch許可ではなく、指定本文を将来配送するための有限なclient-side記録が確保できたという結果だけである。

Promise、timer、callback、subscribe、network、実host、SDK、native、認証、通常App／coordinator／local port／local-v2は追加しない。P3bの保留を解除しない。JSONを投入できる試験callerを実hostの権威と称さない。

## 2. 根拠と各軸

[wire-host](historian-recording-wire-host.md)のCallInspectionは、元dispatcherが保存した**元reply**を返す。後のadmission知識で元replyを書き換えない。

[wire validator](../../../apps/banto-scada/src/lib/recording-wire-contract.ts)、[admission validator](../../../apps/banto-scada/src/lib/recording-admission-contract.ts)と既存equality／capacity helperを再利用する。独立nested予算とclosed schemaを維持する。

Rust純粋registryのinspectionは元terminalと現在知識を分ける。現local coordinatorも元Promiseとframe知識を分ける。本台帳はそのうち元replyの保存と回収だけを担い、accepted handleの実行registry・結果合成・回復latchを持たない。

次の四つを同一視しない。

1. 元callに対応する正常不変replyが判明したこと。
2. 一回のCallInspection attemptが正常replyを受け取ったこと。
3. native operation／readの終了、commit、quiescence、recovery。
4. transport implementationが実際に保持するPromise／I/Oの物理終了。

d2aがモデル化するのは1と2である。正常wire replyイベントは試験callerから明示投入する。実transportが非協力Promiseを保持している場合、その資源を本台帳の件数が減ったという理由で解放したと扱わない。

## 3. 所有と型

固定scope一個をfactoryでowned化する。receiverと同様に既存wireのvalidation-only envelope（固定の有効AttachRequest等）へscopeを入れ、既存bounded parserを通す。これは検証のためだけで、Attach callを登録・送信しない。独自のscope schema／validatorを複製しない。scopeはownerRef／ownerEpoch／context全文。途中再bind APIは無い。別epochは別台帳であり、旧台帳の不明callを解決したことにはならない。

```ts
type OriginalRequest =
  | RecordingWireLeaseRequest
  | RecordingAdmissionRequest
  | RecordingAdmissionInspectionRequest
  | RecordingWireCancelRequest;
type OriginalReply =
  | RecordingWireLeaseReply
  | RecordingAdmissionReply
  | RecordingAdmissionInspectionReply
  | RecordingWireCancelReply;

// private instance-bound WeakMapの鍵。JSON/IDから復元しない。
interface OriginalCallToken {
  /* private brand */
}
interface InspectionQueryToken {
  /* private brand */
}
interface InspectionAttemptToken {
  /* private brand */
}

type LedgerError =
  | "busy"
  | "foreignToken"
  | "invalidRequest"
  | "unsupportedKind"
  | "invalidDocument"
  | "protocolViolation"
  | "capacity"
  | "retired"
  | "disposed";
type LedgerResult<T> = Readonly<
  { ok: true; value: T } | { ok: false; reason: LedgerError }
>;

type OriginalState = Readonly<{
  request: OriginalRequest;
  terminal: OriginalReply | null;
  learnedBy: "direct" | "inspection" | null;
}>;
type AttemptState = Readonly<{
  request: RecordingWireCallInspectionRequest;
  reply: RecordingWireCallInspectionReply | null;
}>;
type QueryState = Readonly<{
  request: RecordingWireCallInspectionRequest;
  original: OriginalCallToken;
  latestAttempt: InspectionAttemptToken;
  terminal: OriginalReply | null;
}>;
```

request/replyは既存validator由来のowned/frozen値。tokenを別台帳に渡すとforeignToken。token型をobject spread／JSON cloneしても同じ能力にならない。raw JSONのownerRef一致だけではtokenを作れない。

## 4. APIと戻り値

```ts
declare function createRecordingWireDeliveryLedger(
  scope: unknown,
  options?: Partial<DeliveryLimits>,
):
  | { ok: true; value: WireDeliveryLedger }
  | { ok: false; reason: "invalidScope" | "invalidOptions" };

type DeliveryAcceptResult = Readonly<
  | {
      ok: true;
      value: {
        disposition: "stored" | "duplicate";
        terminalStored: boolean;
        attemptStored: boolean;
      };
    }
  | {
      ok: false;
      reason: LedgerError;
      terminalStored: boolean;
      attemptStored: boolean;
    }
>;

interface WireDeliveryLedger {
  beginOriginal(request: unknown): LedgerResult<OriginalCallToken>;
  acceptOriginal(
    token: OriginalCallToken,
    reply: unknown,
  ): DeliveryAcceptResult;
  original(token: OriginalCallToken): LedgerResult<OriginalState>;

  beginInspection(
    original: OriginalCallToken,
    request: unknown,
  ): LedgerResult<{
    query: InspectionQueryToken;
    attempt: InspectionAttemptToken;
  }>;
  repeatInspection(
    query: InspectionQueryToken,
  ): LedgerResult<InspectionAttemptToken>;
  acceptInspection(
    attempt: InspectionAttemptToken,
    reply: unknown,
  ): DeliveryAcceptResult;
  inspection(query: InspectionQueryToken): LedgerResult<QueryState>;
  attempt(token: InspectionAttemptToken): LedgerResult<AttemptState>;

  current(): DeliveryLedgerState;
  retire(): LedgerResult<null>;
  dispose(): LedgerResult<null>;
}
```

beginInspectionのexact再登録は**初回queryと初回attempt**を返す。latestAttemptへ差し替えない。repeatInspectionだけが新attemptを登録する。これらは送信関数ではなく、callerに再送命令を返さない。

getterは非破壊。current()は最後のcommit済み集計を返す。token getterは更新中busy、current()は旧cache。rootにcallbackを渡すAPIや任意structural ledgerをtrustedと認定するAPIは追加しない。

## 5. ID、scope、exact再登録

元callの鍵は `(kind, rootの固有ID)`。LeaseはleaseRequestId、AdmissionはadmissionId、AdmissionInspectionはinspectionId、CancelはcancelIdである。異kindの同文字列は別namespace。Admissionのmutation/read分類でnamespaceを分けず、同admissionIdを役割変更して再使用できない。

CallInspectionは別のcallInspectionId namespace。queryは元tokenと元request全文へ固定する。同IDを別元callへ付け替えない。attempt IDはwireへ追加せず、内部checked sequenceとprivate tokenだけで管理する。

各beginはbusy guardを先に立て、tokenがあれば帰属を先に確認、bounded owned parse、scope照合、既知IDの全文照合の順とする。legacy AdmissionはownerRef/context、AdmissionInspectionはoriginal.ownerRef/contextを固定scopeへ照合する。legacy本文に存在しないownerEpochを比較したとは称さず、台帳と元tokenがlogical epochを束縛する。wire requestのscopeは全文一致が必要である。

正しいscopeで同ID別本文／別元tokenはprotocolViolationとしてsticky停止し、既存record／予約／terminalを変更しない。scope不一致や不正requestはinvalidRequest、未対応の有効kindはunsupportedKindで登録しない。

exact再登録は既知tokenを無課金で返す。現在の未回収枠、retired、disposed、停止、容量の検査より先に行う。既知tokenを返すことは同request再dispatchの許可ではない。member順を保持した全文同値を使い、native immutable本文の並び順非依存canonical比較へ置換しない。

## 6. 正常元replyと停止

acceptOriginalはtoken帰属をraw descriptor読取より先に確認する。対応kind、独立schema/予算、元request全文のechoを検査し、初回正常replyを保存する。初回learnedBy=direct。後のfullsame replyはduplicate、別replyはprotocolViolationで元terminalを維持する。

wire Lease/Cancelは既存wire parser/matcherを使う。legacy Admission/AdmissionInspectionはそれぞれの既存parserで独立検証し、reply.requestと保存requestの全文同値を既存equalityで検査する。wire matcherへlegacy rootをcastしない。元tokenがlocal epochを束縛し、callerが元callの正常deliveryとして投入する責任を持つ。JSONだけで物理routeや認可を証明しない。

元Admissionのunknownも**正常元reply**である。後のAdmissionInspection.foundがacceptedを示しても、そのinspection自身の元replyとして保存するだけで元Admissionを変更しない。Cancel.requested／alreadyCompleted／notSupportedもnative静止の推測に使わない。

不正replyはinvalidDocument、echo／既知本文矛盾はprotocolViolation。いずれも新規登録・repeatをsticky停止し、初回なら元callは未回収のまま、既知terminalは維持する。正常な後着replyとexact duplicateの回収は停止後も許す。失敗をnotDispatchedやrollbackへ変換しない。

この台帳にはsnapshot projectionが無い。正常terminal保存の後にcallerが行う表示更新・receiverへの入力が失敗しても、保存済みterminalは非破壊getterで取得できる。表示の成功を保存条件にしない。receiverと同じAttach/Controlを再保存する仕組みは設けない。

## 7. CallInspectionの論理queryとattempt

beginInspectionは未回収元call、元tokenと同一のoriginal全文、同scopeを要求する。既知queryのexact再登録は元call回収後でも可能。**新queryは元terminal未判明の場合だけ**受け付ける。CallInspection自身、Observation、receiverのAttach/Controlをoriginalとして登録しない。

初回query登録と最初のattempt確保は原子的。初回の保守予約creditを最初のqueryへ一度だけ移し、その後のqueryへ再利用しない。repeatは同queryの元requestを再利用し、新しい内部attempt tokenを返す。次を全て要求する。

- 元callとqueryにterminalが無い。
- 直前attemptに正常replyが保存済みで、未回収inspection attemptが無い。
- 台帳がdisposed／sticky停止ではなく、追加ID管理／bytes容量がある。

pending／notFound／unavailableは**そのattemptの正常reply**なのでattemptを完了状態にできるが、元callは未回収のままである。次のattemptは明示repeatでのみ作る。notFoundから元callの不存在確定、再dispatch、別lease利用許可を生成しない。unavailableからも同様である。

acceptInspectionはattempt→query→元tokenを辿り、reply.requestをそのquery本文へ全文照合する。既知attemptのfullsame replyはduplicate、別replyはprotocolViolation。duplicateでは元callへの適用を再実行せず、最初の保存と適用結果を維持する（正常attempt保存後の競合停止も解除しない）。attempt recordは第二段階の適用成功booleanを小metadataとして保存する。fullsame再受信はok/duplicateを返し、attemptStored=true、terminalStoredはこの保存済みbooleanを使う。従って競合済みattemptの再受信はtrue/false（attemptStored/terminalStored）のままで、元callへ適用成功したattemptはtrue/trueを維持する。最初の競合受信はprotocolViolationエラーであり、duplicate成功がsticky停止を解除することはない。getterのAttemptStateは正常元replyそのものを返し、元callのfirst terminalはoriginal getterで別に確認する。別attemptでpending→notFound→pending等が起きても、それだけを不変call矛盾とは扱わない。これは明示read-only再照会の別正常返信である。

terminal branchは対応元replyを既存元validatorと全文echoで検査する。ここまでの元request/echo検査が成功すれば、そのattempt自身の正常replyを先予約へ保存する。queryにまだterminalがなければ、そのqueryで観測した最初のterminalも保持する。その後に元callへの適用を行い、既知元terminalがあれば全文同値を要求する。異なる場合はprotocolViolationで停止するが、正常attempt replyは保存済みのまま、元callのfirst terminalは変更しない。未判明元callへの適用成功時はlearnedBy=inspection。既知元terminalのlearnedByは変更しない。

queryにterminalが入った後、新attemptは作らない。元callが直接回収された時も新query／repeatを止めるが、既に登録済みattemptの正常pending／terminal回収は許す。既知元terminalと異なるterminal返信も、そのattemptの正常echoが成立すればattemptには保持し、元callへは適用せず停止する。

元callとattemptの正常返信が逆順に到着しても双方の不変recordを保持する。元call同一性の矛盾とattempt自身の正常配送は別である。元requestへのecho不一致ならattemptにも保存しないが、正常echo後の元terminal競合はattempt保存後の第二段階失敗とする。

acceptのterminalStoredは「今回入力の元replyが元callへ保存済み又はfullsameとして照合済み」、attemptStoredは「今回入力のinspection replyを当該attemptへ正常保存済み又はfullsame」を表す。正常pending/notFound/unavailableはfalse/true、競合したterminalもfalse/true、正常terminal適用はtrue/true、direct正常replyはtrue/false。不正入力はfalse/false。既知の別terminalを持つことだけでterminalStoredをtrueにしない。

## 8. 未回収枠と物理通信の限界

元callはmutation/readそれぞれ未回収最大1、CallInspection attemptは全体未回収最大1とする。よってread原callが未回収でも、専用inspection枠でその元callを照会できる。各枠はnormal terminal／normal attempt replyのcommitでのみ解放する。retire、dispose、時間経過、不正replyで解放しない。

CallInspection.terminalで元callの正常replyが判明すると、台帳の「元terminal未判明」件数は減る。これは**元transport Promiseがsettleした**という件数ではない。外側adapterがまだ実Promise／I/Oを保持していれば、その物理gateを独立に保持し、台帳が次の記録を確保できても新送信しない。

本工程は未送信登録、実送信中、輸送路で滞留中を区別できない。beginとacceptの呼出権を持つpure試験callerが明示イベントを入力するだけで、正常responseの真正性やhostのcleanupを保証しない。将来adapterでは各実attemptへの対応と、元callの仮想Promise配送／実transport資源の終端を別途レビューする。

非協力transportを論理timeoutで捨てるAPI、Promise拒否を正常replyへ変えるAPIは提供しない。CallInspection自身のACKを失った場合、そのattemptは未回収のままでrepeatはBusy。CallInspectionをoriginalにして再帰照会せず、有限停止がこのsliceの制限である。

## 9. 容量とpool分類

既定値は以下。factory optionsは全field省略可、safe整数0..既定値の縮小だけを許す。不明field、accessor、symbol key、non-enumerable property、非plain object、負値／非整数／超過はinvalidOptions。options検査はscopeのbounded検査より先に行う。

| field              | 既定上限 | 意味                                     |
| ------------------ | -------: | ---------------------------------------- |
| mutationBytes      |     6MiB | mutation元recordの不変本文予約           |
| readBytes          |     2MiB | read元record、全inspection予約／metadata |
| mutationIds        |     4096 | mutation元call登録数、GCなし             |
| readIds            |     4096 | read元call登録数、GCなし                 |
| inspectionIds      |     4096 | queryの使用済み＋初回予約credit          |
| inspectionAttempts |     4096 | attempt使用済み＋初回予約credit          |

未回収枠1/1/1は固定であり縮小optionを増やさない。0bytes/IDsでもfactoryは成功し、実登録がcapacityとなり得る。全件数はchecked safe integerで計算する。

| 元call                           | 本文pool |
| -------------------------------- | -------- |
| Lease.role=mutation              | mutation |
| Lease.role=reconciliation        | read     |
| Admission.action=reconcile       | read     |
| Admissionのその他action          | mutation |
| AdmissionInspection              | read     |
| Cancel（operation/readいずれも） | read     |

ID prefixから役割を推測しない。Cancelは回復時の制御callとしてreadへ分類するが、取消権限やnative例外gateを保証しない。schemaで有効なCancel対象refをnative handleとして承認しない。

read2MiBをmutationへ貸し出さない。ただし有限read poolは他の正常登録や照会履歴でも消費される。無期限の回復read保証はしない。代わりに**全元callのbegin時に、その元call用の最初のquery＋attempt一回分をread側へ先取りする**。新しい元callのために既存の回復creditを奪わない。

## 10. 予約の式と最大reply

元requestはparse済み値を保守計数（数値24byte／control escape上界）する。wire Lease/Cancel要求256KiBとreply2MiB、legacy Admission/AdmissionInspection各512KiBの独立profileは既存通り。compact予算を保守bytesと誤認しない。要求parserの既存最大reply closureとCallInspection包絡closureを維持する。

元recordの予約は `Q + R + 1024` bytes。Qは元owned requestの保守bytes、RはLease/Cancelなら既存wire replyCapacityの上界、legacy二種なら512KiBの固定reply上界。roleに従うpoolへ課金し、実replyが小さくても返却しない。

さらに元begin時、最大64 ASCIIのcallInspectionIdを入れた対応CallInspectionRequestを構成して既存parser／closureへ通し、その保守bytesをIとする。`I + R + 2048` をread側へ予約する。1024はquery metadata、1024は初回attempt metadata、Rは元callと競合しても当該attemptの正常terminal replyを保持できる上界。inspectionIdsとinspectionAttemptsを各1予約する。actual IDは64以下なのでこの上界内である。

初回beginInspectionはこの専用creditをusedへ移すだけで再課金しない。queryの全requestを保守的にI bytes予約するため、元requestとscopeを参照共有してもその分の割引はしない。query metadataは元tokenへの参照を持つ。begin失敗は全poolを変更しない。

同じ元callへ別query IDを明示登録する場合は、元terminal未判明・inspection未回収無しを要求し、actual query request bytes＋R＋2048、query/attempt各1を追加確保する。repeatは同query requestを参照し、R＋attempt metadata1024とattempt count1を追加確保する。どちらも残容量不足では送信記録を作らず、既存記録を保つ。

attemptの保存はquery requestへの不変参照と、固定outcomeタグ／閉集合error、又は正常terminal replyへの不変参照である。元terminalと同値なら本文参照を共有できる。元terminalと競合する正常attempt replyもRの予約内に独立保持する。共有できても保守的なR予約は返却しない。terminal本文を4MiBのinspection包絡として永久に複製しない。getterはそのrequest/outcomeから凍結した小wrapperを作り、元terminalの参照を共有する。全外部fieldの意味は保存された元replyと同一であり、元callの最新知識へ差し替えない。

acceptOriginalは実owned replyの保守bytesが元recordの予約R以下であることを保存前に検査する。beginInspectionも実owned query requestが使用する予約I以下であることを確認してからcreditを移す。acceptInspectionはechoされるquery requestの実保守bytesが対応I以下、terminal branchの元replyの実保守bytesが当該attemptの予約R以下であることを、正常attempt保存前に確認する。既存rootのbytes/nodes/depth検査と予約R/I検査の両方が必要であり、一方で代用しない。reply側のR/I超過はinvalidDocumentでsticky停止、当該入力は保存無し（terminalStored=false/attemptStored=false）、既知本文・枠・課金は維持する。新queryのI超過はinvalidRequestで無作用。上界式が正しい通常入力では発生しないが、防御的な境界試験を設ける。

incoming CallInspectionReplyは最大4MiB/196608nodes/depth96の独立一時検証を行う。元replyの独立profileも満たす。parse済み包絡はcommit後に全体を保存せず、正規化した参照構造だけを保持する。terminal部分の実保存は各R予約内、包絡echoのrequestはqueryのI予約内である。一時検証のheapと永続予約bytesは別であり、保守予算をJS allocatorのheap上限と称さない。

既存最大reply closureに通る文書でも本台帳の総容量へ必ず入るわけではない。例えばlegacy元reply一件で512KiB、その初回probeにも512KiB＋Iを先取りする。read元callなら元本文込みで約1MiB以上、mutation元callでもread側へ約512KiB以上を要するため、read2MiBでは少数の元call又はrepeatで停止し得る。初回probe込みで収まらなければ、元callを登録する前にcapacityとする。原callを登録してから回復用初回容量が不足する形は許さない。

初回creditが未使用のまま元terminalが届いても、d2aではbytes／IDsを返却しない。closed/retired/正常終了でもGCやID再使用をしない。余剰返却は別設計とし、この制限を「長時間運用可能」と表現しない。

## 11. 状態、lifetime、エラー

current()は次の固定集計だけを返す。本文一覧やnative stageを返さない。

```ts
interface DeliveryLedgerState {
  readonly scope: RecordingWireScope;
  readonly retired: boolean;
  readonly disposed: boolean;
  readonly stoppedReason: "invalidDocument" | "protocolViolation" | null;
  readonly usage: Readonly<{
    mutationBytes: number;
    readBytes: number;
    mutationIds: number;
    readIds: number;
    inspectionIdsUsed: number;
    inspectionIdsReserved: number;
    inspectionAttemptsUsed: number;
    inspectionAttemptsReserved: number;
    awaitingMutationTerminal: number;
    awaitingReadTerminal: number;
    awaitingInspectionReply: number;
  }>;
}
```

retireは新しい元call登録を止めるが、既存元callの回復query／repeatは許す。disposeは新query／repeatも止める。どちらも正常後着の取り込み、exact再登録、getterを妨げない。sticky停止は新元call・新query・repeatを止めるが正常後着の回収は維持する。capacity拒否は状態を停止させず、その新規登録を無作用で拒否する。

開始順序は既知exact参照を先に処理し、新規だけdisposed→sticky停止（protocolViolation）→retired（新元callのみ）→未回収枠busy→容量を確認する。無効requestはparse段階で拒否し、raw本文から既知IDだけ先取りしない。

相互参照やreservation更新を先にcommitしない。準備したowned request、capacity計算、全一致検査、返却wrapperの生成を済ませてから一回commitする。登録・一次検証の失敗時はreply／使用済みID／予約credit／集計を部分更新しない。§7の正常attempt保存後の元terminal競合だけは意図した二段階適用であり、正常attemptと停止をcommitし、元terminalを維持する。

正常replyを保存した後に外部表示が失敗しても、台帳へrollbackを要求しない。表示はこの台帳のcurrent()とは別であり、receiverのsnapshot履歴と合成する仕組みはd2aに無い。

## 12. 再入・読取と所有

全public mutationとtoken getterはunknown inputのdescriptor／prototype確認より前にbusy guardを取得する。nested呼出しはbusyで無作用。current()は更新前のcommit済みcacheだけを返す。finallyでguardを解除し、raw Error／stackを返却しない。

全public result（成功／拒否／factory）とそのnested小metadataもfreezeする。getterはowned/frozen request／replyを参照共有する。小wrapperはephemeralで、無制限な履歴cacheを内部に増やさない。getterを反復してもcurrent()のcache identityとusageは変わらず、foreignToken拒否でも再publishしない。呼出側が返却値を保持する分はcallerの責任であり、ledgerの返却操作やGCとはしない。

Proxy trapは任意JSを実行できるためsandbox保証ではない。trap内の再入でも自分の途中状態を公開しない、getterを実行しない、失敗後もguardが残らないことを受入する。

## 13. d2bと製品接続へ残すもの

Observationは別の専用詳細設計で、同observationIdのpending→結果、各transport attemptの正常返信、opaque target bindingと結果不変性を閉じる。CallInspection.originalへ追加して既存schemaを変える方法は採らない。d2aの元reply台帳へ無理に入れない。

Attach/Controlの元回収はreceiverのd1 getterを使うが、d2aではその取得結果を台帳へimportしない。将来delivery rootが複数専用経路を束ねる場合も、本文所有者を一つにする。

local-v2へのPromise adapter、既存coordinatorへの接続、hostとのprincipal/epoch binding、輸送切断後の物理call解放、clock/lease変換、複数realmの全caller gateは後続。pure台帳から正常replyを取得できることと、実hostへ操作を実行できることを区別する。

## 14. 必須受入と配置

公開入口候補は `src/lib/recording-wire-delivery-ledger.ts`、内部は `recording-wire-delivery-ledger/{types,core,original,inspection}.ts`。内部構造は実装レビューで小さく調整できるが、公開scopeと意味は本書を維持する。

| 項目          | 必須試験                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------- |
| factory       | scope所有、零/縮小limits、invalidOptions優先、bounded raw/getter拒否                                |
| 四元call      | 各正常kind、unsupported Observation/Attach/Control、reply kind/echo不一致                           |
| 帰属          | 別instance token、legacy scope対応、epoch固定、kind間namespace、同Admission ID役割変更拒否          |
| 再登録        | exact旧token・無課金・停止後参照、同ID別本文、member順と整数同値                                    |
| 二軸          | Admission unknown元reply不変＋inspection found acceptedは別record、frame入力拒否                    |
| query/attempt | exact初回attempt返却、repeat明示、pending/notFound/unavailableから次attempt、同attempt別reply拒否   |
| 回収          | CallInspection terminal、直接replyとの順逆、既知元terminal矛盾、元call先完了後のpending attempt回収 |
| 未回収        | malformed/非回収attemptでrepeat Busy、元call/attempt各枠独立、disposeで枠を消さない                 |
| 予約          | Q/R/I oracle、全pool exact/1不足、初回credit移管無再課金、read独立、mutation満杯で既予約probe可     |
| 限界          | read枯渇・attempt4096上限、未使用credit保持、初回probe不足で元begin原子的拒否                       |
| 所有          | 入力後変更、getter参照共有、深freeze、4MiB包絡を永続複製しない                                      |
| 再入          | 各parse入口でnested全mutation/getter Busy、current旧cache、throw後guard復帰                         |
| 非接続        | Promise/clock/network無し、通常App保存不変、既存receiver/port無変更                                 |

shared JSONはtest command DSLとしてpure ledgerへ入力する。正常request/replyは既存wire/c4a validatorへも照合する。VitestとChromiumの実moduleで同じscenarioを実行し、Rustに第二のclient ledgerを作らない。

## 15. 実装順と完了判定

設計PR #87はwork `a3dd209`へ統合済み。prep2d2aの四元call・CallInspection・有限予約・poll APIと受入を実装した。元callとattemptの正常配送保存までを完了条件とし、native stage、表示統合、Promise正常settle、実transport quiescenceを実装済みとしない。

その後にd2bのObservation専用経路を詳細化し、local-v2／実bridge接続はP3bを含む別gateで扱う。d2aを実装するためのhost選択・認証・未決clock較正は必要としない。

## 16. 実装と検証の入口

公開入口は[`recording-wire-delivery-ledger.ts`](../../../apps/banto-scada/src/lib/recording-wire-delivery-ledger.ts)。内部のtypes/core/validation/original/inspectionへ分け、既存wire/c4a validatorと容量・全文同値helperを共用する。guardの内側で準備し、全検査後に原子登録する。正常attemptだけは元terminalとの競合時も第一段階保存を維持する。getterはowned/frozen本文を共有し、current cacheとusageを変更しない。

[`recording-wire-delivery-ledger-cases.json`](../../../examples/recording-wire-delivery-ledger-cases.json)の61シナリオと95追加unitで、四経路・query/attempt・pool/credit・正常後着・duplicate flags・ownershipを検証する。独立Q/R/I oracleのexact/1不足、read枯渇時の初回credit、R/Iを壊した防御試験、全parse入口での再入も確認する。同じfixtureをChromiumで実台帳へ流し、通常Appの保存前後一致と外部送信無しを検証する。
