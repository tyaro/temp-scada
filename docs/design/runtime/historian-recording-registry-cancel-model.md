# 記録registryモデルの取消と不変ack

状態: **prep2b2モデル実装済み、購読・workflow予約・実接続は後続**。2026-11-04（日本時間）。主設計はユーザー指定のAstra。
[結果観測モデル](historian-recording-registry-observation-model.md)はPR #73で統合済み。本書は同じ決定的Rustモデルへ取消の三つの時点を追加する。
新しいwire schema、Project 0.37.0、DB7、H1、SDK、Banto、依存の変更はない。実native／clock／auth／transport／hostには接続しない。

## 1. 今回の区切り

prep2b2では、CancelRequestの受理前登録、simulation通知の高々一回性、元cancel dispatcherの終端保存を別遷移にする。
operation／readのcompletion、元admission dispatcher、観測slot、sticky recoveryは既存の独立軸のままである。
取消によって新mutationを解禁したり、成功receiptを削除したり、未知静止をconfirmedに変換したりしない。

実装は `scada_runtime::recording_registry_model` に限定する。実CancellationToken、async task、generic backend、callbackは追加しない。
subscription、全workflow credit、rearm、GC、複数owner allocatorは後続であり、取消モデルを製品adapterと扱わない。

## 2. APIと不変ticket

```rust
pub struct ModelCancelTicket {
    // private: Arc model identity, checked local sequence, cancelId
}
pub enum CancelStart {
    Registered { ticket: ModelCancelTicket },
    Pending { ticket: ModelCancelTicket },
    Replay { reply: RecordingWireCancelReply },
}
impl RegistryModel {
    pub fn begin_cancel(&mut self, session: &ModelSession,
        request: RecordingWireCancelRequest) -> Result<CancelStart, ModelError>;
    pub fn notify_cancel(&mut self, ticket: &ModelCancelTicket)
        -> Result<RecordingWireCancelReply, ModelError>;
    pub fn finish_cancel_call(&mut self, ticket: &ModelCancelTicket)
        -> Result<RecordingWireCancelReply, ModelError>;
}
```

ticketはClone可能だがfield非公開／Deserializeなしで、別model・異sequence・不明IDを拒否する。
同文字列のrefやcancelIdだけからticketを作れない。ModelErrorは既存閉集合を使う。
新しい任意ack JSON入力は設けない。notify_cancelが規則からdecisionを作り、finishはその保存済みdecisionだけをterminalにする。
notify_cancelの戻り値は試験用の決定観測であり、まだ元call terminalではない。CallInspectionはfinishまでpendingである。

内部CancelRecordは `request, sequence, target:Option<HandleKey>, decision:Option<CancelReply>, terminal:bool` を持つ。
decisionとterminalは同じ不変reply本文を共有し、別コピーを恒久保持しない。
HandleRecordには `cancel_notified:bool` を追加する。通知回数の唯一の根拠はこのfalse→true遷移である。

## 3. 受付前登録

begin_cancelはsession／scope／owned requestを確認し、cancelIdを検索する。
同ID同本文ならterminal済みはReplay、未終端はPending。closed／ClockFaultより先に既登録証拠を返す。
logical session／request.scopeの不一致はID検索より前にForbiddenで拒否する。同じ有効binding内の同ID別target／本文はProtocolViolationとし、元要求を書き換えない。

新規だけclosed／ClockFault、cancel ID cap、未終端cancel slot、byte予約、sequence overflowを全て検査する。
その時点で `(target.kind,target.ref)` を既存handle表へ解決し、SomeまたはNoneを保存する。
登録・target binding・予約・slot取得を一つの遷移で行う。Capacity／Busy等の同期拒否ではID・資格・bytes・handle通知状態を一切消費しない。

