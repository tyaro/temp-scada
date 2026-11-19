# 段階3 運転操作の設計（タグ書込みと実行記録）

状態: **設計（2026-11-19 ユーザー承認）**。2026-11-19 作成、Fable の通しレビュー 19 件を反映。§11 の確認事項は同日、すべて推奨のままと回答を得た。実装は未着手で、O0（#279）から進める。[フロー図の差分](../editor/flow-diagram-gap-2026-11-12.md)§3 の 9（操作）を、上流の書込み契約（tyaro/banto-industrial#1177、2026-11-18 オーナー決定）に合わせて具体化する。Issue [#280](https://github.com/tyaro/temp-scada/issues/280)（書込み Action と実行記録）の範囲を含み、[#279](https://github.com/tyaro/temp-scada/issues/279)（Runtime mode）を前提にする。#280 の本文（ボタン配置から書く、相関 ID は範囲外、404・403 の区別）は、採用に合わせてこの設計へ揃えた（2026-11-19）。

## 1. 目的と範囲

オーナー提供の参照画面の水準の運転画面で、操作者が次を行えるようにする。

- 機器を押して出る操作の小窓（標準 Faceplate）から、運転・停止などの指令と、設定値を書く。
- 書込みの結果（成功・不成立・結果不明・拒否）を画面で区別して見る。結果に関わらず、要求を実行記録に残す。

範囲外: 画面上に自由に置く操作ボタン（§12）、利用者が描く Faceplate 定義（上流 §7.4 の正式 Faceplate）、パルス書込み・連続した手順（Action flow）、常時実行の Event／Action（v1.1 S10b）、HTTP・外部プログラム、Toggle、書込みの自動再試行、複数端末の排他・インターロック判定（PLC 側の責務）。

## 2. 前提

上流（[上流 SCADA 設計](../../upstream/industrial/scada-design.md)はスナップショット 2026-10-01 版。書込み契約と tagclient は上流 main `1ecd0174` の `docs/hub/tag-server-design.md` §6.6 と `crates/banto-tagclient/src/{write,error,rest}.rs`）:

- §9.6: 書込みの宛先は Hub の外部名。書く前に、現在の catalog で名前が解決済み・`writable`・型一致であることを確かめ、満たさなければ送らない（fail-closed）。catalog の再解決中も書かない。改名後に同名の別タグへ届く場合は方針として受容する。書込み要求に期待 revision を付ける拡張は採らない。
- §10.3: 操作者が起こす WriteTag は UI（Runtime）側で実行する。§10.7: PLC への書込みは暗黙に再試行しない。
- §16: 実行前検証で拒否した要求も記録する。SCADA 側に実行記録（execution record）を持ち、Hub の書込み監査と相関 ID で突き合わせる。
- §18: Editor／Runtime は同じ実行ファイルの mode。Runtime mode から Editor の機能に届かないようにし、Rust 側でも mode を確かめる。
- tag-server-design §6.6（書込み契約）:
  1. 相関 ID: 要求に任意の `correlation_id`（1〜64 文字、`[A-Za-z0-9._:-]`）。Hub は重複を排除しない。
  2. 代理の操作者: 任意の `on_behalf_of`（1〜128 文字、制御文字は不可）。Hub は確かめず「申告」として監査に残す。
  3. キー: 端末ごとに読み用と書き用の 2 本。書き用のキーが trip されても購読は続く。書き用のスコープは書くタグの完全一致の列挙。trip の解除は Hub の管理画面。trip は書込みの回数制限でも起きる。
  4. 結果: 成功・送る前の失敗・送って失敗・結果不明の 4 つ。成功は書込み先（実機・シミュレータ・internal タグ）の処理の成功で、PLC が値を保持したことや、設備が運転状態に達したことは意味しない。確かめるのは購読値。
  5. 権限: Banto に、ロールとは別にユーザーへ付ける `equipment.operate`・`alarm.ack` を足す（tyaro/banto#697、2026-11-19 時点で open）。Admin も既定では持たない。判定は SCADA の host（Rust）で行う。
- banto-tagclient（#1202 後の main）: `write_tag(name, value, WriteOptions)` は成功で `WriteReceipt { audit_id: Option<i64>, correlation_id }` を返す（応答の本文が読めないときも成功で、`audit_id` は無い）。誤りは `ErrorKind` だけを持ち、HTTP の status・`error` コード・`audit_id` は返さない。分類は次のとおり（`write.rs` の `classify_write_failure`）。
  - 401 → `Unauthorized`。403 `key_tripped` → `KeyTripped`、ほかの 403 → `WriteForbidden`。503 `writes_disabled`・`collection_not_running` → `WriteUnavailable`、ほかの 503 → `WriteUncertain`。
  - 404・409・422・429・501 と **502 `write_failed`** → `WriteRejected`（送る前の拒否と、送って失敗が同じ種別になる）。
  - 502 `write_uncertain`・code の無い 502・500 `internal`・504・ほかの 5xx・送信後の時間切れや切断 → `WriteUncertain`。
  - 500 `audit_write_failed`・接続できない → `Transport`。3xx → `InvalidEndpoint`。2xx 以外で上に無いもの → `Transport`。
  - 送る前の検査: `InvalidWriteOptions`（相関 ID・申告の形）、`InvalidTagSelection`（名前）。
  - `RestClient::new` は時間切れを持たない。上限は `with_request_timeout` で付ける。

この repo の現状（2026-11-19）:

- Hub への書込みの経路は無い。`banto-tagclient` は `v0.3.0-alpha.1`（`33410f6d`）に固定で、`WriteOptions` を持たない。
- slot は読取専用（TS の `SymbolReadSlot.direction: "read"`、Rust の `equipment_read_bindings`）。
- runtime の `CatalogRow` は書込可否を意図して落としている（`crates/scada-runtime/src/catalog.rs`）。SDK の catalog は `writable` を持つ。
- Hub のキーは読み用の 1 本だけ（keyring の `temp-scada-hub-read`）。
- 運転表示・表示プレビューで機器を押すと、読取の小窓（`PreviewPopups` の `equipment`）が開く。
- 警報の ACK は host の `authorize_alarm_ack` で検査し、運用フェーズでは Admin だけ（[段階3 警報の設計](alarm-stage3-design.md)§6）。利用者名は host の認証状態から取り、webview からは受け取らない。
- 実環境の Hub は `0.3.0-alpha.1`（[C0 の記録](../../project/real-hub-c0.md)）で、#1201 の相関 ID・`write_uncertain` を持たない。この版は結果不明も 502 `write_failed` で返す。
- [アクセス方針](access-policy.md)の表は、開発・初期設定の「実機操作」を「現段階では未対応」としていた。この設計の採用に合わせて §6 のとおりに直した。

## 3. モデル（Project）

機器種別の slot に、任意の `write` を足す。schemaVersion は据え置く（リリース前の Project は後方互換を保証しない）。

