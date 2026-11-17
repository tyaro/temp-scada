# アラーム一覧の窓

## 目的

警報の「いま」と「これまで」を運転中に一覧で確かめ、見ている回を ACK する窓。基準は [段階3 警報の設計](../runtime/alarm-stage3-design.md) の §5.5（`alarm_ack`・`alarm_history`）・§6（ACK の権限と「見ている回を指す」規則）・§7（アラーム一覧の窓）。3-E1 で実装した。

Project には何も保存しない（配置ではなく窓）。Engine の状態を読むだけで、ACK は Engine の操作で PLC の bit には書かない。

## 表示と操作

### 開き方

- 表示プレビューのツールバーの「アラーム一覧」、運転表示のバーの「アラーム一覧」、行き先が「アラーム一覧」の[画面切替ボタン](nav-button.md)（プレビュー・運転表示）。
- トレンド履歴の窓と同じく Banto の `Modal` で描き、運転表示の間は運転表示の中に描く（`OperatorView` の `overlay`）。Esc・閉じるボタンで閉じ、運転表示には残る。
- 表示プレビューを離れたとき・Project を差し替えたときは閉じる。開くたびに選択と ACK の結果を捨てる。

### ブザー（3-E2）

- 窓の上端（タブの外）に、ブザーの状態の文字と「ブザー停止」のボタンを置く。状態は snapshot の `buzzer`（host が持つ）で「鳴っています」「停止中（新しい警報・再発生でまた鳴ります）」「鳴らす警報はありません」。Engine が動いていない snapshot は「鳴らす警報はありません」と読む。
- ブザー停止は ACK ではない（§6）。ACK の可否・ログイン・「履歴に書けない」に関わらず押せる。押したら snapshot を取り直す。未確認の行はそのまま残る。
- feed が `silenceBuzzer` を持たない（ブラウザ版）ときは「この版では鳴らしません」と出し、ボタンを無効にする。

### 「現在」タブ

- 行: Normal でない condition（未確認（発生中）・発生中・復帰・未確認）と、condition 単位の評価不能の condition（状態が Normal でも）。発生待ち（onDelay）は Normal と同じに扱う。
- 並び: 未確認（ActiveUnacked・ReturnedUnacked）を上に → severity の高い順 → 新しい順（§4.4。orderKey → 発生時刻 → condition id）。帯と同じ `newerFirst` を使う。帯の「同じ定義の上位の限界を先に」は一覧では使わない（全件を出すので落とす必要が無い）。
- 列: 選択・状態・重要度・発生（`M/D HH:mm:ss`）・名前・限界・メッセージ・評価不能（§4.5 の理由の文字）・ACK の結果。状態は文字で分ける（「未確認（発生中）」「発生中」「復帰・未確認」「正常」）。未確認の行は状態の枠で示す（色だけに頼らない）。
- 名前・メッセージ・限界・severity は snapshot の `applied.displays`（適用中の定義）を使う。無ければ condition id。
- 絞り込み: 「すべて」「評価不能だけ」（評価不能の理由がある行だけ。発生中で評価不能の行も含む）。
- Engine 単位の評価不能（未接続・受信の途絶）のときは、先頭に「監視できていません（理由）」の行を 1 行出す。Normal でない condition の行と ACK の操作はそのまま残し、Normal で評価不能なだけの condition は並べない。
- 理由の行（表の上）:
  - feed が無い（ブラウザ版）・snapshot の取得の失敗・snapshot がまだ無い・Engine が動いていない（停止中・未適用など。`ALARM_STATUS_LABELS`）。このときは行を出さず ACK もできない。
  - 「履歴に書けません（未記録 n 件）」。書けるようになるまで ACK のボタンを無効にする。
  - 別の Project を監視中。または編集中の Project と適用中の定義の revision が違う（`manifest.projectRevision` と `applied.projectRevision`）。どちらも一覧は適用中の定義で出す。

### ACK

- 「選んだ警報を ACK」: 選んだ時の回 (conditionId, occurrence, recurrence) を持ち、画面が持つ最新の snapshot でも同じ回の未確認の行だけを送る。選んだ後に再発生・新しい回になった行は選択が外れ、送らない（§6 見ている回を指す）。確認済み・Normal の行は選べない。
- 「すべて ACK」: 画面が持つ最新の snapshot の未確認の行（ReturnedUnacked も）だけを送る。表示の後に起きた回は送らない（§6）。
- 結果は 1 件ずつ文字で示す: 受理・別の回（最新の回を表示しています）・確認済み・無い（適用中の定義にありません）・履歴に書けない・Engine 停止中（理由）・失敗（理由）。行に残る condition は「ACK の結果」の列に、受理で Normal に戻って行が消えた condition も含めて表の上の結果の一覧に出す。
- ACK の後は（結果によらず）snapshot を取り直す。「別の回」の行は取り直した最新の回で出し直る。
- 要求ごとの拒否（未ログイン・Admin でない・認証を確かめられない）は理由の文を出す。

