# 記録wireのObservation専用配送台帳

状態: **C4 prep2d2bの採用詳細設計、純粋TS実装は後続**。2026-11-06（日本時間）。主設計・レビューはユーザー指定のAstra。[d2aの元call配送台帳](historian-recording-wire-delivery-ledger.md)と[wire host契約](historian-recording-wire-host.md)を前提とする。

## 1. この区切りの責務

既存d2aはLease／Admission／AdmissionInspection／Cancelの不変元replyとCallInspectionを保存する。Observationは結果が`pending`から進む専用read protocolであり、CallInspection.originalへ追加しない。本区切りは、同一の純粋TS ledgerに**Observationの論理queryと個々のtransport attemptの保存・照合・poll API**を追加する。既存wire validatorとRust registryモデルの意味を変えない。

Promise、timer、network、native、認証、通常App、local port／local-v2、coordinator、実hostへの送信は含めない。登録は送信許可やAcceptedの真正性を証明しない。callerが正常受信イベントとして渡したJSONだけを検証する。元admission reply、受付知識、operation／reconciliation completion、transportの物理終了を別軸として保つ。

## 2. 所有する三つのtoken

```ts
interface ObservationTargetToken {
  /* instance-bound private identity */
}
interface ObservationQueryToken {
  /* scope + observationId + target全文 */
}
interface ObservationAttemptToken {
  /* 一回の要求と正常返信 */
}

interface ObservationAcceptFlags {
  attemptStored: boolean;
  queryTerminalStored: boolean;
  targetResultStored: boolean;
}
type ObservationTargetState = Readonly<{
  target: RecordingWireObservationTarget;
  admission: RecordingAdmissionRequest;
  accepted: RecordingAcceptedRef;
  result: RecordingOperationResult | RecordingReconciliationDelivery | null;
}>;
```

tokenは同ledgerのprivate WeakMapだけで認識し、文字列ref／JSON clone／object spreadから復元しない。別instanceのtokenは`foreignToken`。target tokenは既存の保存済みAccepted本文への参照と、kind/ref・元Admission全文を束縛する。queryはowned/frozenのObservationRequestを持ち、attemptはそのquery requestを参照共有する。getterはowned本文を返し、呼出回数で新しい台帳履歴や容量課金を作らない。

```ts
interface WireDeliveryLedger {
  bindObservationTarget(
    source: OriginalCallToken,
  ): LedgerResult<ObservationTargetToken>;
  observationTarget(
    token: ObservationTargetToken,
  ): LedgerResult<ObservationTargetState>;
  beginObservation(
    target: ObservationTargetToken,
    request: unknown,
  ): LedgerResult<{
    query: ObservationQueryToken;
    attempt: ObservationAttemptToken;
  }>;
  repeatObservation(
    query: ObservationQueryToken,
  ): LedgerResult<ObservationAttemptToken>;
  acceptObservation(
    attempt: ObservationAttemptToken,
    reply: unknown,
  ): ObservationAcceptResult;
  observation(
    query: ObservationQueryToken,
  ): LedgerResult<ObservationQueryState>;
  observationAttempt(
    token: ObservationAttemptToken,
  ): LedgerResult<ObservationAttemptState>;
}
```

`ObservationAcceptResult`は既存`LedgerResult`と同じ`ok/reason`に、成功時`stored/duplicate`、成否に上記三flagを持つ。flagは**今回のattempt本文**が各recordへ正常保存・同値照合されたかを表す。別attemptの既知結果があるだけではtrueにしない。getterはqueryのrequest／初回attempt／最新attempt／query terminal、attemptのrequest／不変reply、targetのAccepted由来と既知結果を別々に返す。全公開resultとnested metadataをfreezeする。

## 3. Accepted証拠からのtarget束縛

`bindObservationTarget`は同ledgerに登録された元tokenの**保存済みterminal**だけを読む。

- Admission terminalの`outcome.accepted.handle`を使う。
- AdmissionInspection terminalの`outcome.found.reply.outcome.accepted.handle`を使う。`found`でない結果、元Admissionの`unknown`、未回収terminalからtargetを作らない。
- CallInspectionが元replyを回収した場合は、d2aが保存した元terminalを同じAPIから読む。CallInspection attemptを別のAccepted import口にしない。
- Lease／Cancel、rejected／completedDiscard、readのnotFound／unavailable、foreign tokenは拒否する。外部の任意Accepted JSONを受け取るAPIを設けない。

同じ`admissionId`の元Admission全文とAccepted handle全文が同値なら同target tokenを返し、二重課金しない。直接replyとAdmissionInspectionの`found`が同じAcceptedを示す場合もこれに当たる。固定scope内の`admissionId`を単一キーとし、同IDの別元本文・別Accepted handleは`protocolViolation`。同kind/refが別`admissionId`へ付いた場合は、handle内のoperation requestが同じでも停止する。異なるkindの同文字refは別namespace。これはpure ledger内の矛盾検出であり、nativeが実際に受理したという認証ではない。