未知refも登録可能だがtarget=Noneに固定する。後から同refがAcceptedになってもそのcancelを後着通知に変えない。
新しいcancelIdで明示要求し直すまで新handleへ到達しない。この場合も新ID／bytes／slot制限を受ける。
kindはoperation/readのnamespaceの一部であり、同文字列だから別kindのhandleへ取消を転送しない。

cancel slotは元admission dispatcherと独立する。Accepted proofが先着して元admit callが未終端でも、その既知handleへの取消を登録できる。
readの取消を元applyの取消へ転送しない。pauseJoinのstopを撤回しない。

## 4. 通知とdecisionの優先順

notify_cancelはticketを検証し、既存decisionがあれば同値を返すだけである。
最初の通知入力では次の順でdecisionを確定する。

| 条件                                 | decision                   | handle通知状態                   |
| ------------------------------------ | -------------------------- | -------------------------------- |
| 登録時target=None                    | rejected／ownerUnavailable | 変更なし                         |
| operationの元request.stage=pauseJoin | ack／notSupported          | 変更なし                         |
| 対象handleにcompletion保存済み       | ack／alreadyCompleted      | 変更なし                         |
| 対象handle.cancel_notified=true      | ack／requested             | 変更なし。以前の通知を根拠に返す |
| その他の既知handle                   | ack／requested             | false→trueを一度だけ記録         |

生成replyは元request全文をechoし、既存wire validatorで検証してからdecision／通知状態を原子的に保存する。
同handleへの異なるcancelIdは許すが、requested通知は全ID合計で高々一回である。IDごとに新しい通知を起こさない。
元cancelでrequestedを確定後にcompletionが届いても元decisionはrequestedのまま。後の別cancelIdはalreadyCompletedになり得る。

alreadyCompletedはmodelの不変completion／deliveryが保存済みという意味だけである。
OperationResultのunknown静止やDelivery.readUncertainをconfirmedへ変更する意味ではない。
readUncertainを含む保存済みdeliveryにもalreadyCompletedを返せるが、「native資源が終了した」と表示する根拠にはしない。将来の実adapterはnative handle／task状態から取消dispositionを判定する必要があり、このモデルのJSON completion有無による短縮判定をそのまま実接続へコピーしてはならない。
pauseJoinはcompletionの有無にかかわらずnotSupportedを優先する。この工程はstop撤回という新しい操作を作らない。

## 5. 元call終端と応答喪失

finish_cancel_callは保存decisionがなければInvalidInput。notifyを暗黙実行しない。
decisionがあればterminal=trueとして同じreplyを返し、cancel dispatcher slotを解放する。
同ticketの二重finishは同replyを返し、二重解放しない。新規beginへのBusyはterminal確定まで維持する。

通知は既に行ったがfinishがまだない状態を明示的に作れる。これは応答喪失・dispatcher終了不明を試験する状態である。
その間にoperation completionや観測terminalが来てもcancel slotは解放しない。
逆にcancel terminalがrequestedでも、operation／readが終了したことにはしない。

以下は独立して保存する。

- 元admissionの受付知識とimmutable terminal reply。
- 元cancelの通知decisionとimmutable terminal reply。
- operation／read completion、pending observation slot、recovery_required。

notify／finishによって後者のreceipt、quiescence、recovery、観測slotを変えない。
closed／ClockFault発生前に登録済みのticketは、その後もnotify／finishで証拠を確定できる。
新規cancelは既存new_effectと同じくClosed／ClockFaultで拒否する。このモデル制限を実製品の緊急停止やnative cancel方針と混同しない。
leaseはcancelに付けず、cancelによって期限延長／新lease発行をしない。

## 6. CallInspectionへの接続

既存inspect_callでoriginal=WireCancelRequestをサポートする。
cancelIdが未登録ならnotFound、本文違いならProtocolViolation、登録済み未terminalならpending、terminal済みなら保存replyを返す。
notify済みdecisionがあるだけではterminalを返さない。CallInspectionからnotify／finishを呼び出さない。

