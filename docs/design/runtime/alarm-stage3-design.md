# 段階3 警報の設計（製品hostの暫定Engine）

状態: **設計（2026-11-14 ユーザー承認・未実装）**。2026-11-14 作成。[フロー図の差分](../editor/flow-diagram-gap-2026-11-12.md)§3 の段階3「8. 警報」を、製品 host に暫定で置く形で具体化する。§9 の確認事項は 2026-11-14 にすべて回答を得た。

## 1. 目的と範囲

オーナー提供の参照画面にある次の要素を、運転表示で使えるようにする。

- 数値の横の HH／H／L／LL の小札（状態で色が変わり、未確認は点滅する）。
- 画面の枠の上端の「最新の警報」の帯と、「アラーム履歴」「ブザー停止」のボタン。
- 機器の故障などの bit を警報として、帯と履歴に出す。

範囲外: Shelve、latch、PLC 側の ACK・リセットの bit との連動、複数端末での ACK の共有、冗長化、24/365 の常駐、印刷、警報の Replay、機器種別の slot に持たせる警報の雛形（§8）。

## 2. 前提

上流（[上流 SCADA 設計](../../upstream/industrial/scada-design.md)。2026-11-14 時点の上流 main と差分なし）:

- §11.1: 警報は Alarm Source → Alarm Engine（AlarmDefinition／AlarmState／AlarmEvent／AlarmHistory）の汎用 domain。read-only の警報状態タグは projection としてなら公開してよく、正本にはしない。
- §11.2（2026-10-08 オーナー決定）: HH／H／L／LL のしきい値は使う側（SCADA）が持って判定する。Hub は持たず、判定もしない。判定に使ったしきい値はイベントに残す。
- §11.3: 状態の候補は Normal／Pending／ActiveUnacked／ActiveAcked／ReturnedUnacked／Shelved。定義の候補は source、severity、message、deadband、on delay、off delay、latch、enabled。設定 UI は単純な条件から始めてよい。
- §11.4: ACK／Shelve は Engine の操作者の状態で、PLC の ACK bit・リセットとは初版で結合しない。
- §11.6・§21 S10: Engine は独立 crate の候補（`banto-alarm`）で、host は SCADA server core（S9b の上の v1.1）。
- Hub はしきい値・警報 API・警報イベントを持たない。タグの属性は単位・小数桁・書込可否だけ。
- 上流 Issue tyaro/banto-industrial#725（警報の評価の場所）は open のまま。§11.2 の決定より前の整理で、この設計は §11.2 に従う。

この repo（[統合設計](../scada-integrated-design.md)§6、[開発計画](../../project/development-plan.md)）:

- 警報の評価・ACK・警報イベントは SCADA server の責務。Historian とは論理的に分ける。Historian の障害や履歴の照会で、警報の評価を止めない。
- 警報 ACK は設備操作と同じ列にある（[アクセス方針](access-policy.md)）。運用・未ログインでは不可。
- 点滅は既定で使わず、動きを減らす OS 設定へ追従する（[フロントエンド UX 設計](../editor/frontend-ux-design.md)）。色と文字の両方で状態を示す。

ユーザー決定（2026-11-14）:

- 評価は製品 host（Tauri の埋込 host。Historian の記録と同じプロセス）に暫定で置く。評価の本体は独立 crate にして、後で SCADA server core へ移せる形にする。
- 発生元はしきい値（数値タグの HH／H／L／LL）と bit（true／false で警報）の両方。
- PLC 側でしきい値を判定する案件では、PLC が最終的に bit を立てるので、その bit を bit の定義で警報にし、SCADA のしきい値の定義は作らない（PLC 側だけを使う）。どちらで判定するかは案件・信号ごとに利用者が決め、同じ警報を両方で定義しないよう Designer で重複を検出する仕組みは作らない。

## 3. モデル（Project）

Project 直下の任意の `alarms`。schemaVersion は据え置く（リリース前の Project は後方互換を保証しない）。