## 4. queryとattemptの進行

`beginObservation`はscope／epoch、opaque target、target.kind/ref／元request全文、既存wire parserを照合する。observationIdはoperationとreconciliationで共通のscope内単一namespace。同ID・同request全文の再登録は**最初のqueryと最初のattempt**を返し、送信や新課金をしない。同ID別本文・別targetは`protocolViolation`。新IDだけ容量と未回収枠を確認して原子的に登録する。

`repeatObservation`は同queryの明示再照会で、新しいattempt tokenを発行する。直前attemptの**正常返信が未回収**なら`busy`。直前の正常`pending`を回収した後だけrepeatできる。query terminal後はrepeatしない。失われた返信をlogical timeoutで解放せず、自動再送・同時attempt・Observation自身の再帰照会を実装しない。

各attempt返信は一回正常保存したら不変。同じattemptへ同値返信を再投入するとduplicate、別返信は`protocolViolation`。初回attemptは`pending`又は直接terminalを返せる。`pending`はそのattemptの正常terminalだがqueryの結果ではない。pendingを保存済みのattemptは変更せず、後続attemptの正常terminalでのみqueryを結果へ進める。`unavailable`は**そのobservationIdのterminal**で、後からhandleが見つかっても同IDを再開しない。別の新IDで観測する必要がある。CallInspectionの`unavailable`後のrepeatと混同しない。

別queryの結果や外部receiverのStateFrameを観測しても、この台帳へframeを投入するAPIはなく、当該queryや未回収attemptを暗黙に完了させない。**target結果**はoutcome.kindが`operation`又は`reconciliation`の検証済みpayloadであり、業務上の成功・失敗を問わない。同targetで一つの不変値として保持し、別observationIdから同値なら共有する。`unavailable`はquery固有であり、targetの不存在証明にしない。operation結果とreconciliation deliveryは互いに独立で、readUncertainをfailedへ置換しない。receiptFoundから元applyのconfirmed、recovery解除、次mutation許可を合成しない。

## 5. 返信の検査と二段階保存

既存`parseRecordingWireObservationRequest/Reply`、wire reply capacity、legacy operation／delivery validator、owned JSON同値を再利用する。request echoはscope／epoch／observationId／target全文で照合する。operation branchは`reply.request.target.operationRef`と元OperationRequest全文、reconciliation branchは元ReconciliationRequest全文とreadRef／ownerRefを照合する。member配列順は保持し、object key順と数値の同値は既存helperに従う。`pending`と`unavailable`をoperation／reconciliation結果に変換しない。

1. schema・echo・target・予約Rを全て確認してから、当該attemptの正常replyを保存する。不正文書／echo違いはattemptを保存せずsticky停止する。
2. terminal branchならqueryの最初のterminalを保存し、target結果は既知結果へ照合する。同query別terminal又は同target別結果なら、先の結果を維持して`protocolViolation`で停止する。正常attempt本文は第一段階の証拠として保持する。

競合時のflagはattempt保存をtrue、適用できなかったquery／targetをfalseとする。queryへの初回terminal保存後にtargetと矛盾した場合は`true/true/false`。同attemptのduplicateは最初の適用結果を再現し、停止を解除しない。元admissionの`unknown`をAcceptedへ書き換えず、normal Observation replyやframeから元配送を捏造しない。

## 6. 明示容量と有限停止

d2aのmutation 6MiB／read 2MiBを維持し、**Observation専用4MiB**を追加する。このpure delivery ledgerの保守予約合計は最大12MiB。既存receiverのsnapshot／call予算とは別で、JS heap上限や長時間運転の保証ではない。read 2MiBへ単純に加えると、AdmissionInspectionの元reply＋初回回復予約だけで約1MiBを使い、約1MiBのoperation Observationと共存できない実ケースがあるため、独立poolを採る。

`M=1024`（record管理）、`Q=owned ObservationRequestの保守bytes`、`R=recordingWireReplyCapacity(request).reply.bytes`とする。target初回は`M`、query＋初回attemptは`Q+R+2M`、repeatは`R+M`を**登録前**に全量予約する。`R`はoperationなら`Q+958464+65536`、reconciliationなら`Q+524288+65536`。例えば`Q=2048`ならoperation target＋初回query/attemptは1,031,168 bytes、repeatは1,027,072 bytes。reconciliationの初回一式は596,992 bytes。4MiBでも任意回数の再照会を保証せず、上限で`capacity`として有限停止する。

