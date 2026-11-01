# Historian H4a: bounded HistoryReaderの非同期request／response host

2026-11-02。状態: **Astra 主設計、ローカル実装・受入済み。全体CIはPRで確認する**。[raw snapshot query](historian-query-snapshot.md)、[minmax](historian-minmax-query.md)、[記録と保持の協調](historian-recording-retention.md)を前提にする。

## 今回の目的と範囲

記録・保持済みSQLiteからの履歴検索を、後続の共通Trendが非同期に呼べるlibrary境界へ接続する。既存HistoryReaderのraw／minmax、同snapshot、coverage、予算、cleanupをそのまま利用する。HistoryHostはscada-runtimeに置き、同期SQLiteをasync executorから切り離す。

製品HTTP／認証／transport、UI、長期検索の新仕様、Project schema、製品設定、SDK接続、実DB credentialは追加しない。DB format、H1 JSON、SDK固定rev、Project、Banto、既存依存を維持する。新しいrequest queueやcache、複数reader poolを作らない。検証はmock Hubと隔離一時SQLiteで行う。

## 所有と最小API

HistoryHostは既存のHistoryReader一つを所有し、一回に一要求だけをspawn_blockingへ移す。writerを借用したままasyncに待つのではなく、reader独立connectionとReaderLeaseを既存コアから受け取る。

最終の綴りは実装に従う。

```rust
struct HistoryCompletion {
    request: HistoryRequest,
    result: Result<serde_json::Value, QueryError>,
}
```

- HistoryHost::new(reader): 接続済みread-only readerを所有する。path／資格情報から暗黙にDBをopenしない。
- start_query(query, QueryControl): 同期の受理API。opaqueなHistoryRequestを返す。結果成功の意味ではない。
- cancel_query(&request): 現在の同token要求へ取消通知する。別要求へ通知しない。join済み同tokenは成功NoOpで、保存結果を変更しない。
- join_query(&request): asyncで同tokenのtaskを借用awaitし、readerと`Arc<HistoryCompletion>`を回収する。
- state(): phaseと現在request等の軽い診断を返す。result watchは不要。
- take_reader(): task未joinでなければreaderをcallerへ戻し、旧completionを無効化する。以後NoReaderとなる。

HistoryRequestはprocess内のopaque identityであり、H1 query ID、snapshotId、recordIdとは異なる。公開H1へ追加せず、署名token／権限／永続再送tokenとして扱わない。

callerはstore.reader()でreaderを先に発行してからwriterをRecordingHostへ渡せる。記録hostへ無制限reader factoryを追加せず、既存の最大2reader leaseを維持する。idle readerも一枠とwriter ownership leaseを持つ。

## request／responseの規則

履歴検索は表示用bounded latest watchと異なり、各要求に対応した一つの結果またはtyped errorを返す。新要求で実行中queryを黙って上書きしない。workerが計算を終えていても未joinなら次start／take_readerはBusyである。

start時にqueryとQueryControlをmoveし、同じreaderで一度だけquery_rawまたはquery_minmaxを呼ぶ。modeのdispatch以外にH1構造、minmax計算、coverage、raw point cap、quality、系列identityを再実装しない。共有`validate_query_request(&Value) -> Result<HistoryQueryMode, QueryError>`をHistorian coreへ抽出し、8KiB入力上限とH1検証をhost受理前にも行う。HistoryQueryModeはRaw／MinMaxとする。invalid requestはHostError::Requestとして受理を拒否し、readerを失わない。reader自身も同helperを使い、query_raw／query_minmaxのmode一致gateを維持する。未知mode／不正queryを成功の空結果に置き換えない。構造不正をtransportの別DTOへ無断変換しない。

