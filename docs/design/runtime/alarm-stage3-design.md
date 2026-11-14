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
- 検査: タグの外部名の形式、限界の順序、bit の定義で bit 型以外のタグを指していないこと（タグ一覧があるときだけ）、名前と id の重複。
- 編集: 「プロジェクト設定」に「警報の設定」を置き、一覧の表で編集する（追加・複製・削除・有効の切替）。Undo／Redo に乗せる。

## 4. 評価と状態

評価は新しい crate `crates/scada-alarm` に置く。入出力を持たない純粋な状態機械で、時刻と読取値（値・品質・時刻）を受けて状態とイベントを返す。

状態:

| 状態            | 意味                               | 次の状態                                            |
| --------------- | ---------------------------------- | --------------------------------------------------- |
| Normal          | 条件を満たしていない               | 条件成立 → Pending（on delay あり）か ActiveUnacked |
| Pending         | 条件成立から on delay を待っている | 待ち切る → ActiveUnacked、不成立 → Normal           |
| ActiveUnacked   | 発生中・未確認                     | ACK → ActiveAcked、復帰 → ReturnedUnacked           |
| ActiveAcked     | 発生中・確認済み                   | 復帰 → Normal                                       |
| ReturnedUnacked | 復帰したが未確認                   | ACK → Normal、再発生 → ActiveUnacked                |

- 復帰は off delay を待ってから判定する。しきい値の復帰は deadband を戻ったとき。
- 品質が Good でない（更新停止・不良・未接続）ときは、状態を変えずに condition に「評価不能」を付ける。Bad を 0 や false に置き換えない。評価不能の始まりと終わりもイベントにする。
- 無効（`enabled: false`）の定義は評価せず、状態を Normal に戻すイベントを残す。
- 判定に使った限界の値・deadband・読んだ値をイベントに残す。

## 5. 製品hostの警報Engine

- `scada-host` に警報の runtime を置く。Hub の読取は、画面の表示の購読とは別に、警報の定義が使うタグだけを自分で購読する（Historian の記録元 `SdkRecorderSource` と同じく、UI の開閉に寿命を結ばない）。
- 評価は読取の更新ごとに行い、delay の判定のために 1 秒ごとの時刻の tick も入れる。
- 動くのはデスクトップ版のアプリが起動し、Hub に接続し、Project を開いている間だけ。アプリを閉じれば止まる（24/365 の常駐は後続。§8）。
- 評価に使う定義は、Designer の編集中の内容ではなく、**保存した Project の定義**にする。定義が変わったら、id が同じで評価に関わる内容（発生元の種類・タグ・`activeWhen`・限界の値・deadband・on／off delay・有効）が変わらない condition だけ状態を引き継ぐ。名前・message・severity だけの変更は引き継ぐ。評価に関わる内容が変わった condition は、ACK を別の信号へ移さないよう「定義の変更」のイベントを残して状態を捨て、Normal から評価し直す（すでに異常なら新しい ActiveUnacked になり、ブザーも鳴る）。消えた condition は「定義の削除」のイベントを残して捨てる。
- 警報イベントは、Historian の記録 DB とは別の SQLite（`%LOCALAPPDATA%\temp-scada` の下）に追記する。種類は発生・復帰・ACK・評価不能の始まりと終わり・定義の変更・定義の削除。保持の上限は PC の性能によるので、端末（host）の設定で「日数」か「件数」を選んで値を入れ、上限を超えた古いものから消す。Project には持たない。既定値は 3-C で決める。
- アプリの再起動で状態は Normal から評価し直す。未確認のまま閉じた警報は、イベントの記録から「未確認のまま終了」と読めるようにする。
- browser 版（モックの読取）は Engine を持たない。e2e 用に、IPC の境界でモックの警報 service を差し込めるようにする。

IPC（Tauri command／event）:

| 名前                     | 内容                                                         |
| ------------------------ | ------------------------------------------------------------ |
| `alarm_snapshot`         | 全 condition の現在の状態と、評価が動いているか              |
| `alarm_changed`（event） | 状態が変わった condition と、新しいイベント                  |
| `alarm_ack`              | condition の id の列を ACK する（§6 の権限）                 |
| `alarm_history`          | 期間・件数・種類で警報イベントを照会する（新しい順、ページ） |

## 6. ACK とブザー停止