```jsonc
// 機器種別 Pump の slots
{ "name": "run", "type": "bool", "direction": "read" },                  // 運転中（読むだけ）
{
  "name": "command", "type": "bool", "direction": "read",               // 読みもする（読み戻し）
  "write": {                                                            // 書込みは write の有無で決まる
    "label": "運転指令",                        // 小窓の行の見出し（1〜40 文字）
    "buttons": [                               // 1〜4 個。固定の値を書く
      { "label": "運転", "value": true },
      { "label": "停止", "value": false }
    ]
  }
},
{
  "name": "speedSp", "type": "number", "direction": "read",
  "write": {
    "label": "回転数 設定",
    "input": { "min": 0, "max": 60 }           // 数値の入力。範囲の外は送らない
  }
},
{
  "name": "mode", "type": "state", "direction": "read",
  "write": {
    "label": "運転モード",
    "buttons": [ { "label": "手動", "value": 1 }, { "label": "自動", "value": 2 } ]
  }
}
```

- `direction` は購読の向きで、`"read"` のまま。書けるかは `write` の有無だけで決める。`write` を持つ slot も読む（書いた結果を画面で確かめるため。読まない書込みだけの slot は作らない）。
- ボタンの値の型: bool slot は真偽値、number slot は有限の数、state slot は 0〜2147483647 の整数。ボタンの値は `input` の範囲に縛られない（停止値などを範囲の外に置ける）。同じ値のボタンを 2 つ置かない。ボタンの見出しは 1〜12 文字。
- `input` は number slot だけ。`min`・`max` は必須で有限の数、`min` ≤ `max`。同じ `write` に `buttons` と `input` の両方を置いてよい。どちらも無いのは誤り。
- 入力の表記は、半角の 10 進（任意の `-`、整数部、任意の `.` と小数部）だけを受ける。全角・桁区切り・指数・`NaN`・`Infinity` は受けない。slot の数値の書式（1-B）の小数桁を超える桁の入力は丸めずに拒む（`invalid_value`）。書式が無い slot は桁を制限しない。
- 別々の運転 bit・停止 bit を持つ設備は、slot を 2 つにして、それぞれに `true` を書くボタンを 1 つずつ置く。PLC 側でリセットする前提で、SCADA はパルス（書いて戻す）を書かない（§11-3）。
- Symbol 定義の slot（`SymbolReadSlot`）には `write` を持たせない。書込みの定義は機器種別だけが持ち、配置ごとには変えない。
- 文字列の書込み、bool への数値入力、word の中の bit だけを書く操作は作らない（word の bit は Hub のビットアクセス T8 のタグとして bool slot に割り付ける）。

検査（Rust `scada-model` と TS、共通ケース `examples/operation-cases.json`）: 上の型・値・範囲・文字数・重複の規則を、bool・number・state の各 slot について持つ。Hub の型との照合は Project には持たず、書く時に行う（§4 の 4）。

## 4. 実行の流れ

```text
webview（Runtime の小窓）               host（Rust）                         Hub
  ボタン／入力 → 確認の小窓
  「実行」 ── operation_write ──▶ 1. 要求の形
                                    2. mode・フェーズ・権限
                                    3. 適用中の Project と照合し、外部名と値を解決
                                    4. catalog: 解決済み・有効・writable・型と値域
                                    5. Hub の版・書き用キー・端末の書込み状態・実行中でない
                                    6. 実行記録に pending の行を書く（失敗なら送らない）
                                    7. 申告の検査、権限・フェーズの再照合（8）、write_tag ─▶ POST /api/v1/values/{tag}
                                    8. 結果を記録の行に書く               ◀─ 応答／時間切れ
  結果の表示 ◀─────────────────── 区分・理由・解決した外部名と値・audit_id
```

**要求**（`operation_write`）: `projectId`、`projectDigest`（webview が表示中の Project について host が返した版の識別。下記）、`screenId`・`objectId`（押した配置）、`equipmentId`・`slotName`、`buttonIndex` か `input`（文字列のまま）、`expectedValue`（確認の小窓に出した値）。外部名は送らない。id は 1〜128 文字に限り、超えたら記録せずに拒む（`invalid_request`、ログだけ）。

**検査の順**（先に当たったものを理由にする。1 で拒んだもの以外はすべて記録する）:

1. 要求の形: `invalid_request`。
2. mode が Runtime でない `not_runtime`。認証 DB が使えない `auth_unavailable`。フェーズが `bootstrapping`・`transitioning`・記録なし `phase_unavailable`。権限なし `not_authorized`（§6）。
3. host が適用中の Project（警報と同じく、host が保存済みのファイルから読んで適用した Project。Runtime mode では起動時に読んだもの）と照合する。`projectId` か `projectDigest` が違う `project_changed`（確認の後に Project が差し替わった）。機器が無い `unknown_equipment`、slot が無い `unknown_slot`、`write` が無い `no_write_def`、ボタンの番号が無い `invalid_button`、入力が §3 の表記・範囲・桁に合わない `invalid_value`／`out_of_range`、slot が未割付 `unbound`。解決した値が `expectedValue` と違う `project_changed`。`screenId`・`objectId` は、その画面に配置があり、その配置が同じ機器を指すかを確かめ、合わなければ `invalid_request` として記録する。
4. catalog（§4.1）: 取れない `catalog_unavailable`、取り直し中 `catalog_pending`、名前が無い `unresolved`、`enabled=false` `tag_disabled`、`writable=false` `not_writable`、型の対応が合わない `type_mismatch`、値が Hub の型の値域に入らない `out_of_range`（§4.2）。
5. Hub が書込み契約の版に届いていない `hub_unsupported`（§11-8）。書き用キーが無い `no_write_key`、キーが別の接続先のもの `hub_mismatch`（§7）。端末の書込みが停止中 `write_stopped`、キー無効 `key_invalid`、間隔の内 `too_soon`（§7）。別の書込みが送信中 `busy`。
6. 実行記録に書けない `record_failed`（送らない）。この後、8 の照合で止めた場合も同じ行を確定する。
7. `on_behalf_of` は利用者名。128 文字を超えるか制御文字を含むときは送らずに `invalid_operator` で拒む（記録の `user` は原文を残す）。`correlation_id` は記録の行の id（UUID v7 の 36 文字）。
8. **送信の確定**: 4 の catalog の取得と 6 の記録を待つ間に、権限の取消・ログアウト・利用者の切替・フェーズの遷移・mode の変化が起き得る。`write_tag` を呼ぶ直前に、認証とフェーズの状態を排他の下でもう一度読み、2 で確かめた利用者・権限・フェーズと一致するかを照合する。一致しなければ送らず、6 で書いた `pending` の行を `refused`（利用者・権限の変化は `auth_changed`、フェーズの変化は `phase_changed`）で確定する。照合と `write_tag` の呼出しは、認証・フェーズの遷移と同じ排他の中で行い、遷移はその排他を取ってから状態を変える（照合の後に遷移が割り込まない）。排他の中で `write_tag` の呼出しを別のタスクとして起動した時点を「送信の開始」とし、起動したら排他を離す（`write_tag` が返るまでは持たない。遷移を最大 10 秒待たせないため）。送信の開始より後の取消・遷移は、その書込みを止めない（送った要求は取り消せない。結果は §5 のとおり確定する）。