```jsonc
"alarms": {
  "blinkUnacked": false,              // 任意。§7
  "definitions": [
    {
      "id": "<UUID v7>",
      "name": "T-101 温度",             // 帯・履歴に出す名前（1〜100文字）
      "enabled": true,
      "source": {
        "kind": "threshold",
        "tag": "PLANT.T101.PV",          // タグの外部名
        "limits": {                       // 1つ以上。HH ≥ H > L ≥ LL を検査
          "hh": { "value": 95, "severity": "high", "message": "温度 異常高" },
          "h":  { "value": 85, "severity": "medium" },
          "l":  { "value": 5,  "severity": "medium" }
        },
        "deadband": 1.0                   // 任意。復帰は限界から deadband 戻ったとき
      },
      "onDelayMs": 0,                     // 任意。0〜600000
      "offDelayMs": 0
    },
    {
      "id": "<UUID v7>",
      "name": "P-201 一括故障",
      "enabled": true,
      "source": { "kind": "bit", "tag": "PLANT.P201.FAULT", "activeWhen": true },
      "severity": "high",
      "message": "ポンプ 一括故障"
    }
  ]
}
```

- 状態を持つ単位（condition）は、しきい値なら定義×限界（`<定義id>:hh` など）、bit なら定義そのもの。
- severity は `high`／`medium`／`low` の3段にする（色と並び順に使う）。数値の重要度は後で必要になったら足す。
- message は任意で、無ければ「名前＋限界の名前」を出す。
- 検査: タグの外部名の形式、限界の順序、bit の定義で bit 型以外のタグを、しきい値の定義で数値型（i16〜f64）以外のタグを指していないこと（型はタグ一覧があるときだけ）、名前と id の重複。実行時に型の合わない値（しきい値の定義で数値でない値、bit の定義で bool でない値）が届いたら、その condition を評価不能（理由は「型不一致」）にする。
- しきい値の限界は、それぞれ独立した condition として評価する。値が HH を超えれば H も成立し、両方が発生する（上位の限界で下位を抑えない）。表示の優先は §7。
- 編集: 「プロジェクト設定」に「警報の設定」を置き、一覧の表で編集する（追加・複製・削除・有効の切替）。Undo／Redo に乗せる。

## 4. 評価と状態

評価は新しい crate `crates/scada-alarm` に置く。入出力を持たない純粋な状態機械で、時刻と読取値を受けて状態とイベントを返す。全入力×全状態の遷移表を 3-A の fixture（`examples/alarm-cases.json`）に置き、これを正本にする。

### 4.1 condition の状態

condition は次の直交した値の組で持つ。表示に使う 5 つの状態はここから導く。

| 値          | 意味                                                                    |
| ----------- | ----------------------------------------------------------------------- |
| active      | 発生中か（delay を満了して確定したもの）                                |
| occurrence  | 発生の回の番号。condition ごとに発生のたびに 1 増える                   |
| acked       | 現在の回を確認済みか（発生の前は確認済み扱い）                          |
| timer       | なし／発生待ち（on delay の開始時刻）／復帰待ち（off delay の開始時刻） |
| unavailable | 評価不能の理由（無ければ評価できている）                                |

| 表示の状態      | active | acked | 補足                                                        |
| --------------- | ------ | ----- | ----------------------------------------------------------- |
| Normal          | false  | true  | timer が発生待ちなら Pending                                |
| ActiveUnacked   | true   | false |                                                             |
| ActiveAcked     | true   | true  |                                                             |
| ReturnedUnacked | false  | false | 発生待ちでも ReturnedUnacked と出し、「再発生待ち」を添える |

### 4.2 遷移

- 条件が成立し、発生中でない: 発生待ちを始める（on delay が 0 ならすぐ満了）。満了したら active を true、occurrence を 1 増やし、acked を false にして「発生」のイベントを書く。ReturnedUnacked からの再発生も同じで、新しい回になる。
- 発生待ちの間に条件が不成立になった: 待ちを捨てる。イベントは書かない。
- 条件が不成立になり、発生中: 復帰待ちを始める（しきい値は deadband を戻ったとき）。満了したら active を false にして「復帰」のイベントを書く。acked はそのまま（確認済みなら Normal、未確認なら ReturnedUnacked）。
- 復帰待ちの間に条件がまた成立した: 待ちを捨てる。
- ACK（condition, occurrence）: occurrence が現在の回と同じで未確認のときだけ受け、acked を true にして「ACK」のイベントを書く。違えば「別の回」として拒否する。評価不能の間も、待ちの間も ACK できる。
- 評価不能になった: active と acked は変えず、待ちを捨てる。評価不能が解けたら、新しい値でその時点から判定し直す（delay は最初から数える）。古い値や欠けた値で発生・復帰させない。
- 無効化・定義の変更・削除は §5.2 の一つの規則で扱う。

