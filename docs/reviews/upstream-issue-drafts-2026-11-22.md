# 上流への起票・コメントの下書き（2026-11-22）

状態: **起票済み（2026-11-22）**。I1 → banto-industrial#1293、I2 → #1294、I3 → #1295、B1 → banto#794、B2 → banto#795、B3 → banto#796。C1 は banto#791、C2 は banto-industrial#725 にコメントした。本文は起票時のもの。根拠は [精査の §9](upstream-placement-audit-2026-11-22.md#9-起票の精査2026-11-22ソースで確かめた結果)。行番号は banto-industrial `20a8b464`、Banto v7.11.0、temp-scada `ebe95d80` のもの。

---

## I1 banto-industrial

**題**: banto-tagclient: 書込みの誤りに、Hub が返す理由の code・`audit_id`・`correlation_id` を持たせる

### 背景

Hub は書込みの誤りの応答の本文に、理由の code（`not_writable`・`rate_limited`・`write_failed` など）と、監査の行を作った後なら `audit_id`、受けていれば `correlation_id` を入れて返します（`apps/banto-hub/core/src/rest/write.rs:189-196`、#1201）。

tagclient の `Error` は `kind` だけを持つ `Copy` の型なので（`crates/banto-tagclient/src/error.rs:142`）、これらは利用側に届きません。

- 404・409・422・429・501（送る前に断った）と 502 `write_failed`（送って失敗が確定した）が、どちらも `ErrorKind::WriteRejected` になります（`write.rs` の 502 と 4xx の対応）。
- 誤りの `audit_id` が取れないので、利用側の記録を Hub の書込み監査と突き合わせられません。`WriteReceipt` の `audit_id` は成功のときだけです。

temp-scada の段階 3 の操作では、`WriteRejected` を「送ったかどうか分からないが成立していない」として扱い、画面の文言を「成立していません」にまとめています（`crates/scada-host/src/operation_db.rs:115-133`）。また操作の記録の `audit_id` の列は、成功の行にしか入りません。

### 提案

- `write_tag` の `Err` から、Hub の理由の code（文字列、知らない値もそのまま）・`audit_id`・`correlation_id` を読めるようにする。例: `Error::write_detail() -> Option<&WriteErrorDetail>`。`Error` の `Copy` をやめるか、詳細は別の型で返すかは banto-tagclient の判断に任せます。
- 少なくとも「送る前に断った」と「送って失敗が確定した」を、`kind` か詳細で分ける。
- 機密に関わる値（URL・本文の自由文・ヘッダ）は今までどおり持たない。

### 回り道

temp-scada は今の分類（`WriteRejected` → 成立していない）のままにします。安全側なので急ぎませんが、tyaro/temp-scada#311・#312（フェースプレート・設定値の書込み）の前に入ると、利用者への説明と監査の突き合わせが正確になります。

---

## I2 banto-industrial

**題**: banto-tagclient: Live の間も定期的に `ping` を送り、`pong` が来なければ切れたとみなす

### 背景

on_change の購読は、値が変わらなければ何も届きません。そのため利用側は、Live のまま購読が無言で止まった（途中の経路で切れたが、close が届かない）のと、値が変わらないだけのときを見分けられません。

Hub は `{"op":"ping"}` に `pong` を返します（`apps/banto-hub/core/src/stream.rs:755`）。tagclient が `ping` を送るのは、Unbound を出す前の確認のときだけです（`crates/banto-tagclient/src/worker.rs:543` 付近）。

temp-scada の警報の評価は、この無言の停止を見分けるために、REST で値を読み直して比べています（`crates/scada-host/src/alarm_runtime/freshness.rs`、約 580 行。設計 `docs/design/runtime/alarm-stage3-design.md` §4.5）。読み直しで値が前と同じなら、停止を見逃す制約も残っています。

### 提案

- Live の間、決まった間隔（例: 10 秒）で `ping` を送り、期限（例: 5 秒）までに `pong`（またはほかの受信）が無ければ接続を切って、今までの再接続（backoff）に乗せる。
- 間隔と期限は設定で変えられるようにし、既定は Hub の負荷に合わせて決める。
- 切ったことを利用側が知れるようにする（今の接続の状態の変化で足りるなら、それで構いません）。

### 回り道

temp-scada は REST での読み直しを続けます。入れば読み直しの頻度を下げ、`freshness.rs` を小さくできます。

---

## I3 banto-industrial

**題**: banto-hub・banto-tagclient: 設置ごとに変わらない Hub の id を `status` で返す

### 背景

`GET /api/v1/status` の応答には `version`・`capabilities`・`run_id` などがありますが（`apps/banto-hub/core/src/rest/tag_space.rs:937-` の `StatusResponse`）、`run_id` は起動ごとに変わります。同じ Hub か（別の Hub に差し替えられていないか）を示す、設置ごとに変わらない id はありません。tagclient の `HubStatus` が読むのは `version`・`capabilities` だけです（`crates/banto-tagclient/src/types.rs:247`）。

temp-scada は接続先を、保存した endpoint の文字列の完全一致で見分けています（警報の DB の接続先、書き用キーと接続先の組）。同じ URL のまま別の Hub に置き換えると、変わったことに気づけません（`docs/design/runtime/alarm-stage3-design.md` §5.2）。

### 提案

- Hub がデータの置き場を初めて作るときに id（例: UUID）を作って保存し、`status` で返す。バックアップから戻したときに引き継ぐかどうかも決める。
- tagclient の `HubStatus` に、その id と `run_id` を載せる。