**`projectDigest`**: host が Project を適用するたびに、適用した内容の SHA-256 を持ち、Runtime の画面の読込で webview へ渡す。webview の確認の小窓は、この版の Project から作る。ファイルの差し替え・再読込で版が変わったら、確認済みの要求は `project_changed` で拒まれ、操作者は新しい小窓で確かめ直す。未保存の変更は Runtime mode には無い（保存済みを読むだけ）ので、この照合だけで足りる。

**排他と時間**: 端末で同時に送る書込みは 1 つ（`busy`）。host のプロセスで 1 つなので、Runtime の多重起動は禁じる（§11-9）。書込みの `RestClient` は `with_request_timeout` で上限を付ける（既定 10 秒、§11-1）。時間切れは tagclient が `WriteUncertain` にする。取消は作らない（送った要求を画面の操作で取り消したことにしない）。再試行はしない。結果不明・不成立のあとにもう一度押すのは操作者の判断で、新しい記録の行になる。二度押しは、小窓のボタンを結果が返るまで押せなくして防ぎ、host でも `busy` で拒む。

### 4.1 catalog の取り方

書込みのたびに、読み用キーの `RestClient` で `fetch_catalog` を取り直す（書き用キーは write スコープだけで catalog を読めない）。取得は書込みと同じ上限の時間で切り、失敗は `catalog_unavailable`。取得した catalog の `revision` が、購読の持つ revision と違うときは `catalog_pending`（購読側の再解決が済んでいない）。取り直しは書込みの頻度が低いので許す。§9.6 の「現在の catalog」を、端末の購読の状態に頼らずに満たすため。

### 4.2 型と値域

| Hub の型（catalog の `data_type`） | 書ける slot   | 値域                                                             |
| ---------------------------------- | ------------- | ---------------------------------------------------------------- |
| bit                                | bool          | 真偽値                                                           |
| 整数（i16・u16・i32・u32）         | number・state | その型の範囲の整数。小数は `type_mismatch`                       |
| 整数（i64・u64）                   | number・state | ±2^53−1 の内（JSON の数の精度）かつ型の範囲                      |
| 浮動小数（f32・f64）               | number        | 有限の数。f32 は範囲（±3.4e38）だけを確かめ、丸めは Hub に任せる |
| 文字列ほか                         | なし          | `type_mismatch`                                                  |

catalog の `data_type` の語彙は O2a で上流の型に合わせて確定し、知らない語は `type_mismatch` にする（fail-closed）。

O2a の確認（2026-11-19、banto-industrial `v0.3.0-alpha.2` = `c0ac5206`）: 語彙は `banto-tags` の `ALLOWED_DATA_TYPES` の `bit`・`i16`・`u16`・`i32`・`u32`・`f32`・`i64`・`u64`・`f64`・`string` の 10 語（真偽値は `bool` ではなく `bit`）。上の表はこの語で読む。`string` と、この 10 語に無い語は書けない。

## 5. 結果の区分と表示

`outcome` は記録と画面で同じ語を使う。

| `outcome`   | 起きる場合                                                                                                                         | 小窓の表示                                         |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `ok`        | `Ok(WriteReceipt)`                                                                                                                 | 「書込みました」。読み戻しの値を並べて出す         |
| `refused`   | §4 の 2〜8 で SCADA が止めた                                                                                                       | 理由の文と「送っていません」                       |
| `not_sent`  | `Unauthorized`・`WriteForbidden`・`WriteUnavailable`・`Transport`・`InvalidEndpoint`・`InvalidWriteOptions`・`InvalidTagSelection` | 理由の文と「書込み先へは送られていません」         |
| `stopped`   | `KeyTripped`（Hub が書き用キーを止めた）                                                                                           | 「この端末の書込みは停止中」（§7）                 |
| `failed`    | `WriteRejected`                                                                                                                    | 「書込みは成立していません」（送ったかは問わない） |
| `uncertain` | `WriteUncertain`、上に無い `ErrorKind`（将来の種別を含む）、記録の確定前に host が落ちた                                           | 「書けたか分かりません。現在値を確かめてください」 |

- `WriteRejected` は、送る前の拒否（404・409・422・429・501）と、送って失敗（502 `write_failed`）を分けられない。どちらも書込みは成立していないので、表示は「成立していません」に統一し、「送っていません」とは書かない。分けたい場合は上流へ種別の分割を求める（§12）。§4 の検査で 404（`unresolved`）・409（`tag_disabled`）・422（`out_of_range`）の多くは送る前に止まる。
- `not_sent` の `Transport` は、接続できない場合と 500 `audit_write_failed` の両方で、どちらも書込み先へ送っていない。
- 理由のコードは、`refused` では §4 の語、それ以外では `ErrorKind::as_str()` をそのまま記録する。画面の日本語はコードから引き、知らないコードは「不明な理由（コード）」と出す。
- `audit_id` は成功のときだけ得られる（誤りは持たない）。成功でも応答の本文が読めなければ無い。
- 成功は「設備が運転した」ではない。小窓は、書いた値と slot の購読値（品質つき）を並べて出し、読み戻しを待つ表示や一致の判定はしない（PLC が書き戻すことがある）。運転状態は機器の状態の slot で見る。
- 購読値が不良・未接続・更新停止のときも書込みは止めない（停止の指令を送れなくしないため、§11-5）。確認の小窓に現在値の品質を出す。
- **SCADA の停止の指令は、安全停止の手段ではない**。SCADA からの書込みは、記録 DB の故障（§10）・Hub や通信の断・書き用キーの停止・権限やフェーズで送れないことがある。設備の安全停止は、非常停止回路・PLC のインターロックなど SCADA の外の手段で確保する前提とし、この設計はその代わりを目指さない。

## 6. 権限とフェーズ

フェーズは警報と同じ（[段階3 警報の設計](alarm-stage3-design.md)§5.2）。どのフェーズでも、Runtime mode で、書き用キーが登録されていることが前提（§7）。

| フェーズ           | 書込み                                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| 開発・初期設定     | ログイン不要（利用者名は「未ログイン」）。画面の上端に常に「初期設定中: ログインなしで書込みできます」と出す（§11-4） |
| 運用・未ログイン   | 不可（小窓は開け、値は見えるが、操作の行は押せない）                                                                  |
| 運用・ログイン済み | `equipment.operate` を持つ利用者だけ。tyaro/banto#697 が入るまでは誰も書けない（Admin へ代替しない）                  |

- 開発・初期設定で書けることの根拠は、警報 ACK との類比ではなく、**書き用キーの登録が書込みの明示の解禁になる**こと。書き用キーは Hub の管理者が発行し、スコープで書けるタグを列挙する。登録しなければ、どのフェーズでも書けない。
- 判定は `operation_write` の中で毎回行う（画面の非表示に頼らない）。
- 警報 ACK を `alarm.ack` へ移すのは banto#697 が入った区切り（O5）で一緒に行う。
- Editor mode と表示プレビューからは Hub へ書かない（§8）。

## 7. 書き用キーと端末の書込み状態