### 4.3 時刻と値の順序

- delay は単調時計で測る。壁時計が後戻り・飛びをしても delay は壊れない。
- イベントには壁時計の時刻と、DB の通番を付ける。並び（履歴の順、帯の「新しい順」）は通番で決める。
- Hub の source timestamp は値に付いていれば参考の列として残すが、判定や並びには使わない（無いことも後戻りもある。[SDK 設計](../../upstream/industrial/banto-tagclient-design.md)§3.2）。
- 判定に使った限界の値・deadband・読んだ値をイベントに残す。

### 4.4 評価不能と鮮度

Hub の購読は on-change 配信で、値も品質も変わらなければ何も届かない（SDK 設計§4.5）。最後に値を受けた時刻からの経過では鮮度を判定しない（変わらない正常な信号を評価不能にしてしまう）。

| 理由       | 起こるとき                                               | 単位      |
| ---------- | -------------------------------------------------------- | --------- |
| 未接続     | SDK の接続が Live でない（切断・再接続中・再bind中）     | Engine    |
| 受信の途絶 | 明示の読み直し（下記）が期限内に返らない                 | Engine    |
| 更新停止   | 品質 Stale（Hub の判定）                                 | condition |
| 不良       | 品質 Bad（Hub の判定）                                   | condition |
| 未解決     | タグの外部名が catalog に無い（削除・改名）              | condition |
| 値なし     | 品質は Good だが値が無い                                 | condition |
| 型不一致   | しきい値の定義で数値でない値、bit の定義で bool でない値 | condition |
| 非有限     | NaN・無限大                                              | condition |

- 明示の読み直し: Engine は一定の周期（端末の設定）で、使うタグの現在値を REST で読む。これは生存の確認に使う。読んだ値は、購読で受理済みの値より新しい source timestamp を持つときだけ値として使う（応答待ちの間に購読で届いた新しい値を古い値で巻き戻さない）。
- 「Engine」単位の理由（未接続・受信の途絶）は、すべての condition を評価不能にするが、イベントは Engine 単位の 1 件（「接続の喪失」「接続の回復」）だけを書く。接続の揺れで condition ごとのイベントが溢れ、件数の保持で本物の警報が押し出されないようにする。
- 「condition」単位の理由は、condition ごとに評価不能の始まりと終わりのイベントを書く。
- Bad を 0 や false に置き換えない。
- 認証の失効（SDK の Unauthorized。再接続しない）は評価不能ではなく、Engine の停止として扱う（§5.1）。

## 5. 製品hostの警報Engine

### 5.1 寿命と session

- `scada-host` に警報の runtime を置く。Hub の読取は、画面の表示の購読とは別に、警報の定義が使うタグだけを自分で購読する（Historian の記録元 `SdkRecorderSource` と同じく、UI の開閉に寿命を結ばない）。
- 評価は読取の更新ごとに行い、delay の判定のために 1 秒ごとの tick も入れる。
- 動くのはデスクトップ版のアプリが起動し、Hub に接続し、定義を適用している間だけ。アプリを閉じれば止まる（24/365 の常駐は後続。§8）。
- session は Engine を始めてから止めるまで。次のときに session を閉じて（「Engine の停止」を書いて）、必要なら新しい session を始める: 別の Project（`projectId` が違う）の定義の適用、Hub の接続先の変更、認証の失効（理由を示し、Hub に接続し直すと再開する）、アプリの終了。同じ接続先での切断と再接続は session を閉じない（§4.4 の「未接続」）。
- 同じ PC で 2 つ目のプロセスが同じ Project の警報 DB を開こうとしたら、DB の排他 lock（Historian の記録 DB と同じ方式）で拒み、2 つ目では Engine を動かさずに理由を示す。

