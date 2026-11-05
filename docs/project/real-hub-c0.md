# 実Hub・S7接続 C0: Windows 実行条件と初回読取経路

確認: 2026-11-05（日本時間）。対象はこの Windows PC 上の既存 Hub とする。秘密情報はこの文書へ保存しない。

## 確認した構成

- `BantoHub` と `BantoHubSink` は Windows サービスとして稼働中。Hub 本体は `C:\Program Files\BantoHub\banto-hub.exe`、REST／管理 UI は `127.0.0.1:8722`。既存サービスは SCADA の所有物ではなく、SCADA は起動・停止・構成変更しない。
- 管理 UI の表示版は `0.3.0-alpha.1`、タグ空間 API は `v1`。Hub は未ロックダウンの試運転状態。`GET /api/commissioning/status` は `X-Banto-Client: banto` 付きで `200 {"lockedDown":false}`、無しでは CSRF 検査で `403`。`GET /api/v1/tags` は API キー無しで `401`。
- 既存の `s7-bridge.s7-bridge-g.temperature`（f32）、`pressure`（f32）、`running`（bit）は Hub 管理画面のモニタで値と「良好」を表示する。`s7-sim` は別の SIM 接続として表示される。`s7-db-source` は SQL 収集である。
- 2026-11-05 13:05 頃の Hub 画面で `temperature=44`、`pressure=101.3`、`running=1` を観測。ただし `s7-bridge.s7-bridge-g.updated_at` の値は 2026-11-01 05:26:48.271（日本時間）相当で、PLC からの新しい読取時刻を証明しない。対象タグと鮮度の実機側確認を C3 の受入条件に残す。
- `banto-industrial` の現行 `main` は `24e1dfe8435900500cdb13e6f28544a5fc732a63`。本リポジトリの固定 SDK `33410f6d25d36559c5ce81375e243eb6f3e85038` はその祖先であり、固定版から現行版まで `crates/banto-tagclient` と `crates/banto-hub-bootstrap` のソース差分はない。初回読取のために SDK を更新しない。

## 採用する初回読取経路

- Windows の Tauri 2 shell に SCADA server core の最初の埋込 host を置く。UI とは Tauri command／event IPC で接続し、ブラウザから Hub へ直接接続せず、新しい無認証 HTTP 待受を作らない。既存の Vite 単体起動はログイン不要のオフライン編集として維持する。
- host が固定 SDK、`ReadHost`、`CatalogHost` と Hub 接続先を所有する。UI に渡すのは既存の表示 DTO と catalog 選択 DTO、接続状態だけ。Project とブラウザ storage へ資格情報を入れない。
- 初回接続の Hub 認証は、上流の `banto-hub-bootstrap` の現行契約を使う。試運転中の同一 PC では短命 grant で `read` スコープだけの API キーを自己発行し、grant を logout で破棄する。キーは OS の保護ストア、非機密の接続記録はアプリ設定に保存し、起動ごとの再発行を避ける。ロックダウン後は管理者発行の read キーを明示採用する。運用時のユーザー管理・操作認可は後続で確定する。
- 接続先切替、Project 置換、切断では host と UI の読取 session を先に無効化する。旧通知を新 session に適用しない。SDK が再接続・品質を判定し、SCADA はその状態を投影する。

## 実装と受入の区切り

1. C1a: Tauri shell、接続先設定・保護ストア、bootstrap、単一 native owner を作る。既存 Hub サービスとの二重起動はしない。
2. C1b: `ReadHost`／`CatalogHost` を既存 `ReadSource`／`CatalogSource` に配送し、数値 Text・number/bool slot・タグ選択を通常 entrypoint で動かす。
3. C2: 同じ shell／IPC でモック Hub、取消・再接続・Project 置換・Bad／Stale・Unauthorized を検証する。
4. C3: 実 Hub の対象タグで現在値・品質・SIM 区別を照合し、元 S7 の更新時刻と値の新鮮さを確認する。実機側サービスの再起動や故障注入は行わない。

[採用計画](real-hub-connection-plan.md)と[P3b 境界](../design/runtime/transport-boundary.md)の完了条件を維持する。この C0 記録だけで C1〜C3 を完了扱いしない。

## 読取専用 REST 試行（2026-11-05 13:17:54 JST）

`scada-host` の Windows 資格情報ストア実装と固定 `banto-hub-bootstrap`／`banto-tagclient` を使い、既存の `127.0.0.1:8722` に接続した。bootstrap は `connected`、catalog は revision 1／113タグ。`read` スコープのキーは Windows 資格情報ストアに保存し、非機密の接続記録は `%LOCALAPPDATA%/temp-scada/hub-read.json` に保存した。キー値は出力・Project・リポジトリへ保存していない。Hub サービスやタグ構成は変更していない。

`GET /api/v1/values` の SDK 応答は `temperature=44`、`pressure=101.3`、`running=1`。3件とも `quality=good`、`value_source=push`、行の時刻は 13:17:53.811 JST。応答時刻は 13:17:54.059 JST。別タグ `updated_at` の値は 2026-11-01 05:26:48.271 JST を示す。Hub までの配送は現在進行だが、元 S7 の値が同時刻に更新された証拠ではない。C3 の実機由来・鮮度受入は保留する。

実行入口は `cargo run -p scada-host --example real_hub_read`。対象タグ名はこのローカル環境の検証用で、他の設備に自動適用しない。

## C1 製品画面での読取（2026-11-05）

Tauri 2 のデスクトップを通常 entrypoint で起動し、`examples/real-hub-s7.project.json` を読み込んだ。Tauri host の読取専用 `ReadHost`／`CatalogHost` が既存 Hub へ接続し、画面の数値 Text に温度 `44`、機器詳細の number slot に `44`、bool slot に `true` を表示した。いずれも `Good`、由来 `push`、catalog revision 1、SIM 0件である。意図的に未割付／存在しないタグへ結び付けた4件は取得不能として表示した。

切断直後は表示値が消え、取得不能8件に変わった。再接続後は再び取得不能4件となり、数値と bool が復帰した。再接続時に新しい配送を画面が追跡しない問題を修正し、ブラウザの接続源切替試験でも確認した。native IPC adapter の単体試験で旧購読通知の破棄と開始失敗の扱いを確認した。`push` は Hub への投入方式を表し、元 PLC の現在値・SIM／非SIMを証明しない。したがって C3 の実機由来と鮮度の受入は保留する。C2 のモック Hub による認証拒否・品質変化・再接続を含む製品経路検証も後続で行う。
