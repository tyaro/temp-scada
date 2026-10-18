# SCADA の独立開発と industrial への統合

状態: **S0 / S1 / S2 の最小基盤と図形エディタを実装。Core v1 全体は未実装**。
決定日: 2026-10-18。ユーザー指示: industrial の開発を継続しつつ temp-scada で SCADA を先行開発し、最終的に industrial に戻す。

## 参照元

- repository: https://github.com/tyaro/banto-industrial
- branch: main（取得時点）
- commit: `c4a61bc08ddf6d03fa56974bf1fcad08d12cbb5a`
- [SCADA 設計書](upstream/industrial/scada-design.md)
- [ドキュメント索引](upstream/industrial/README.md)
- [Hub client SDK](upstream/industrial/banto-tagclient-design.md)
- [実装時の注意点](upstream/industrial/implementation-checklist.md)

`docs/upstream/industrial` は出典コミットの `docs/` 全体をそのままコピーした参照用スナップショットです。文書間のリンクを保つため全体を保存しています。リポジトリ外やコードへの相対リンクは元の GitHub の同コミットを参照してください。上流の「実装済み」は industrial 側の状態を指します。§20 の monorepo 配置の決定は維持し、ここでの独立開発を一時的な例外として扱います。コピーした原文は編集せず、この文書に独立開発上の差分を記録します。

## 現在できること

- 共通 JSON Schema による Project の検証。UUID v7、未知フィールド拒否、サイズ・図形・色の検証。
- ID の Project 内一意性、画面内 `order` 一意性の確認。
- Rust CLI でサンプルを検証し、ライブラリで JSON の読込・シリアライズを往復。
- ブラウザで静的 SVG 表示、画面切替、JSON ダウンロード・ファイル読込。不正な読込は元の Project を保持。
- Rust と TypeScript が同じサンプル・不正データのケースを使用。ブラウザ E2E で保存・再読込も確認。

図形の追加・選択・ドラッグ移動・座標 / サイズ / 色 / 文字列の編集・削除に対応しました。変更は frontend の共通編集コマンドを通し、コピー上で検証した後に反映します。ID を保持し、成功した操作ごとに revision を増やします。ブラウザ E2E で、編集・ドラッグ・保存・再読込後の表示一致を検証します。表示プレビューは編集用の枠や操作を外して同じ描画部品を使います。

Editor / Runtime の正式な起動時 mode や Rust 側の権限境界はまだ実装していません。PLC 書込みや式評価、アクション実行への経路もありません。ダウンロードは現在の Project の JSON 保存です。revision は編集時に増加し、内容を変えずにダウンロードするときは増加させません。contentHash、外部変更の競合判定、migration は後続です。

## 参考画面から整理した対象（2026-10-18）

ユーザー提供の塗装ラインの参考画面を、作成したい画面の種類・情報量・操作の参考とする。色、固定レイアウト、工程名や機器番号を製品仕様として固定しない。目標は、これらの画面を Project として作る汎用エディタと、その Project を実行するランタイムである。

優先するのは設備監視の画面を作る基盤:

- 工程フロー図: 配管、ダクト、槽、搬送経路、流れの方向、設備の接続を表現する。
- 再利用できる設備シンボル: ポンプ、ファン、バルブ、ダンパー、ヒーター、ロボット等。設備ごとの値・状態を割り付け、定義を複数箇所で使う。
- 動的表示: 数値・単位・桁数、実測値 / 設定値、運転 / 停止 / 異常、色・表示条件、通信断や値の Quality を扱う。
- 画面構成: 複数画面、階層ナビゲーション、状態カード、設備一覧、詳細パネル / Faceplate、機器を選んだときの画面遷移を定義する。
- 編集操作: 部品配置、選択・移動・リサイズ、整列・グループ化、プロパティ編集、タグ割付、保存とプレビューを段階的に用意する。

画像にはプロセス図と一覧・カード・グラフが組み合わされている。工程図は SVG を基本とし、表や入力・グラフ等の widget を組み合わせられる境界を設計する。全ての widget の描画方式を SVG に固定するかどうかは未決とする。

参考画面のトレンド・Alarm は引き続き v1.1。設備監視の基盤を先に作り、履歴・警報エンジンの実装を今回の参考画像だけで前倒ししない。電力集計や保全管理も、集計・記録・業務処理が必要な部分は後続とする。

MES 寄りの生産計画、マスタ編集、生産・検査実績、トレーサビリティ、作業指示、在席ワーク管理、稼働ガント等は後回しとする。工程名や位置を表示する共通の描画部品と、ワーク追跡・業務データを管理する機能を分ける。

最初の代表画面は、前処理のような「槽・配管・ポンプ・計測値」を含む小さな工程図を候補とする。これを部品として配置・編集・保存し、同じ Project をランタイムで再現できることを先に検証する。初期の模擬値は実機の状態と区別して表示し、その後 Hub の値に接続する。この候補は実装済み機能やユーザー指定の確定レイアウトではない。

## 次の実装順

1. S0 / S1 を拡張: Design Domain、正式 Project layout、型・参照整合性・revision / contentHash の規則を固める。
2. S2 を拡張: オブジェクトの配置・選択・移動・プロパティ編集を Design Domain 経由で実装。
3. S3: `banto-tagclient` で Hub 接続、`external_name` によるライブ値・Quality の表示。Hub 停止と再接続を検証。
4. S4: `.bantoscada` directory / ZIP、import preview、migration、互換性確認。
5. 基本 Editor、Tag Browser、Equipment / Symbol、基本 Action と mode の分離を段階的に追加。

v1.1 の recorder / History / Alarm と Windows サービス化、および後続 Extension は今は作りません。Design Domain は Core v1 に含めますが、Design API の REST / OpenAPI 公開は後続です（上流 §3）。

## 外部の参考実装の取り扱い

`https://github.com/tyaro/ems-apps` は操作感や情報構成の参考に限る。ユーザー指示（2026-10-18）に従い、画面・コンポーネント・画像等のコードやアセットをこのリポジトリへ取り込まない。SCADA のエディタとランタイムはこちらの設計に沿って独立実装する。

## 共有部品の扱い

SCADA は PLC に直接接続しません。Hub を独立した外部サービスとして利用し、SCADA 側に PLC ドライバをコピーしません。式評価を TypeScript で再実装しません。

`banto-tagclient` / `banto-expr` が必要になった時点で、industrial の動作確認済みコミットを `git + rev` に固定して依存に追加します。最初の参照候補は上記コミットです。現在の静的ビューアは両 crate をまだ使用しないため、未使用の依存は導入していません。SDK の変更が必要になったら industrial 側で共有契約を変更してから参照を更新します。

## 戻す手順

- `apps/banto-scada` / `crates/scada-*` と固有のサンプル・テストを元の配置へ移す。
- 共有 crate の `git + rev` 参照を industrial workspace の既存 `path` 参照に変更する。
- frontend / Rust の workspace、必要な依存、lockfile を industrial 側で統合する。この一時 repo のルート設定で上流の設定全体を置換しない。
- industrial の CI にある SCADA 追加手順に従い、path-aware CI と frontend / E2E の対象に追加する。
- SCADA の検証と、影響した Hub / 共有 crate の回帰検証を実行する。
- この repo の独立開発上の決定を上流設計書に反映する。参照元コミットと再統合時の upstream 差分をレビューする。