- keyring に読み用と別の項目（サービス名 `temp-scada-hub-write`）で 1 本持つ。キーは登録したときの Hub の接続先（読み用と同じ endpoint の識別。警報 §5.2 で Hub の同一性に使うもの）と組で保存する。読み用の接続先を変えたら書き用キーは無効にし（`hub_mismatch`）、再登録を求める。キーの値は画面に戻さない。
- 登録・削除は Runtime の端末設定の画面から行う。開発・初期設定ではログイン不要、運用では Admin だけ（キーの管理は設備操作ではなく端末の設定なので、`equipment.operate` ではなく Admin とする）。
- host は端末の書込み状態を持ち、host の再起動後も保つ（端末設定の DB に残す。§11-6）。
  - `ready`: 書ける。
  - `stopped`: Hub が 403 `key_tripped` を返した。以後の要求は送らずに `refused`（`write_stopped`）で記録する。購読は止めない。解くのは、Hub の管理画面で trip を解いたあと、端末の画面の「書込みを再開」（運用では Admin）か、キーの再登録。再開の後の 1 回目の書込みで Hub がもう一度確かめる。
  - `key_invalid`: Hub が 401 を返した（キーの失効・削除）。キーの再登録まで送らない。
- 回数制限による trip を避けるため、host は書込みの間に最小の間隔（既定 1 秒、§11-10）を置き、その内の要求は `too_soon` で拒む。拒否の連打で記録が膨らむのを防ぐため、記録の中身がすべて同じ `refused`（`user`・`phase`・`hub_endpoint`・`project_id`・`project_digest`・`screen_id`・`object_id`・機器・slot・`tag`・`value`（入力の文字列を含む）・`reason`）だけを、最初の行から 60 秒の内は 1 行にまとめ、件数を `repeat_count` に数える（上流 #711 の集約にならう）。どれか 1 つでも違えば別の行にする（例: 停止中に「運転」と「停止」を押したら 2 行）ので、まとめた行から個々の要求の中身をすべて復元できる。
- Hub の管理者が書き用キーのスコープを作れるよう、Designer に「書込みタグの一覧」（Project が書く外部名の一覧。機器の割付と `write` から作る）を出し、コピー・CSV で渡せるようにする。スコープの外のタグは Hub が 403 で断り、`not_sent` になる。

## 8. 表示（小窓）と Editor での確認

- Runtime mode で機器を押すと、標準 Faceplate（今の読取の小窓を広げたもの）を開く。読む slot の行の下に、`write` を持つ slot ごとに操作の行（見出し、ボタンか入力欄、現在値）を出す。ボタンを押すか値を入れて「設定」を押すと、確認の小窓（機器名・見出し・現在値→書く値・品質）を出し、「実行」で送る。キーボードで操作でき、確認の小窓の既定のボタンは「取消」にする。
- 結果は操作の行に、その機器・slot の最後の 1 件を出す（区分・時刻・理由）。出どころは host の実行記録で、小窓を開き直しても webview を読み直しても同じものを出す。`pending` の行は、host が送信中として持っている行（§9）だけを「送信中」と出し、送信を終えて結果を記録できなかった行は「結果を記録できませんでした。現在値を確かめてください」と出す（host がその結果をまだ持っていれば並べて出す）。トーストだけにしない（見落とすと結果不明に気づかないため）。
- 書込み状態が `stopped`・`key_invalid`、書き用キーが無い、Hub の版が足りないときは、操作の行を押せなくして理由を出し、Runtime の上端にも出す。
- Editor mode の表示プレビュー・運転表示では、同じ小窓を出すが、「実行」は Hub へ送らず、模擬値を書いた値に変える（模擬の結果）。小窓に「模擬」と出す。実 Hub の購読中のプレビューでは操作の行を押せなくする（実データの上で模擬の書込みに見えるのを避ける）。
- 画面の埋め込み（`screenView`）の中の機器は今どおり押せない。

## 9. 実行記録

host の SQLite（端末に 1 つのファイル `operations.db`。警報 DB と同じ開き方の規則。Project をまたいで残し、行に Project を持つ）に、要求 1 件を 1 行で残す。置き場は端末のデータフォルダーの直下（`alarm-terminal.json` の隣）とする。警報 DB の `alarms` フォルダーは、端末が中の `.db` をすべて警報 DB として世代番号を読むので、そこには置かない（O2b-1 で確定）。

| 列                                       | 中身                                                    |
| ---------------------------------------- | ------------------------------------------------------- |
| `id`                                     | UUID v7。Hub への `correlation_id`                      |
| `requested_at_ms`・`finished_at_ms`      | 受付と結果確定の時刻（未確定の間は NULL）。差が所要時間 |
| `user`・`phase`                          | 利用者名（「未ログイン」を含む）とフェーズ              |
| `hub_endpoint`                           | 送り先の Hub の識別                                     |
| `project_id`・`project_digest`           | 適用中の Project                                        |
| `screen_id`・`object_id`                 | 押した配置（§4 の 3 で確かめたもの）                    |
| `equipment_id`・`equipment_code`・`slot` | 対象の機器と slot                                       |
| `tag`                                    | 解決した外部名（解決前に止めたときは NULL）             |
| `value`                                  | 書こうとした値（JSON）。入力のときは入力の文字列も      |
| `outcome`・`reason`                      | §5 の語と理由のコード                                   |
| `repeat_count`                           | §7 の集約でまとめた件数（既定 1）                       |
| `audit_id`                               | Hub の監査行の id（成功で得られたときだけ）             |

- 送信の後に結果を記録の行に書けなかったときは、画面には実際の結果と「記録に失敗」を返し、行は `pending` のまま残す。起動時に `pending` の行は `uncertain`（理由 `interrupted`）に直す（送信中に落ちた場合と同じ扱い）。
- host は、いま送信中の行の id（端末で高々 1 つ）と、送信を終えたが結果を記録できなかった行の id と結果（このプロセスの間だけ）を持つ。記録を読んで返すとき、`pending` の行は、送信中の id なら `sending`、記録できなかった行なら `unrecorded`（結果があれば添える）、どちらでもなければ `unrecorded`（前のプロセスの行）として返す。webview は `pending` を自分で「送信中」と解釈しない。記録できなかった結果は、次に記録へ書けたときにその行へ書き直す（再送はしない）。
- 保持は警報の端末設定と同じ形（日数か件数の上限）で別に持つ（§11-7）。保持の削除は `pending` の行を消さない。
- 照会: Runtime に「操作履歴」の窓（期間・機器・区分で絞る一覧、読むだけ）。画面切替ボタンの行き先に `operationList` を足す。

## 10. 起動と失敗の扱いのまとめ

- 記録 DB に書けない（ディスク満杯など）と、停止の指令も送れない（log-before-write を優先する。§11-2）。上端に「操作の記録ができないため書込みを止めています」と出す。
- Hub に届かない間は、書込みは `not_sent` か `uncertain` になり、購読の状態とは別に出る。
- Runtime の多重起動は禁じる（2 つ目の起動は 1 つ目の窓を前に出して終わる）。

## 11. 確認したこと（2026-11-19 回答: すべて推奨のまま）