target／query／attemptは各最大4096 ID、未回収Observation attemptはledger全体で最大1。factory optionsは既存d2aと同様、各既定上限からの縮小だけを許す。既知exact参照・同値返信・getterは無課金。登録前に全ID／bytes／未回収枠を検査し、一つでも不足すれば無作用。返信時は独立root profileと予約Rの両方を検査し、到着時の追加容量不足で正常証拠を失わない。正常返信が小さくても予約を返却しない。同じ検証済みtarget結果は参照共有し、包絡を永続複製しない。

`current().usage`には既存項目に加え`observationBytes`、`observationTargets`、`observationQueries`、`observationAttempts`、`awaitingObservationReply`、`pendingObservationQueries`を追加する。前四者は新target／query／attemptの予約時だけ増え、返却・減算しない。`awaitingObservationReply`は新attemptで増え、そのattemptの正常返信保存でだけ減る。`pendingObservationQueries`は新queryで増え、そのqueryの初回terminal（`unavailable`を含む）でだけ減る。正常`pending`ではattempt枠だけを解放し、queryはpendingのまま。dispose／retire／timeout／外部frameではどちらのpending数も変えない。`current()`は既存と同じcommit済みcacheを返す。

4MiBは少数のpending→terminalとoperation／reconciliation併存を検証する有限枠である。未使用予約・IDの退役／GC、実Promiseの物理枠、複数callerの総容量と運転時間はlocal-v2／実bridge・C6までに別途閉じる。上限だけを引き上げて無期限運用可能とは扱わない。

## 7. 寿命と再入

`retire`は新元callを止めるが、保存済みAcceptedからのtarget binding、新Observation query／repeatを容量内で許す。`dispose`／sticky停止後は新target／query／repeatを拒否する。既知exact参照・getterと既登録attemptの正常後着reply保存はretire／dispose／停止後も許す。どの状態遷移も未回収attemptや実transport Promiseを物理終了と見なさない。

拒否順序は共通busy guardを最優先とする。bindではtoken帰属・保存済みAccepted検査→既知target exact／矛盾→dispose／sticky gate→新規容量、beginではowned request parse→scope／token／target全文→既知ID exact／矛盾→dispose／sticky gate→未回収枠→容量、repeatではtoken帰属→dispose／sticky gate→query terminal→未回収枠→容量とする。retireはこの三つの新read登録を拒まない。acceptではtoken帰属→返信parse／echo／予約検査→既知attempt exact／矛盾→二段階保存とし、dispose／sticky後の既登録attempt正常後着を受け入れる。初回malformed返信は`invalidDocument`でsticky停止し、当該attemptは未回収のまま。以後のrepeatはsticky gateの`protocolViolation`で拒否する。単なる返信喪失は未回収枠の`busy`である。既知exact参照は新規gateより先に返すが、不正raw本文からIDだけを先取りしない。

全public mutationとtoken getterはunknown inputのprototype／descriptor評価より前に共通busy guardを取得する。nested呼出しは`busy`で無作用、`current()`は以前のcommit済みcacheだけを返す。finallyでguardを戻し、raw Error／stackを外へ返さない。Proxy trap中の再入とthrow後の復帰を試験する。

## 8. 実装と受入の入口

公開入口は既存`recording-wire-delivery-ledger.ts`、内部は`recording-wire-delivery-ledger/{types,core,validation,observation}.ts`を中心にする。shared JSONシナリオをVitestとChromiumの実moduleで共通実行し、通常AppのProject保存と既存d2a／receiverの挙動を変えない。Rustに第二のclient ledgerを作らず、wire schemaと固定SDK版を維持する。

| 境界   | 必須受入                                                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------------------------ |
| target | Admission／InspectionのAccepted、元unknown不変、同handle再観測、別Admissionの同ref矛盾、foreign token                    |
| query  | operation／reconciliation、同ID exact／別本文、scope／epoch、kind/ref／元request全文、unknown ref拒否                    |
| 進行   | pending→別attempt成功、直接成功、readUncertain、unavailable固定、同attempt別返信、別ID同target同値／矛盾                 |
| 未回収 | lostでrepeat Busy、malformedで未回収保持・sticky停止、retire／dispose／停止後のlate正常回収、外部frameで未回収を消さない |
| 容量   | 4MiBとID／attempt上限、exact／1不足、read2MiB非侵食、受信時無追加課金、二段階保存                                        |
| 所有   | 入力後変更、deep freeze、getter無課金、全parse入口の再入と旧cache                                                        |

このPRは詳細設計の採用までとし、純粋TS実装・local-v2・Promise adapter・native bridge・実SQLite記録・History接続の完了を示さない。次の実装PRで上記契約を実コードと試験へ揃える。