### 5.2 定義の適用

- host は Designer の編集中の内容も、Project のファイルの保存も知らない（保存は webview の書出しで、ファイルの書込みの完了を host は確かめない）。そこで「保存した Project の定義」（§9-1）は、デスクトップ版で **保存の操作をした時点の Project** とし、保存の操作のあと webview が `alarm_apply` でその Project を host へ渡す。Project を開いたときも同じく渡す。保存していない編集は評価に使わない。
- `alarm_apply` は、運用では設定変更と同じ権限（ログイン済みの Admin）を要る。開発・初期設定ではログイン不要。host は定義を検査し、通らなければ前の定義のまま理由を返す。
- `alarm_snapshot` に、適用中の `projectId`・`projectRevision`・適用の時刻を入れる。編集中の Project と適用中の定義が違うことを画面が示せるようにする。
- 定義が変わったら、id が同じで評価に関わる内容（発生元の種類・タグ・`activeWhen`・限界の値・deadband・on／off delay）が変わらない condition だけ状態を引き継ぐ。名前・message・severity だけの変更は引き継ぐ。
- 評価に関わる内容が変わった condition と、無効にした（`enabled: false`）condition と、消えた condition は、一つの規則で扱う: 「定義の変更」（消えたものは「定義の削除」）のイベントを残して状態を捨て、「最後の状態」の行も消す。ACK を別の信号へ移さない。評価に関わる内容が変わったものと有効に戻したものは、新しい condition として Normal から評価する（すでに異常なら新しい ActiveUnacked になり、ブザーも鳴る）。

### 5.3 警報 DB

- 警報イベントは、Historian の記録 DB とは別の SQLite（`%LOCALAPPDATA%\temp-scada` の下、Project の `projectId` ごとに別のファイル）に追記する。「最後の状態」の表も同じファイルに置き、別の Project の警報が混ざらないようにする。
- イベントの種類: 発生・復帰・ACK・condition の評価不能の始まりと終わり・接続の喪失と回復・定義の変更・定義の削除・Engine の開始と停止・停止時の状態・前回の終了時の状態。各イベントに通番、壁時計の時刻、Engine の session id を付ける。ACK には利用者名を付ける（開発・初期設定では「未ログイン」）。
- 保持の上限は PC の性能によるので、端末（host）の設定で「日数」か「件数」を選んで値を入れ、上限を超えた古いものから通番の順に消す。Project には持たない。既定値は 3-C で決める。1 回に消す件数に上限を置き、壁時計が先へ飛んでも一度に全部を消さない。
- 書込みに失敗したら（満杯など）、評価と ACK は続け、`alarm_snapshot` に「履歴に書けない」と失敗の件数を出し、一定の間隔で書き直しを試す。DB を開けない・lock を取れないときは Engine を動かさず理由を示す。

### 5.4 再起動と前回の終わり

- アプリの再起動で状態は Normal から評価し直す（評価の状態を復元はしない）。そのかわり、前回の session の終わりを履歴で確かめられるようにする。
- 正常に止めるときは、Normal でない condition と評価不能の condition ごとに「停止時の状態」を書いてから「Engine の停止」を書く。
- 起動時は「Engine の開始」を書く。その Project の直前の session（最後に「Engine の開始」を書いた session）に「Engine の停止」が無ければ（強制終了・電源断）、「最後の状態」の表のうち、その session id で Normal でないものだけを「前回の終了時の状態（停止の記録なし）」として書く。
- 「最後の状態」の表: condition ごとに §4.1 の値（active・occurrence・acked・unavailable）と最後のイベントの通番・session id を 1 行持ち、イベントの追記と同じ transaction で更新する。イベントの保持の上限による削除の対象にしない。発生のイベントが保持の上限で消えても、前回の終了時の状態はこの表から書ける。
- これにより、未確認のまま終わった警報は履歴の「前回の終了時の状態」と「停止時の状態」で判別できる。

### 5.5 IPC