同CallInspection IDは同originalに束縛し、pending→terminalの回復読取だけを許す。
未知cancelのnotFoundは後着不能証明ではなく、新cancel要求を自動送信する根拠にしない。
Attach／Control originalは引き続き未対応unavailableであり、今回の変更でsubscriptionを実装したとはしない。

## 7. 有限資源と会計

ModelLimitsへ `cancel_requests`（最大4096）、`pending_cancel_calls`（最大1）を追加する。境界試験用の縮小を許す。
IDはcancel role固有pool。別role同文字列を同じ取消として扱わず、cancel role内では元本文を不変保持する。
未終端cancelがある間、新規cancelはBusy。既存Pending／Replay／inspectionは余計なpending枠を取らない。

retained会計は既存read専用2MiBを使い、mutationから借りない。
元request実測＋prep1 `recording_wire_reply_capacity` のCancelReply上界を受付前に固定予約する。
これは既知decisionと元terminalの同一本体を一回保管する予約であり、二つのreplyコピーを恒久保存する設計ではない。
元requestをechoするreply内の重複はcapacity helperが既に計数する。予約はmodel終了まで返却しない。

取消poolはmutation admission枯渇と独立するが、read bytesや取消自身のcapが詰まればCapacityで停止する。
この工程は「容量不足時にも取消を必ず通す緊急制御」を提供しない。既存登録済みnotify／finishには追加byte予約を要求しない。
CallInspectionのID／request会計と一時返却4MiB上限は既存のままである。
統計へcancel_requests／pending_cancel_calls／cancel_notified_handlesを追加し、件数の有限性と原子性を試験する。
固定管理overheadは件数で有限化し、保守JSON bytesをallocator実使用量と称さない。

## 8. 受入

Rustの既存scenario runnerへbegin_cancel／notify_cancel／finish_cancelを追加する。
期待wire transcriptはTS／browserで既存validatorへ通すだけとし、TSに取消の第二の権威モデルを作らない。

| 境界        | 必須受入                                                                               |
| ----------- | -------------------------------------------------------------------------------------- |
| 登録        | 同ID Pending／Replay、異本文拒否、scope／principal／kind、受付前Capacity／Busyは無変更 |
| private所有 | 別model同ID ticket、sequence改変、不明ticketを拒否                                     |
| 一回通知    | 同ticket二重notify、同handle別cancelId、operation/read両kindで通知1回                  |
| 未知ref     | unknown登録→後でAccepted→元cancelはrejected固定、新IDだけ既知handleへ到達              |
| 完了順      | completionが通知前ならalreadyCompleted、通知後なら元requested不変                      |
| pause       | pauseJoinはnotSupported、stop撤回／業務phase変更なし                                   |
| 元call      | notify前finish拒否、notify後未finishのinspectionはpending、finish後terminal不変        |
| 独立性      | cancel ackでadmission／completion／pending observation／recoveryを変えない             |
| read        | read取消は元applyに通知しない、readUncertain後ackでも元quiescence／recovery不変        |
| 時計・終了  | 登録後close／ClockFaultでも証拠確定可、新規拒否、既存Replay可                          |
| 予算        | exact／1不足、IDcap、pending cap、二重課金／二重解放無し、mutation枯渇から独立         |
| 未接続      | native token／DB／network呼出無し、schema／依存／通常App不変                           |

追加の具体受入として、元operation pending＋readUncertain保存済み→read cancel alreadyCompletedでもrecovery=true／元operation pendingを維持する。applied／quiescence=unknownのoperation cancel alreadyCompletedでもunknownを維持し、未実行／rollback／物理静止を生成しない。

次は完全snapshot／subscription・再接続の純粋モデルを詳細化する。全workflow予約と業務phase進行、複数scope allocatorはその後に分ける。
prep2b2で全stage運転や実取消を提供したとは主張せず、P3bと実adapterの再開条件を維持する。