### 回り道

temp-scada は endpoint の完全一致を続けます。表記が違えば別の接続先とみなす安全側の扱いです。

---

## B1 Banto

**題**: theme: ダークで Toast の背景が透けて、下の画面が見える

### 背景

ダークの `--banto-danger-tint`・`--banto-success-tint`・`--banto-warning-tint` は `color-mix(in srgb, var(--banto-*-tint-text) 18%, transparent)` です（`packages/theme/src/css/banto.css:552-556`）。`ToastHost` はこれをそのまま `.toast` の背景にするので（`packages/ui/src/ToastHost.svelte` の `.toast.success` などの `background`）、ダークでは Toast の下の画面が透けて見えます。重なった文字のせいで通知が読みにくくなります。ライトの tint は不透明な色なので、起きるのはダークだけです。

info の Toast は `color-mix(... var(--banto-primary) 16%, var(--banto-surface-overlay))` で、不透明な面と混ぜているので透けません。

### 提案

- Toast の背景を、不透明な面（`--banto-surface-overlay`）の上に tint を重ねる形にする。例: `background: linear-gradient(var(--banto-*-tint), var(--banto-*-tint)), var(--banto-surface-overlay)`。
- ほかに、ダークの tint を浮かぶ部品の背景に使っている所があれば、同じように直す。

---

## B2 Banto

**題**: theme: `--banto-warning` と `--banto-chart-2` が、両テーマで見分けにくい近い橙

### 背景

| テーマ | `--banto-warning`                          | `--banto-chart-2`   |
| ------ | ------------------------------------------ | ------------------- |
| ライト | `oklch(0.555 0.132 58)`（`banto.css:339`） | `#da7306`（`:373`） |
| ダーク | `oklch(0.769 0.165 70)`（`:506`）          | `#f48815`（`:514`） |

どちらのテーマでも色相が近い橙です。temp-scada のトレンドでは、管理線を越えた区間を `--banto-warning` で示すので、2 本目のペンと見分けにくくなります。警報の一覧でも、注意の色とグラフの色が同じ画面に並びます。

### 提案

- 状態の色（warning）とチャートの系列の色が同じ画面に並んでも見分けられるよう、どちらかを動かす。系列の色を状態の色の色相から離すのが、意味の上では自然だと考えます。
- 系列の色と状態の色の色差の下限を、theme の試験に足す。

---

## B3 Banto

**題**: dock-svelte: 進行中の操作（divider のドラッグなど）を取り消す公開の口

### 背景

アプリが配置を作り直す前（例: 「標準レイアウトに戻す」）に、利用者が divider をドラッグしていれば、その操作を先に取り消したい場合があります。

`DockHost` は `arrange` が false になると、進行中の操作を `gesture.cancel('api')` で取り消します（`packages/dock-svelte/src/DockHost.svelte:410-420`）。直接取り消す口が無いので、temp-scada は `arrange` を一瞬 false にしてから戻しています（`apps/banto-scada/src/App.svelte:486-491`）。その間は利用者が組み替えられない状態を通るので、意図より広い効果があります。

### 提案

- `DockHost`（または `DockState`）に、進行中の操作を取り消す口を足す。例: `cancelGesture(): boolean`（取り消した操作があれば true）。`onGestureEnd` には今の `'api'` の理由で届く。

急ぎません。

---

## C1 banto#791 へのコメント

temp-scada の Designer（`ThreePaneDock`、tyaro/temp-scada#331 D3）も同じ口を待ちます。

- Designer も幅 1100px 未満で狭い表示へ切り替えるので（`bind:narrow`）、切り替えの途中の `layoutSnapshot()` を保存してしまう、本文の 1 と同じ形になります。
- temp-scada は `dockLayoutStore` を写さず、この Issue の口が入るまで、配置の自動保存は「求める表示と実際の表示が食い違っている間は保存しない」の形で待つか、自動保存そのものを後にします。
- temp-scada の要件:
  - 保存は 1 つのキー。今は `createLocalUiSettings` を使っていて、`getUiSettings` 経由になっても構いません。
  - 「標準レイアウトに戻す」は、保存した配置を消して既定へ戻す。`resetLayout` の後の確定でも、保存の口が呼ばれてほしいです。
  - 最初の基準の前に既定を直す口（本文の `beforeBaseline`）は、今は要りません。
  - 持ち主の照合は今は要りません。認証は延期中で、ローカルの編集はログイン不要です。

## C2 banto-industrial#725 へのコメント

2026-10-08 のオーナーの決定（#533、しきい値は使う側が持ち、Hub は警報を判定しない）で、この Issue の「どこで評価するか」は実質 B（SCADA などの使う側）に決まっていると読めます。

temp-scada は、入出力を持たない純粋な状態機械として `crates/scada-alarm` を実装しました（`step(状態, 入力) -> (次の状態, イベント)`、設計 `docs/design/runtime/alarm-stage3-design.md` §4）。上流設計 §11.6 の `banto-alarm` の候補名に合わせて、industrial へ戻せる配置にしています。

次のどちらかを提案します。

1. この Issue を、#533 の決定を理由に閉じる。
2. 記録計（ChronoGazer）と SCADA の両方が警報を判定するなら、状態機械を共有の crate `banto-alarm` にするかを、この Issue（または新しい Issue）で決める。決まれば、temp-scada の `scada-alarm` を移す元にできます。