request入力は既存serde_json::Valueであり、受理前にcallerが確保したメモリ自体をhostが制限できるとはしない。共有helperで受理するpayloadを8192byte以下とH1制約に限定し、hostで無制限の入力clone／queueを作らない。QueryControlの検証・期限切れ・取消・実行予算はworker側の既存coreで判定する。結果は既存output予算内のValueをArcのcompletion一件で共有し、再joinのために全結果を複製しない。

join／cancelで期待tokenが現在requestと違えばRequestMismatch等で拒否する。古いqueryの完了を新queryの結果として返さず、古いcancelで新要求を止めない。join済みの同tokenには保持した同じcompletionを返せる。次startで旧completionを無効化する。callerが古いArcを保持している場合もtokenが区別を可能にする。

新要求のために暗黙cancel／retry／next pageを行わない。複数同時検索が必要ならcallerが明示的に別reader／hostを取得し、2lease上限を受ける。

## phaseとerror分類

| phase          | 意味                                                    |
| -------------- | ------------------------------------------------------- |
| Idle           | readerをhostが所有し、query未実行またはjoin済み         |
| InFlight       | task受理済み、完了していても未joinを含む                |
| ReaderUnusable | coreがcleanup不能を報告。host内で同readerを再利用しない |
| Faulted        | panic／JoinErrorでreader回収不能。新query不可           |
| NoReader       | take_reader後。新query不可                              |

phaseの綴りは実装に合わせてよい。joinの外側Resultは所有／token／task失敗を表し、queryのtyped errorはHistoryCompletion.resultに入れる。joinがOkでもquery成功とは限らない。

Cancelled、Deadline、WorkLimit、ByteLimit、TooManyPoints、MetadataAmbiguous、CorruptData、Database等をhostが一括でReaderUnusableにしない。cleanupに成功してreaderが返れば既存core契約に従い再利用可能である。QueryError::ReaderUnusableはconnectionが破棄された結果なので、追加queryを拒否する。take_readerでそのreaderを回収してdropできるが、正常connectionへ修復したとはしない。別readerの発行はcallerの明示操作である。

panic／JoinErrorではFaultedにし、readerを自動openしない。QueryErrorは既存の安全な分類であり、SQL本文、DB path、credentialを新しい公開エラーへ混入させない。

全seriesがunknownSeriesでもcoreがready結果を返すなら、そのまま返す。unrecorded／expired、空区間、技術障害を混同しない。hostはresultのreadyを「無欠測」へ言い換えない。

## deadline、取消、cleanup

callerのQueryControlをそのままworkerへ移す。deadlineをworker開始時やretry時に延長しない。blocking pool内で待った時間もdeadlineに含まれる。VM先払い／callback、decode行数、入力証拠byte、出力byte、query範囲等は既存coreの有限上限を維持する。

cancel_queryは同要求のtokenへ通知するだけで、query完了、snapshot解除、reader回収を意味しない。join_queryはJoinHandleをself内に残して`&mut`でawaitする。future取消や外側timeoutでもInFlightを保持し、再joinで同じreader／結果を回収する。未joinの間は別queryやtake_readerを許さない。

coreが成功結果を返した後の遅延取消を、hostが再検査してCancelledへ書き換えない。snapshot cleanupと最後の予算検査を含む既存query結果を尊重する。query中の取消によるtyped errorならそのまま返し、部分countsや部分binsを成功へ切り詰めない。

readerのSnapshot guardはhandler解除→ROLLBACKを行い、cleanup失敗ならconnectionを捨てる。この規律をhost側のtransactionやprogress handlerで包み直さない。OS I/Oのhard timeoutやblocking taskの強制停止は保証しない。JoinHandle::abortは停止手段に使わない。

## lease、Drop、記録・保持からの独立

readerはread-only connectionを閉じてからleaseを解放する。hostがIdle／ReaderUnusableで所有している間もleaseは残り、writerをdropしても次の独立writer ownerがBusyになる場合がある。利用終了時はhostまたはtake_readerしたreaderを明示dropする。