browser 版（モックの読取）は Engine を持たない。e2e 用に、IPC の境界でモックの警報 service を差し込めるようにする。

| 名前                                       | 内容                                                                                                                                         |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `alarm_apply`                              | Project を渡して定義を適用する（§5.2 の権限）。結果と理由                                                                                    |
| `alarm_snapshot`                           | 全 condition の §4.1 の値、Engine の状態（動作中・停止中と理由・未適用）、適用中の Project、「履歴に書けない」、ブザー停止の状態、変更の通番 |
| `alarm_changed`（event）                   | 変わった condition と新しいイベント、変更の通番。画面は snapshot の通番以下の event を捨て、通番が飛んだら snapshot を取り直す               |
| `alarm_ack`                                | (condition id, occurrence) の列を ACK する（§6 の権限）。1 件ずつ結果（受理・別の回・確認済み・無い）を返す                                  |
| `alarm_buzzer_silence`                     | その端末のブザーを止める（§6）                                                                                                               |
| `alarm_history`                            | 期間・種類で警報イベントを照会する。新しい順で、続きは通番のカーソルで取る                                                                   |
| `alarm_settings_get`／`alarm_settings_set` | 端末の設定（保持の上限、読み直しの周期と期限、音のファイル）。設定は運用では Admin だけ                                                      |

## 6. ACK とブザー停止

- ACK は Engine の操作で、PLC の bit には書かない。
- 権限: 開発・初期設定ではログイン不要（利用者名は「未ログイン」）。運用ではログイン済みの Admin だけ。認証の DB が使えないときは拒否する（[アクセス方針](access-policy.md)）。役割の追加は後続。
- ACK は見ている回を指す: 一覧で選んだ行の (condition id, occurrence) を送り、表示の後に復帰→再発生した新しい回は ACK しない。「すべて ACK」は、画面が持っている最新の snapshot に出ている未確認の回だけを送る。
- ブザー停止は、その端末の音を止めるだけで、ACK ではない。権限は要らない。止めた状態は host が持つ（webview の再読込や複数の窓でも揃う）。新しい回が発生すると、また鳴る。
- 音は未確認（ActiveUnacked）の回があるあいだ鳴らす。鳴らすのは host（Rust）で、WebView の自動再生の制限を受けないようにする（3-E の前に実機で確かめる）。既定はアプリに同梱する短い音で、端末（host）の設定で別の音声ファイルに変えられる（既定に戻せる）。Project には持たない。ファイルが読めないときは同梱の音で鳴らし、理由を示す。

## 7. 表示

新しい primitive（画面の直下と Symbol 定義の中のどちらに置けるかは各項目に書く）:

- **警報の小札** `alarmBadge`: 定義の id と限界（しきい値なら hh／h／l／ll、bit なら無し）を指す。PLC が判定して HH などの bit を立てる案件では、小札が bit の定義を指し、文字に「HH」などを入れる。画面の直下に置く（Symbol 定義の中は §8）。
  - 検査（§3 の検査に足す）: 指す定義と限界が Project にあること。無ければ検査で拒む。
  - 色は状態ごと: Normal・発生中・未確認（発生中）・復帰・未確認・評価不能。未確認は、点滅しなくても分かるよう文字の枠（反転）で示す。発生中で評価不能が重なったら、発生中の色に「?」の印を添える（発生中を隠さない）。
  - Engine が動いていない（停止中・未適用）か、指す condition が適用中の定義に無い（保存前の新しい定義など）ときは、Normal の色ではなく「不明」の色と斜線で示す。「警報なし」と読めないようにする。
  - 点滅は §2 の UX の規則どおり既定では使わず、Project の `alarms.blinkUnacked: true` で未確認の間だけ点滅させられる。その場合も OS の「動きを減らす」設定では点滅を止め、枠の表示だけにする。