1. **書込みの時間切れは 10 秒にする（推奨）**。Hub がドライバの応答を待つ時間より長くする。時間切れは結果不明になる。端末で送信中の書込みは 1 つなので、その間は別の機器の停止の指令も待たされる。機器ごとに並行させる・停止を優先する案は、複数の要求の結果の扱いが増えるので採らない。
2. **記録 DB に書けないときは、停止の指令も送らない（推奨）**。上流 §16 の「要求を追跡できること」を優先する。代案は停止の値だけ記録なしで送ることだが、どの値が停止かを SCADA は知らない。
3. **bool の指令は固定値の書込みだけにする（推奨）**。パルス（書いて一定時間後に戻す）は 2 回目の書込みの失敗で値が残るので作らない。PLC 側で自己保持・リセットする前提。
4. **開発・初期設定のフェーズでは、Runtime mode で書き用キーが登録されていれば、ログインなしで書けるようにする（推奨）**。上端に常に出す。代案は、フェーズに関わらず `equipment.operate` を要求すること（banto#697 待ちで、それまで誰も書けない）。運用フェーズは banto#697 まで誰も書けないので、試運転の計画と合うかも確かめたい。
5. **購読値が不良・未接続でも書込みは止めない（推奨）**。停止の指令を送れなくなるのを避ける。確認の小窓に品質を出す。
6. **書込みの停止中（`key_tripped`）は host の再起動後も保つ（推奨）**。再開は端末の画面の明示の操作かキーの再登録だけにする。
7. **実行記録の保持の上限は、警報と同じ形の端末設定にする（推奨）**。既定は 1 年か 10 万件の早い方。
8. **Hub の版を要件にし、確かめられない Hub には書かない（推奨）**。#1201 より前の Hub は結果不明を 502 `write_failed` で返し、SCADA が「成立していません」と誤って出す。host が Hub の版（か書込み契約の能力）を確かめる手段を O2a で上流に確かめ、手段が無ければ上流に求める。実環境の Hub は確認の前に #1201 の入った版へ上げる。
   - O2a の確認（2026-11-19）: tagclient に版や能力を取る API は無い。Hub の `GET /api/v1/status`（読み用キー）は `version`（Hub の crate の版 `CARGO_PKG_VERSION`）を返すが、ワークスペースの版は 11-06 ごろから `0.3.0-alpha.2` のままで、#1201（2026-11-18 マージ）の前と後の Hub が同じ版を返す。版の文字列では #1201 の有無を確かめられないので、書込み契約の能力（例: 状態の応答の能力の一覧）か、#1201 の後に上がる版を上流に求める（[banto-industrial#1223](https://github.com/tyaro/banto-industrial/issues/1223)、2026-11-19 起票）。それまで O2b 以降は「確かめられない Hub には書かない」を守る（書込みを有効にしない）。
9. **Runtime の多重起動を禁じる（推奨）**。端末で送信中の書込みを 1 つにする規則と、書込み状態を host の 1 か所で持つため。
10. **書込みの最小の間隔を 1 秒にする（推奨）**。Hub の回数制限で書き用キーが trip され、端末の書込みがすべて止まるのを避ける。Hub の制限の値に合わせて変えられるようにする。
11. **操作の入口は、機器の slot の定義から作る標準 Faceplate だけにする（推奨）**。画面に自由に置く操作ボタン（例: 一括運転、連動運転の選択）は、機器に属さない書込みの定義と Action のモデルが要るので後続にする。参照画面にこの種のボタンが要るなら、先に回すかを決める。
12. **書けるのは Runtime mode だけにする（推奨）**。#279 を先に入れる。代案は Editor の運転表示でも書けるようにすることだが、上流 §18 と統合設計 §8（表示確認から外部副作用を起こさない）に反する。

## 12. 後続（この段階で作らない）

- 画面に置く操作ボタン（機器に属さない書込み）と、Action のモデル（統合設計 §8 の「動作」タブ）。
- 利用者が描く Faceplate 定義（上流 §7.4、開発計画の Core v1 残りの 5）。
- interlock・permissive の表示、操作理由の入力、二人承認。
- 設備・画面ごとの操作権限（banto#697 の後で SCADA 側に足す）。
- 上流への求め: tagclient の `WriteRejected` を送る前の拒否と送って失敗（502 `write_failed`）に分ける、誤りに `audit_id` を持たせる、Hub の版・能力を取る手段（§11-8 で無いと分かった場合）。
- 実行記録を Hub の監査と並べて見る画面、CSV の書出し。
- 常時実行の Action（v1.1 S10b）と SCADA server core への移設。

## 13. PR の区切り（案）

| 区切り | 内容                                                                                                                                                                                                                                                                                                                                              |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O0     | #279 Runtime mode（起動時の mode、capability の分離、Rust 側の mode 検査、多重起動の禁止）。この設計の前提。詳細は[Runtime mode の設計](runtime-mode-design.md)                                                                                                                                                                                   |
| O1     | slot の `write`（schema・Rust・TS・検査・`examples/operation-cases.json`）、機器種別の編集画面の「操作」、書込みタグの一覧                                                                                                                                                                                                                        |
| O2a    | banto-tagclient の更新と `CatalogRow` の `writable`・`enabled`。読取の回帰だけを確かめる。Hub の版を確かめる手段と `data_type` の語彙を上流で確かめる                                                                                                                                                                                             |
| O2b    | `operations.db` と `operation_write`（§4 の検査の順・§5 の区分・記録）。区分は host の結合試験でモック Hub の各応答（成功・各 4xx・502 の 2 種・5xx・時間切れ・切断）を当てる。送信の開始の前の権限の取消・フェーズの遷移（送らずに `refused`）と、開始の後の取消（送った結果で確定）、結果を記録できなかった行の再表示（`unrecorded`）も試験する |
| O2c    | 書き用キーの登録・接続先との組・端末の書込み状態（停止・無効・再開）・最小間隔・拒否の集約                                                                                                                                                                                                                                                        |
| O3     | 標準 Faceplate の操作の行・確認の小窓・結果の表示、Editor の模擬の書込み。e2e は表示だけ（host はモックの IPC）                                                                                                                                                                                                                                   |
| O4     | 操作履歴の窓と保持、`navButton` の `operationList`、実 Hub の安全番地での確認（前提: Hub を #1201 の版へ上げる。元値へ戻す手順を記録）                                                                                                                                                                                                            |
| O5     | banto#697 が入ったら `equipment.operate`・`alarm.ack` へ権限を移す                                                                                                                                                                                                                                                                                |