### 「履歴」タブ

- `alarm_history` で警報イベントを照会する。条件は期間（開始・終了。ローカル時刻の `datetime-local`。空なら制限しない）と種類（すべて・発生・再発生・復帰・確認・…）。開始が終了より後なら照会しない。
- 新しい順に 100 件ずつ。返った件数が 100 なら「続きを読む」で、最後の行の通番を `beforeSeq` にして続きを取る。
- 列: 時刻・種類・名前・限界の名前・判定の限界・値・source timestamp・メッセージ・備考（確認者・終了や評価不能の理由・「未確認のまま」）。名前などはイベントに残った表示情報（`display`）を使う。
- 初めて「履歴」タブを開いたときに条件なしで 1 回照会する。
- 履歴の行・カーソルは照会先（feed と監視中の Project の id）にひも付ける。host は監視中の Project の DB を照会するので、照会先が変われば行・カーソルを捨て（「履歴」タブを開いていれば取り直す）、照会の途中で変わった応答は採らず、その照会が終わってから新しい照会先で取る。窓を閉じている間に変わった場合も、履歴タブのまま開き直すと取る。自動の照会は照会先ごとに 1 回で、失敗しても繰り返さない（「照会」で取り直す）。「続きを読む」は同じ照会先でだけ取る。

## 実装

- 行・並び・ACK の対象・結果の文字・履歴の行・照会の条件: 純関数 `apps/banto-scada/src/lib/alarm-list.ts`（状態の導出は `alarm-view.ts` の `conditionDisplay`、新しい順・severity・理由のラベル・時刻の書式は `alarm-banner.ts` のものを使う）。
- 窓: `apps/banto-scada/src/lib/alarm-list/AlarmListWindow.svelte`。`App.svelte` の `openAlarmList`・`alarmListOpen` と `overlays` の snippet（トレンド履歴の窓と並べる）。
- IPC: `project-file-service.ts` の `AlarmFeed.ack`・`history`・`silenceBuzzer`、デスクトップ版は `native/project-file.ts` で `alarm_ack { items }`・`alarm_history { beforeSeq, fromMs, toMs, kind, limit }`・`alarm_buzzer_silence` を呼ぶ（`src-tauri/src/alarm.rs`）。ブザーの文字は `alarm-list.ts` の `alarmBuzzerText`。
- e2e のモック: `mock-alarm-feed.ts` の `ack`（host と同じ順の照合）・`history`（期間・種類・カーソル）・`silenceBuzzer`（鳴っているときだけ停止中にする）と、操作の `setSnapshot(…, { notify: false })`・`setHistory`・`refuseAck`・`ackRequests`・`historyQueries`・`silenceRequests`。

## 検証

- 純関数: `alarm-list.test.ts`（行の選び方と並び、評価不能の絞り込み、Engine 単位の評価不能の行、理由の行、ACK の対象、結果の文字、履歴の行と照会の条件）。
- IPC の引数名: `native/project-file.test.ts`。
- ブラウザ: `e2e/alarm-list.spec.ts`（並びと状態の文字、選んで ACK・「別の回」の取り直し・すべて ACK・要求の拒否、停止中・Engine 単位の評価不能・revision の違い・評価不能の絞り込み・履歴に書けない、履歴の照会と続き・種類の絞り込み、画面切替ボタンと運転表示のバーから開く、ヘッダーのブザー停止のボタンと窓のボタンで止めて ACK しない・feed が無いと押せない）。モックの警報 feed は小札・帯と同じくテスト用のエントリーだけに渡す。

## 後続・未対応

- ブザーの音を端末の設定で別の音声ファイルに変える（`alarm_settings_set`）のと、その設定画面は後続（§6）。
- 端末設定の画面、運転表示のヘッダーの例は範囲外。
- 一覧の列の並べ替え・幅の変更、履歴の書き出しは持たない。
- Tauri 実機（実 Engine・認証）での ACK と履歴の照会は未確認。