- **最新の警報の帯** `alarmBanner`: 1 件を次の優先で選ぶ。未確認（ActiveUnacked か ReturnedUnacked）を確認済みより先に、その中で severity の高い順、同じなら同じ定義の上位の限界（HH を H より、LL を L より）、それでも同じなら新しい順（通番）。選んだ 1 件を、復帰済みなら「復帰」と添えて「時刻・名前・メッセージ」で出し、件数を添える。画面の直下に置く。運転表示の枠のヘッダーに置く想定。Engine が動いていないときは空にせず「警報 停止中（理由）」を出す。
- **画面切替ボタンの行き先の追加**: `navButton` の行き先に「アラーム一覧を開く」「ブザー停止」を足す（書込みを伴わない端末内の操作なので、ボタンを新設しない）。

アラーム一覧の窓（運転表示とプレビューから開く。トレンド履歴の窓と同じく、運転表示の中に描く）:

- 「現在」タブ: Normal でない condition（ActiveUnacked・ActiveAcked・ReturnedUnacked）と、評価不能の condition（状態が Normal でも）を出す。評価不能は状態とは別の列に §4.4 の理由を文字で出し、絞り込みで評価不能だけも見られる。復帰済みでも ACK するまでは残し、状態の列で「発生中」「復帰・未確認」を文字で分ける。未確認を上に、severity と通番の順。選んで ACK、すべて ACK（ReturnedUnacked も対象。§6）。ACK の結果が「別の回」なら、その行を最新に取り直して示す。
- 「履歴」タブ: 警報イベントの照会（期間・種類）。判定の限界と値、source timestamp を列に出す。
- Engine が動いていない（browser 版・Hub 未接続・未適用・認証の失効・DB を開けない・別のプロセスが使用中）ときと、「履歴に書けない」ときは、その理由を出す。編集中の Project と適用中の定義の revision が違うときも示す。

Designer の編集モードとプレビューは、Engine の状態を読むだけで、小札と帯にも同じ状態を出す。

## 8. 後続（この段階で作らない）

- 機器種別の slot に警報の雛形（しきい値の種類・message）を持たせ、機器インスタンスで値を入れる形。Symbol 定義の中の小札は、これと合わせて設計する。
- Shelve、latch、PLC の ACK・リセットとの連動（明示 Action）。
- 常駐（Windows サービス・トレイ）と、SCADA server core（S9b）への Engine の移設。
- 複数端末での ACK の共有、冗長化（上流 §22 で未決）。
- 警報の Replay、印刷。
- 警報の状態をタグとして Hub に返すこと（上流 §11.1 の projection）。
- ワード割付の状態（語の値、語の中の bit）を警報の発生元にすること。当面は PLC の bit か数値のしきい値だけを発生元にする。

## 9. 確認したこと（2026-11-14 回答）

1. 評価に使う定義は、保存した Project の定義にする（推奨のまま）。host は保存を知らないので、保存の操作の後に webview が `alarm_apply` で渡す（§5.2）。
2. ACK は、運用ではログイン済みの Admin だけに許す（推奨のまま）。
3. severity は 3 段（high／medium／low）にする（推奨のまま）。
4. 警報イベントの保持の上限は PC の性能によるので、日数か件数で設定できるようにする（§5）。
5. ブザーの音は、既定を同梱の音にし、変更できるようにする（§6）。
6. PLC 側で判定する場合は、PLC の bit だけを使う（§2）。

## 10. PR の区切り（案）

| 区切り | 内容                                                                                                   |
| ------ | ------------------------------------------------------------------------------------------------------ |
| 3-A    | `scada-alarm` crate（§4 の状態機械・イベント・全遷移の fixture）。入出力なし                           |
| 3-B    | Project の `alarms`（schema・Rust・TS・検査・サンプル）と「警報の設定」の編集                          |
| 3-C    | 製品 host の Engine（専用の購読・鮮度の確認・適用・警報 DB・IPC）。Tauri の command／event             |
| 3-D    | 表示: `alarmBadge`・`alarmBanner`、モックの警報 service、e2e                                           |
| 3-E    | アラーム一覧の窓・ACK・ブザー停止（host で鳴らす）・`navButton` の行き先の追加、運転表示のヘッダーの例 |

各区切りの検証は [差分文書§5.5](../editor/flow-diagram-gap-2026-11-12.md#55-各-pr-の検証) に従う。3-C は Tauri 実機と実 Hub の確認が要り、ブラウザの e2e では Engine を通らない。