hostをquery中にDropすると取消をsetし、blocking taskをdetachする。workerはreaderを保持してcleanupし、最終的にreaderをdropするまでleaseが残る。Dropはjoin完了や即時lock解放とはしない。callerが確認可能な終了を必要とする場合はcancel→join→dropを使う。

HistoryHostの作成／query／取消／DropはRecordingHostの開始・停止やSDK購読の需要を変更しない。retentionとは同じSQLite WALのsnapshot契約で共存する。queryがsnapshotを取得した後に記録・保持がcommitしても、一回の結果内で新旧状態を混ぜない。次queryは新しいsnapshotを得る。既に返したValueは後からのtrimで変化しない。

idle readerはactive SQLite snapshotを恒久的に開くわけではないが、query実行中のsnapshotはPASSIVE checkpoint等に影響し得る。容量／checkpointポリシーをこのhostが自動実行しない。

## 受入

- loopback SDK→RecordingHost→SQLiteの記録を、独立readerを持つHistoryHostのraw／minmaxで読む。async heartbeatが同期SQLiteで塞がれず、UI需要と独立している。
- clean pause→保持job完了後も同readerを再利用し、次queryでexpired／残存rawを読む。以前のcompletionが返した結果は変化しない。
- 一要求受理後は未joinの間、次start／take_readerをBusyにする。2reader lease上限とidle hostがleaseを保持することを確認する。
- query1完了／join→query2開始後にquery1 tokenのjoin／cancelを拒否し、query2に影響しない。再joinは同tokenの同completionを返す。
- 既に取消済みtoken、期限切れ、低予算、too many raw points、start時invalid query拒否、unknownSeriesを区別し、正常cleanup後の次queryが成功する。
- blocking pool待機で期限が過ぎてもdeadlineを更新しない。join future取消後に再joinでき、reader leaseが早く解放されない。
- 成功後latecancelで結果を改変せず、失敗後はtyped errorを保持する。ReaderUnusableとpanicは再利用拒否し、任意のDatabase errorを同一視しない。
- query中Dropでもcleanupまでleaseを保持し、終了後に解放する。reader故障の実cleanup注入は既存Historian core試験を継承し、runtime側は制御workerでhost状態遷移を検証できる。host統合で実cleanup故障を注入したとは混同しない。

H4aは非同期library read serviceの境界を完成対象とする。共通Trendの描画／request世代管理、製品History transport／認証、長期検索／page snapshot、キャッシュ、サービス配置は後続である。

## 実装・検証結果

`scada_runtime::history_host`にHost、opaque要求token、phase／completion／HostErrorを実装した。coreのquery moduleへ共有validate_query_request／HistoryQueryModeを抽出し、readerと同じ8KiB／H1検証を受理前にも使用する。既存serde_jsonをruntimeのdev依存から通常依存へ移し、外部バージョン・DB format 5・H1は変更しない。

Rust workspace384件（新規7単体・5統合）・Clippy `-D warnings`／rustfmt・関連Chromium6件が成功。単体はreader移動前の拒否、token混同、取消安全join／Busy、worker待機中も元deadlineを使うこと、controlエラー後再利用、ReaderUnusable分類、panic、Drop中lease／cancelを確認した。実SQLiteのcleanup失敗は既存core試験を継承し、runtime側は制御workerで分類移送を検証している。

統合ではraw／minmax・Bad無値・unknownSeries、TooManyPoints後の明示minmax、2lease上限、同H1 requestIdでも別token、無効な次要求による旧結果維持を確認した。mock Hub→記録中query→clean pause保持job→同readerでexpired照会まで接続し、過去結果Arcの不変性とreader処分まで残るwriter ownershipも検証した。Astra最終レビューに必須修正はない。

製品HTTP／IPC、認証、画面側HistorySource／Trend、外部JSON parse境界は後続。同期I/Oのhard timeoutや実媒体性能・実S7測定を追加保証せず、上流・S7・実環境へ接続していない。