- ACK は Engine の操作で、PLC の bit には書かない。
- 権限: 開発・初期設定ではログイン不要。運用ではログイン済みの Admin だけ。役割の追加は後続。ACK のイベントに利用者名を残す。
- ブザー停止は、その端末の音を止めるだけで、ACK ではない。権限は要らない。新しい警報が発生すると、また鳴る。
- 音は ActiveUnacked の condition があるあいだ鳴らす。既定はアプリに同梱する短い音で、端末（host）の設定で別の音声ファイルに変えられる（既定に戻せる）。Project には持たない。ファイルが読めないときは同梱の音で鳴らし、理由を示す。

## 7. 表示

新しい primitive（画面の直下と Symbol 定義の中のどちらに置けるかは各項目に書く）:

- **警報の小札** `alarmBadge`: 定義の id と限界（しきい値なら hh／h／l／ll、bit なら無し）を指す。PLC が判定して HH などの bit を立てる案件では、小札が bit の定義を指し、文字に「HH」などを入れる。文字（しきい値の既定は「HH」など）と、状態ごとの色（Normal・発生中・未確認・評価不能）。未確認の間は点滅する。点滅は「動きを減らす」設定では止め、文字の枠で代える。画面の直下に置く（Symbol 定義の中は §8）。
- **最新の警報の帯** `alarmBanner`: 最も新しい ActiveUnacked（無ければ ActiveAcked）の 1 件を「時刻・名前・メッセージ」で出し、件数を添える。画面の直下に置く。運転表示の枠のヘッダーに置く想定。
- **画面切替ボタンの行き先の追加**: `navButton` の行き先に「アラーム一覧を開く」「ブザー停止」を足す（書込みを伴わない端末内の操作なので、ボタンを新設しない）。

アラーム一覧の窓（運転表示とプレビューから開く。トレンド履歴の窓と同じく、運転表示の中に描く）:

- 「発生中」タブ: 未確認を上に、severity と時刻の順。選んで ACK、すべて ACK。
- 「履歴」タブ: 警報イベントの照会（期間・種類）。判定の限界と値を列に出す。
- 評価が動いていない（browser 版・Hub 未接続・Project 未保存）ときは、その理由を出す。

Designer の編集モードとプレビューは、Engine の状態を読むだけで、小札と帯にも同じ状態を出す。

## 8. 後続（この段階で作らない）

- 機器種別の slot に警報の雛形（しきい値の種類・message）を持たせ、機器インスタンスで値を入れる形。Symbol 定義の中の小札は、これと合わせて設計する。
- Shelve、latch、PLC の ACK・リセットとの連動（明示 Action）。
- 常駐（Windows サービス・トレイ）と、SCADA server core（S9b）への Engine の移設。
- 複数端末での ACK の共有、冗長化（上流 §22 で未決）。
- 警報の Replay、印刷。
- 警報の状態をタグとして Hub に返すこと（上流 §11.1 の projection）。

## 9. 確認したこと（2026-11-14 回答）

1. 評価に使う定義は、保存した Project の定義にする（推奨のまま）。
2. ACK は、運用ではログイン済みの Admin だけに許す（推奨のまま）。
3. severity は 3 段（high／medium／low）にする（推奨のまま）。
4. 警報イベントの保持の上限は PC の性能によるので、日数か件数で設定できるようにする（§5）。
5. ブザーの音は、既定を同梱の音にし、変更できるようにする（§6）。
6. PLC 側で判定する場合は、PLC の bit だけを使う（§2）。

## 10. PR の区切り（案）

| 区切り | 内容                                                                                  |
| ------ | ------------------------------------------------------------------------------------- |
| 3-A    | `scada-alarm` crate（状態機械・イベント・fixture）。入出力なし                        |
| 3-B    | Project の `alarms`（schema・Rust・TS・検査・サンプル）と「警報の設定」の編集         |
| 3-C    | 製品 host の Engine（専用の購読・評価・イベント DB・IPC）。Tauri の command／event    |
| 3-D    | 表示: `alarmBadge`・`alarmBanner`、モックの警報 service、e2e                          |
| 3-E    | アラーム一覧の窓・ACK・ブザー停止・`navButton` の行き先の追加、運転表示のヘッダーの例 |

各区切りの検証は [差分文書§5.5](../editor/flow-diagram-gap-2026-11-12.md#55-各-pr-の検証) に従う。3-C は Tauri 実機と実 Hub の確認が要り、ブラウザの e2e では Engine を通らない。