O2a からは Tauri 実機と実 Hub の確認が要り、ブラウザの e2e では host を通らない。書込みの区分の正しさは O2b の host の試験で確かめる。各区切りの検証は[差分文書§5.5](../editor/flow-diagram-gap-2026-11-12.md#55-各-pr-の検証)に従う。

O2b の分け方（2026-11-19）: O2b-1 は実行記録（`operations.db` の行、§5 の区分の対応表、起動時の `pending` の直し、送信中・記録できなかった行の区別、端末で送信中を 1 つにする予約）だけで、Hub へは送らない。O2b-2 は `operation_write` の検査の順（§4）とモック Hub の各応答の試験、Tauri の command。書き用キー（O2c）と書込み契約の確認（§11-8）が無い間、O2b-2 の command は `no_write_key`／`hub_unsupported` で拒み、実 Hub へは送らない。

O2b-2 の分け方と O2b-2a で決めたこと（2026-11-19）: O2b-2a は host の `operation_write`（§4 の 1〜8、§4.1、§4.2、§5、§6）とその試験、O2b-2b は Tauri の command。設計に書いていなかった所は次のとおりにした。O3 の小窓（TS）も同じ規則に揃える。

- 入力の小数桁の上限（§3）: slot は書式を持たないので、押した配置の Symbol の中でその slot を `slotBinding` で表示する文字・表のセルの `format.decimals` の最大とする。表示が無ければ桁を制限しない。
- 入力の文字列は 128 文字までとし、超えたら 1 の `invalid_request`（記録しない）。
- 8 の再照合で mode が Runtime でなくなっていたら、2 と同じ `not_runtime` で確定する。
- 適用中の Project が無いときは 3 の `project_changed`、購読の catalog の revision が無いときは 4 の `catalog_pending`。認証を開けなかった host は `auth_unavailable`（記録のフェーズは `unknown`）。
- 記録の `value` は、ボタンなら `{"button": 番号, "value": 値}`、入力なら `{"input": "入力の文字列", "value": 値}`。値を解決する前に止めたものは `value` を持たない。
- 送信のタスクが異常終了したときは `uncertain`（理由 `interrupted`）とする。

O2b-2b で決めたこと（2026-11-19）: command `operation_write` は Runtime の窓だけに許す（ACL の `runtime.json`、`require_runtime`）。Editor mode では要求を受け取る前に拒むので記録する要求が無く、`operations.db` は Runtime mode でだけ開く（host の `not_runtime` はこの command からは出ない）。記録を開けないときは 2〜5 を走らせずに `record_failed` を返す。購読の catalog の revision は、購読の最新の frame の値（`ReadHostFrame::catalog_revision`）を使う。購読が無いか catalog がまだ無ければ `catalog_pending`。

O3 の分け方と O3a で決めたこと（2026-11-19）: O3a は Runtime の小窓が操作の行を出すための照会の command `operation_view`（Rust）、O3b は TS の純関数（Project からの操作の行、入力の表記と小数桁の規則を host と同じにする解釈、確認の小窓の内容、区分・理由の日本語の文言）、O3c は小窓の操作の行・確認の小窓・結果の表示、Editor の模擬の書込み、モックの IPC での e2e。O3a で決めたことは次のとおり。

- 要求は `{ equipmentId }` だけ（1〜128 文字、ほかの欄は拒む）。Project は host の適用中のものを使い、webview からは受け取らない。答えは `projectId`・`projectDigest`（適用中の Project。無ければ null）、`blocked`、`phase`（記録に書くのと同じ語。認証を開けなければ `unknown`）、`slots`。
- `slots` は機器種別の slot の順で、`write` を持つ slot だけ。各 slot の `latest` は最後の 1 件で、`state` は `finished`・`sending`・`unrecorded`。`outcome`・`reason`・`finishedAtMs`・`auditId` は確定した結果から取り、`sending` と、結果を持たない `unrecorded` では null。`value` は解決した値（記録の `value.value`）、`tag` は解決した外部名で、`operation_write` の答えと揃える。
- `blocked` は、要求に依らない 2 と 5 の検査を書込みと同じ関数で記録せずに評価したもの（`not_runtime`・`auth_unavailable`・`phase_unavailable`・`not_authorized`・`project_changed`・`hub_unsupported`・`no_write_key`）と、送信中の `busy`。順は書込みと同じで、記録を開けない・読めないときは最初に `record_failed`（slot は並べ、`latest` は null）。製品では `hub_unsupported` になる。要求ごとの 1・3・4 の拒否は書込みのときに決まる。
- 適用中の Project に無い機器は `unknown_equipment`、id の形が違えば `invalid_request` のエラーで、記録しない。適用中の Project が無ければ `blocked: "project_changed"` で `slots` は空。
- 照会は遷移のロックも送信枠も取らない。

O3c-1 で決めたこと（2026-11-19）: O3c を O3c-1（Runtime の小窓の操作の行・確認の小窓・結果の表示）と O3c-2（Editor の模擬の書込み）に分けた。設計に書いていなかった所は次のとおり。

- 押した配置（`screenId`・`objectId`）は機器の小窓ごとに最後に押した 1 つを持つ。一覧などから配置なしで開いた小窓は、操作の行を出すが押せなくし「配置から開いたときだけ操作できます」と出す。
- 要求の `projectId`・`projectDigest` は Runtime の窓の起動時の Project のもの。`operation_view` の答えの Project が無いか、それと違うときは `project_changed` の文で押せなくする。
- 送信中は、その小窓の操作の行をすべて押せなくする（host も端末で送信を 1 つに限る）。
- 行の結果は、記録の最後の 1 件を出す。この小窓の直前の答えが記録に無い（記録しない拒否・`unrecorded`・答えの `recordId` が最後の 1 件と違う）か IPC が失敗したときは、その答えを出す（`unrecorded` は「記録に失敗」を並べる）。
- Runtime の運転表示のバーの「表示確認（書込みなし）」は、操作を渡したときは出さない。

O3c-2 で決めたこと（2026-11-19）: 設計に書いていなかった所は次のとおり。

- 模擬値は Editor の編集 session に持ち、Project にも保存にも入れない。Project の `projectId` が変われば使わない。値は書いたタグ（外部名）ごとに持ち、同じタグを読む画面直下の結合と機器の slot の両方に、SIM つきの Good（出どころ `simulation`）として重ねる。重ねるのは実 Hub を購読していない（`readSource` が無い）ときだけ。
- 「実 Hub の購読中」は Editor に `readSource` があることで判断する。そのときの照会は TS だけの理由のコード `simulated_on_hub`（「実Hubの購読中は模擬の書込みはできません」）を返し、host は返さない。デモの模擬値の読取も `readSource` なので同じく押せない（デモの Project に `write` は無い）。
- 模擬の書込みは host の `resolve` と同じ順で検査する（Project・機器・押した配置・slot・`write`・ボタンか入力の値・割付け・`expectedValue`）。Hub のカタログが無いので、タグの有無・書込みの可否・整数の型（`type_mismatch`）は確かめない。拒否は記録に残さず、通ったものだけを機器・slot の最後の 1 件として残す（`recordId` は `simulated-<連番>`）。
- 模擬の host の `projectDigest` は固定の `editor-simulation`、`phase` は `simulation`（初期設定中の文を出さない）。小窓の「操作」の見出しと確認の小窓に「模擬」と出し、Editor の運転表示のバーは「表示確認（模擬の書込み）」と出す。

§11-8 の確認（2026-11-20）: 上流 banto-industrial #1223 は #1224 で閉じ、Hub の `GET /api/v1/status` が `capabilities`（`write_contract_v1`）を返し、tagclient に `fetch_status`・`HubStatus::supports_write_contract` が入った（タグ `v0.3.0-alpha.3`）。依存をこの版へ上げ、4-5 の `hub_unsupported` を次のとおり判定する。

- 書込みと照会のたびに、読み用キーの `RestClient` で状態を取り直す（§4.1 の catalog と同じ。Hub が古い版へ戻されても前の答えを使わない）。
- `write_contract_v1` が並んでいるときだけ契約ありとする。欄が無い（#1223 より前の Hub）、別の名前だけ、HTTP の誤り、本文が読めない、上限の時間内に返らない、読み用キーが無いときは、確かめられないので `hub_unsupported`。
- 書込みは 4 の catalog の取得が通った後に聞く（Hub に届かないときは 4 の `catalog_unavailable` が先に出る）。上限は書込みと同じ。照会は 2・3 で止まらないときだけ聞き、小窓の 2 秒おきの照会を長く止めないよう上限を 3 秒にする。
- 製品には書き用キーがまだ無い（O2c）ので、契約のある Hub では `no_write_key`、無い Hub では `hub_unsupported` で拒み、Hub へは送らない。

O2c の分け方と O2c-1 で決めたこと（2026-11-20）: O2c は 4 つに分ける。O2c-1 は拒否の集約（host の `operations.db` だけ）、O2c-2 は端末の書込み状態（`ready`・`stopped`・`key_invalid`）の保持と最小間隔（`too_soon`）、O2c-3 は書き用キーの保存・接続先との組（`hub_mismatch`）と登録・削除・再開の command、O2c-4 は Runtime の端末設定の画面。O2c-1 で設計に書いていなかった所は次のとおりにした。

- まとめる先は、その slot（Project・機器・slot）の最新の行だけとする。§7 の項目（`equipment_code` も含む）と理由がすべて同じ `refused` で、その行の最初の要求の時刻から 60 秒の内なら、その行の `repeat_count` を 1 つ増やす。別の slot の行が間に入ってもまとめるが、同じ slot に別の行（別の値・送った要求など）が入ったら新しい行にする。slot の最後の行が最後の要求であることを保つため（例: 停止中に「運転」「停止」「運転」と押したら 3 行）。
- まとめた行の `requested_at_ms` は最初の要求のまま、`finished_at_ms` は最後の拒否の時刻にする。要求の時刻が行の最初の要求より前か、拒否の時刻が行の `finished_at_ms` より前（時計の巻き戻り）ならまとめず、新しい行にする（行の終わりの時刻を戻さない）。
- まとめは 1 つの SQL 文（`UPDATE … RETURNING`）で行う。まとめられなかったときだけ新しい行を書くので、同時の拒否が 2 行になることはあっても、変わった行へまとめることは無い。まとめを書けなければ記録の失敗（`unrecorded`）とする。
- 小窓の照会（§8）は `repeat_count` をまだ出さない（操作履歴の窓、O4 で出す）。

O2c-2 で決めたこと（2026-11-20）: 設計に書いていなかった所は次のとおりにした。

- 書込み状態は `operations.db` の表 `terminal_write`（1 行。`state`・`changed_at_ms`）に残す。§7 の「端末設定の DB」は、端末のデータフォルダーにある実行記録の DB とした（記録と同じ host の 1 か所で持ち、別の DB を足さない）。形式を 2 に上げ、形式 1 の file は開くときに表を足す（行は残す）。表に行が無ければ `ready`。
- 遷移は送った書込みの結果で決める。tagclient の `KeyTripped`（403 `key_tripped`、区分 `stopped`）で `stopped`、`Unauthorized`（401）で `key_invalid`。結果を書いて送信枠を返す前に状態を変えるので、次の書込みは必ず新しい状態を見る。状態を変える結果は、行の確定と状態の保存を 1 つのトランザクションで書く（間でプロセスが終わっても、記録に trip が残ったまま `ready` で起動することが無い）。書けなかったときはどちらも書かず、process の中では止めたままにし、状態だけをすぐ書き直し、次に DB が書込みを受けたときにも書き直す。状態を保存できるまで、その結果の行は `pending` のまま確定しない（状態の保存だけが失敗し続けても、記録に trip だけが残ることが無い。後の再開・再登録で新しい状態を保存できたら確定する）。状態の保存とそれに伴う process の中の状態の変更（trip・書き直し・再開・再登録）は 1 本の排他で順に行い、古い状態で新しい状態を上書きしない。
- 「書込みを再開」（`OperationLog::resume`）は `stopped` だけを `ready` に戻し、file に書けたときだけ変える（書けなければ止めたまま）。`key_invalid` は戻さず、キーの再登録（`key_registered`、O2c-3 から呼ぶ）だけが戻す。再登録はどの状態からも `ready` にする。
- 最小間隔は、送信枠を取った時刻（4-6）からの経過で測る。壁時計の巻き戻りで書込みが止まらないよう、process の単調時計を使う。8 の照合で止めた要求も枠を取っていれば数える。再起動すると数え直す。間隔は host の `HubAccess::min_interval`（製品は `MIN_WRITE_INTERVAL`＝1 秒）。端末設定で変えるのは O2c-4。
- 5 の順は `hub_unsupported`・`no_write_key`・（O2c-3 の `hub_mismatch`）・`write_stopped`・`key_invalid`・`too_soon`・`busy`。6 で送信枠を取ったときにも書込み状態と間隔をもう一度確かめる（5 と 6 の間に前の書込みが終わって止まった場合）。その場合は `busy` が先に出る。
- 小窓の照会の `blocked` は `write_stopped`・`key_invalid` を出し、`too_soon` は出さない（次の要求がいつ来るかで決まるため）。

O2c-3 の分け方と O2c-3a で決めたこと（2026-11-20）: O2c-3 は host の書き用キー（O2c-3a）と Tauri の登録・削除・再開の command・ACL（O2c-3b）に分ける。O2c-3a で設計に書いていなかった所は次のとおりにした。

- 秘密は keyring のサービス `temp-scada-hub-write` に、登録ごとに新しい項目（アカウント `<installation id>/<項目 id>`）として持つ。値は webview へ戻さない。
- 組にする接続先は、読み用の接続の記録（`hub-read.json`）の `endpoint` の文字列そのもの（警報が Hub の同一性に使うものと同じ）。`operations.db` の `terminal_write` に、接続先 `key_endpoint` と keyring の項目 id `key_id` を書込み状態と並べ、1 つの文で一緒に変える（形式 3。形式 2 の file は開くときに列を足す）。読み用の接続先がこれと違う、または読み用の接続が無いときは `hub_mismatch`。
- 登録は、秘密の形式（空でない印字可能な ASCII）と接続先（`http` だけ。製品の読み用の接続も TLS の pin を持たない）を確かめてから、新しい項目に秘密を書き、記録を新しい接続先・項目 id・`ready` へ切り替え、最後に前の項目を消す。切り替えの前に失敗・終了しても、記録は前のキー（前の接続先とその秘密）を指したままで、新しい項目は消すか読まれずに残る（再登録の途中で新しい秘密が前の接続先と組になることは無い）。削除は、記録からキーを外してから項目を消す。項目の削除に失敗したときは、読まれない項目が残る（資格情報マネージャーから手で消せる）。記録のキーと項目の秘密の片方だけがあるときもキーが無いとする。
- 書き用キーは write スコープだけで Hub を読めないので、登録のときに Hub へ確かめない。最初の書込みで確かめる（401 は `key_invalid`）。
- 削除は書込み状態を変えない（停止中のまま削除しても、次の登録で `ready` になる）。
- 権限（開発・初期設定はログイン不要、運用は Admin）は O2c-3b の command で確かめる。

O2c-3b の分け方と O2c-3b-1 で決めたこと（2026-11-20）: O2c-3b は host のキーの世代の照合（O2c-3b-1）と Tauri の登録・削除・再開の command・ACL・Admin 判定（O2c-3b-2）に分ける。O2c-3b-1 は #320 のオーナー指摘（送信中にキーを登録し直すと、前のキーの 401・trip が遅れて返り、新しいキーで戻した `ready` を上書きし得る）への対応で、次のとおりにした。

- キーの世代は keyring の項目 id（`KeyRef::id`、登録ごとに新しい）とする。`WriteKey` も同じ id を持つ。
- 6 で送信枠を取るときに、5 で確かめたキーの id が記録の今のキーと同じかを確かめる。違う（5 と 6 の間に登録し直した・削除した）ときは送らず、新しい理由 `key_changed`（「書き用キーが登録し直されました。もう一度操作してください」）で拒否として記録する。`busy` の後、`write_stopped`・`key_invalid`・`too_soon` の前に確かめる。
- 送信枠は送ったキーの id を持ち、結果で書込み状態を変える（`stopped`・`key_invalid`）のは、そのキーが結果の確定の時にもまだ登録されているときだけとする。登録し直した・削除した後に返った前のキーの結果は、区分と理由をそのまま行に残し、書込み状態は変えない。照合は書込み状態の排他（`state_lock`）の下で行うので、登録・削除と順が入れ替わらない。
- 8 で送信のタスクを起動する直前にも、同じ照合をもう一度行う（#321 のオーナー指摘。6 の後、`pending` の行・別タスクの起動・遷移のロックの待ちの間に登録し直す・削除することがある）。最後の照合と送信のタスクの起動は、登録・削除と同じ排他（`state_lock`）の下で 1 つの手順として行い、違えば送らずに `key_changed` で行を確定する。排他は起動までで、Hub の応答は待たない。
- 送信を始めた後に登録し直しても送信は取り消さない（「タスク起動＝取り消さない境界」）。前のキーで Hub に届いた書込みの結果は、その行に残る。

O2c-3b-2 で決めたこと（2026-11-20）: Tauri の command は次のとおりにした。画面（O2c-4）はまだ無い。

- command は 4 つで、どれも Runtime の窓だけ（ACL の `runtime.json`、`require_runtime`）。`operations.db` は Runtime mode でだけ開くので、Editor では扱わない。
  - `operation_key_status`: 答えは `keyEndpoint`（キーを組にした接続先。無ければ null）・`hubEndpoint`（保存した読み用の接続先。無ければ null。`keyEndpoint` と違えば書込みは `hub_mismatch`）・`write`（`state`・`changedAtMs`）。秘密は返さない。権限の検査はしない。
  - `operation_key_register(secret)`: 保存した読み用の接続先と組にして登録する（O2c-3a の `register`。書込み状態は `ready`）。
  - `operation_key_delete`: キーを外す（書込み状態は変えない）。
  - `operation_write_resume`: 「書込みを再開」。`stopped` だけを `ready` にし、ほかの状態はそのまま答える。
  - 変える 3 つは、答えに `operation_key_status` と同じ形を返す。
- 権限は、認証のフェーズが `initializing`・`operational` であること（それ以外は `auth_phase_unavailable`）と、Admin であること（`require_role(Role::Admin, "operation")`）。開発・初期設定では認証無効の Admin なのでログイン不要、運用ではログインした Admin だけ。
- 権限の確認と変更の確定は、認証の遷移のロック（`AuthHost::gate`）の下で 1 つの手順として行う（`DesktopAuth::with_operation_settings`。#322 のオーナー指摘）。ログアウト・利用者の変更・運用への移行も同じロックを取るので、確認と変更の間に入らない。登録・削除はキーの排他（下記）を待ってから、このロックを取って確認する（待っている間にログアウトしたら、変えずに `unauthorized`）。ロックを取る順は、書込みの送信の開始（8）と同じく、遷移のロック → 書込み状態の排他（`state_lock`）で、逆にしない。
- 誤りは、権限の拒否（`unauthorized`・`forbidden`・`auth_unavailable`・`auth_failed`・`auth_phase_unavailable`）、記録を開けない `record_failed`、キーの誤り（`KeyError::as_str` の `no_hub`・`invalid_secret`・`invalid_endpoint`・`key_store`）。
- 登録と削除は端末で 1 つずつにする（`OperationState::key_lock`。遷移のロックより先に取る）。前の項目を読んでから切り替えるので、同時の登録で消されない項目が残らないようにする。
- 書込みと照会は、要求のたびに記録と keyring からキーを読む（`operation_key::load`）。keyring が読めないときはキーが無いものとし（`no_write_key`）、記録に残す。照会の `hub_mismatch` のため、照会にも読み用の接続先を渡す。
- 秘密の入力の扱い（画面での伏せ字・貼り付け）と、登録の結果の文言は O2c-4 で決める。

O2c-4 の分け方と O2c-4a で決めたこと（2026-11-20）: O2c-4 は、書き用キーの登録・削除・再開の画面（O2c-4a、O2c-3b-2 の command を使う）と、最小間隔の端末設定（O2c-4b、host の保存と command が要る）に分ける。O2c-4a は次のとおりにした。

- Runtime の上端に「書込み」の札を置き、押すと「書込みの端末設定」の窓を開く（警報の端末設定と同じ Modal）。札は `operation_key_status` を起動時と 5 秒おきに読み（重ねない。窓の答えより古い照会の結果では上書きしない）、キー未登録 → 接続先違い → 停止中 → キー無効 → キー登録済み の順に 1 つを出す。記録を開けない（`record_failed`）ときは「書込み: 停止」（§10）。Hub の書込み契約（`hub_unsupported`）は機器ごとの照会でしか分からないので、札では「書ける」と言わず「キー登録済み」とする。
- 窓は、保存した読み用の接続先、キー（未登録／登録済みと組にした接続先。違えば再登録を促す）、書込みの状態とその時刻を出す。キーの値は host から返らないので出さない。
- 秘密の入力欄は伏せ字（`type="password"`、`autocomplete="off"`）で、貼り付けを許す。前後の空白・改行（貼り付けで混ざるもの）だけを落として送り、空なら送らない。中の空白や形式は host が `invalid_secret` で断る。登録できたら入力を消し、窓を閉じたときも消す。
- 削除は窓の中で「削除しますか？」の確認を挟む。「書込みを再開」は `stopped` のときだけ出す。
- 権限は画面で先に判定せず、host の拒否（`unauthorized` など）を文にして出し、状態を読み直す。登録の結果は「最初の書込みで Hub がキーを確かめます」、再開は「次の書込みで Hub がもう一度確かめます」と添える（登録のときに Hub へ確かめないため。O2c-3a）。
