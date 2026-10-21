# temp-scada

`tyaro/banto-industrial`で計画するSCADAを並行開発する一時workspace。最終的に`apps/banto-scada`と`crates/scada-*`をindustrialへ戻します。現在はローカル工程図エディタと読取表示確認を提供し、正式Runtime・serverは開発中です。

## ドキュメント

| 確認すること                 | 入口                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| 設計・操作・機能別資料を探す | [文書索引](docs/README.md)                                                              |
| 今使える機能と残り           | [実装状況](docs/implementation-status.md)                                               |
| 編集の操作                   | [操作ガイド](docs/user-guide.md)                                                        |
| 次の工程・保留・統合         | [開発計画](docs/development-plan.md)・[単体開発計画](docs/upstream-independent-plan.md) |
| コード変更・検証             | [コード対応表](docs/code-map.md)・[検証手順](#検証)                                     |
| 過去の実装・検証             | [実装履歴](docs/implementation-history.md)                                              |

## 起動

Node **24 以上**、pnpm **10.33.0**、Rust **1.98.1**（rustfmt / clippy）を使用します。Tauri や PLC、Hub、DB、認証情報は現在のサンプル実行には不要です。

```sh
cd /workspace/temp-scada
bash scripts/cloud-install.sh
source scripts/cloud-env.sh
pnpm dev
```

`cloud-install.sh` はこの Linux x86_64 クラウド向けです。ツールとキャッシュを `/workspace/.toolchains`、`/workspace/.cache` に保存します。システム Chromium があれば E2E で利用し、なければ Playwright の Chromium を導入します。ローカルの別環境では上記バージョンのツールを用意して `pnpm install --frozen-lockfile` と `cargo fetch --locked` を実行してください。

画面ではサンプルの Rectangle / Ellipse / Text を表示します。「編集」→左の「部品」から図形を追加し、画面上のクリックまたは「レイヤー」の配置一覧で選択できます。画面・共有 Symbol の管理は「プロジェクト」で行います。ドラッグで移動、プロパティで座標・サイズ・色・文字列を変更して適用、選択図形を削除できます。「表示プレビュー」では同じ Project を編集用の枠なしで確認できます。Project JSON を開く、JSON を保存、画面を選択する操作ができます。読み込んだファイルが不正なら、現在表示中の Project を保持してエラーを表示します。アップロード先やネットワーク保存はありません。

同じフォルダー・連続する描画順の配置は、複数選択してCtrl／Command＋Gで幾何グループにできます。解除はCtrl／Command＋Shift＋Gです。選択・移動・90度回転・複製等を一単位で操作し、内部の個別編集は解除後に行います。[操作と初回の制約](docs/user-guide.md#guide-geometric-groups)を参照してください。

## 検証

```sh
source scripts/cloud-env.sh
pnpm check
pnpm test
pnpm build
pnpm e2e
pnpm format:check
cargo fmt --all --check
cargo clippy --workspace --locked --all-targets -- -D warnings
cargo test --workspace --locked
cargo run --locked -p scada-model -- validate examples/minimal.project.json
cargo run --locked -p scada-model -- validate examples/process.project.json
```

E2E は開発サーバーを自動起動します。既に同じサーバーを起動しているときは再利用します。

## Banto 基盤

industrial と同じ **Banto v6.7.0** を git サブディレクトリ依存で利用します。`pnpm-lock.yaml` は参照先コミット `1ffe507da973ca5103ede93b5ca438cda7c28d4e` を固定しています。

- `@banto/admin-core`: 起動時の `initBanto`、通知の接続、ローカル UI 設定の保存。
- `@banto/theme`: アプリ外枠のカラートークン、ダーク / ライト / OS 連動。
- `@banto/ui`: StatusBadge、ToastHost、Menu / MenuGroup / MenuItem、Modal。

現在は**ログインなしのローカルファイル編集**です。認証済みセッションは作らず、Project は Banto の CRUD リソースに見せかけず、既存の SCADA 編集コマンドと JSON 保存を使います。テーマとメニューバー表示の設定を Banto の UI 設定としてブラウザのストレージに保存し、ストレージが利用できなくても編集を継続できます。アプリのテーマ変更は Project 内の図形色やキャンバス背景を変更しません。

Banto の Rust サーバー・認証・ユーザー管理・Tauri の host はまだ接続していません。開発時はログイン不要、運用時はユーザー管理必須、再起動後はログインなしで閲覧専用の監視画面へ入る方針を [運用・ログイン方針](docs/access-policy.md) に記録しています。運用モードの切替機能は未実装です。

Rustの読取adapterは[型付きslot context](docs/typed-read-slots-design.md)にも対応します。0.23.0では[機器の保存と初期台帳](docs/equipment-register-design.md)も追加しました。0.24.0では[静的Symbolとの関連付け・使用先](docs/equipment-symbol-association.md)にも対応します。0.25.0では[共有Symbolの読取slotと割付状態表示](docs/symbol-read-slots.md)を追加しました。[表示DTOの受入とGood／Quality描画](docs/read-slot-presentation.md)も追加し、Rust共通fixtureとブラウザのテスト入力で検証します。[slot宣言の編集と参照保護](docs/symbol-slot-editing.md)にも対応します。[boolの型付き状態判定](docs/bool-slot-state.md)も追加しました。0.26.0で[bool Textの状態別文字色](docs/bool-text-colors.md)の編集と描画を追加しました。[図面外の読取状態一覧](docs/slot-status-summary.md)で件数・取得不能理由・SIMも確認できます。0.27.0で[共有図形・配管の状態色追従](docs/state-color-following.md)を追加しました。通常Designerの実Hub接続は後続です。

## リリース前の開発方針

機能開発を優先して領域を分離する方針を維持し、可動パネルと配置保存は UI 改訂提案の独立段階として検討します。固定 shell の整理、未適用入力の保持、同一画面内の浮動／再ドッキング、タグ選択 UX を段階化し、SDK に依存しない部分を先に進められるようにします。

リリース前の Project ファイルの後方互換性は保証しません。モデル変更が必要なら旧形式の移行処理を必須にせず、現行の schema・Rust / TypeScript・サンプル・検証を更新します。既存の `0.1.0` 読込対応は現在の実装の説明であり、今後も維持する約束ではありません。

## 構成

- `apps/banto-scada`: Svelte 5 / TypeScript / Vite の最小エディタと共通描画部品。将来 Tauri の host を追加する配置。
- `crates/scada-model`: GUI 非依存の Project 検証・JSON 往復と検証 CLI。
- `crates/scada-runtime`: 共有 SDK の current / metadata から読み取り表示へ投影するライブラリ。
- `crates/scada-model/schema/project.schema.json`: Rust / ブラウザ共通の初期 JSON Schema。
- `examples`: サンプルと、Rust / TypeScript が共に実行する契約テストのケース。
- `docs/upstream/industrial`: industrial の設計ドキュメントを変更せず保存した参照スナップショット。
- [開発・統合方針](docs/development-plan.md)

## 過去のリンクからの案内

従来の機能見出しへのリンクを維持する案内。詳しい操作は[操作ガイド](docs/user-guide.md)を参照する。

<details>
<summary>従来の機能見出しと操作ガイドの対応</summary>

| 従来の項目                                                                                | 操作ガイド                                 |
| ----------------------------------------------------------------------------------------- | ------------------------------------------ |
| <a id="フロントエンドの-ux-設計"></a>フロントエンドの UX 設計                             | [操作・仕様](docs/user-guide.md#guide-001) |
| <a id="画像描画表現運用画面の追加検討"></a>画像・描画表現・運用画面の追加検討             | [操作・仕様](docs/user-guide.md#guide-002) |
| <a id="別画面の埋込表示"></a>別画面の埋込表示                                             | [操作・仕様](docs/user-guide.md#guide-003) |
| <a id="画面内の小窓で表示確認"></a>画面内の小窓で表示確認                                 | [操作・仕様](docs/user-guide.md#guide-004) |
| <a id="全画面での表示確認"></a>全画面での表示確認                                         | [操作・仕様](docs/user-guide.md#guide-005) |
| <a id="図面上への画像配置"></a>図面上への画像配置                                         | [操作・仕様](docs/user-guide.md#guide-006) |
| <a id="クリップボード画像の貼り付け"></a>クリップボード画像の貼り付け                     | [操作・仕様](docs/user-guide.md#guide-007) |
| <a id="背景画像と持ち運べる保存"></a>背景画像と持ち運べる保存                             | [操作・仕様](docs/user-guide.md#guide-008) |
| <a id="サイドチャットの操作試作レビュー"></a>サイドチャットの操作試作レビュー             | [操作・仕様](docs/user-guide.md#guide-009) |
| <a id="project-の読み込み保存"></a>Project の読み込み・保存                               | [操作・仕様](docs/user-guide.md#guide-010) |
| <a id="名前の変更と操作ガイド"></a>名前の変更と操作ガイド                                 | [操作・仕様](docs/user-guide.md#guide-011) |
| <a id="studio-の外観"></a>Studio の外観                                                   | [操作・仕様](docs/user-guide.md#guide-012) |
| <a id="クリック位置へ連続配置"></a>クリック位置へ連続配置                                 | [操作・仕様](docs/user-guide.md#guide-013) |
| <a id="図形の線形グラデーション"></a>図形の線形グラデーション                             | [操作・仕様](docs/user-guide.md#guide-014) |
| <a id="繰返しパターン"></a>繰返しパターン                                                 | [操作・仕様](docs/user-guide.md#guide-015) |
| <a id="配置名とレイヤー検索"></a>配置名とレイヤー検索                                     | [操作・仕様](docs/user-guide.md#guide-016) |
| <a id="レイヤーフォルダー"></a>レイヤーフォルダー                                         | [操作・仕様](docs/user-guide.md#guide-017) |
| <a id="選択範囲を表示"></a>選択範囲を表示                                                 | [操作・仕様](docs/user-guide.md#guide-018) |
| <a id="配置の回転"></a>配置の回転                                                         | [操作・仕様](docs/user-guide.md#guide-019) |
| <a id="textの書式と枠内表示"></a>Textの書式と枠内表示                                     | [操作・仕様](docs/user-guide.md#guide-020) |
| <a id="配置全体の不透明度"></a>配置全体の不透明度                                         | [操作・仕様](docs/user-guide.md#guide-021) |
| <a id="色ごとの不透明度"></a>色ごとの不透明度                                             | [操作・仕様](docs/user-guide.md#guide-022) |
| <a id="中心の等間隔配置"></a>中心の等間隔配置                                             | [操作・仕様](docs/user-guide.md#guide-023) |
| <a id="複数選択の色編集"></a>複数選択の色編集                                             | [操作・仕様](docs/user-guide.md#guide-024) |
| <a id="線配管の一括スタイル編集"></a>線・配管の一括スタイル編集                           | [操作・仕様](docs/user-guide.md#guide-025) |
| <a id="実線破線点線"></a>実線・破線・点線                                                 | [操作・仕様](docs/user-guide.md#guide-026) |
| <a id="矩形楕円の塗りと枠線"></a>矩形・楕円の塗りと枠線                                   | [操作・仕様](docs/user-guide.md#guide-027) |
| <a id="矩形楕円の枠線をまとめて編集"></a>矩形・楕円の枠線をまとめて編集                   | [操作・仕様](docs/user-guide.md#guide-028) |
| <a id="配置の編集ロック"></a>配置の編集ロック                                             | [操作・仕様](docs/user-guide.md#guide-029) |
| <a id="図面の表示切替"></a>図面の表示切替                                                 | [操作・仕様](docs/user-guide.md#guide-030) |
| <a id="サンプルタグから選択"></a>サンプルタグから選択                                     | [操作・仕様](docs/user-guide.md#guide-031) |
| <a id="方向キーでの移動"></a>方向キーでの移動                                             | [操作・仕様](docs/user-guide.md#guide-032) |
| <a id="ルーラー"></a>ルーラー                                                             | [操作・仕様](docs/user-guide.md#guide-033) |
| <a id="コピー切り取り貼り付け"></a>コピー・切り取り・貼り付け                             | [操作・仕様](docs/user-guide.md#guide-034) |
| <a id="ミニマップ"></a>ミニマップ                                                         | [操作・仕様](docs/user-guide.md#guide-035) |
| <a id="お気に入り部品"></a>お気に入り部品                                                 | [操作・仕様](docs/user-guide.md#guide-036) |
| <a id="プロジェクトとレイヤーのツリー"></a>プロジェクトとレイヤーのツリー                 | [操作・仕様](docs/user-guide.md#guide-037) |
| <a id="プロパティの数値入力"></a>プロパティの数値入力                                     | [操作・仕様](docs/user-guide.md#guide-038) |
| <a id="パネルの幅"></a>パネルの幅                                                         | [操作・仕様](docs/user-guide.md#guide-039) |
| <a id="下部パネルの高さ"></a>下部パネルの高さ                                             | [操作・仕様](docs/user-guide.md#guide-040) |
| <a id="画面の背景色"></a>画面の背景色                                                     | [操作・仕様](docs/user-guide.md#guide-041) |
| <a id="runtime-の-sdk-境界"></a>Runtime の SDK 境界                                       | [操作・仕様](docs/user-guide.md#guide-044) |
| <a id="タグ表示の割り当て"></a>タグ表示の割り当て                                         | [操作・仕様](docs/user-guide.md#guide-045) |
| <a id="工程図を試す"></a>工程図を試す                                                     | [操作・仕様](docs/user-guide.md#guide-046) |
| <a id="編集履歴と配置操作"></a>編集履歴と配置操作                                         | [操作・仕様](docs/user-guide.md#guide-047) |
| <a id="複数選択整列"></a>複数選択・整列                                                   | [操作・仕様](docs/user-guide.md#guide-048) |
| <a id="グリッドスナップと配管頂点の直接編集"></a>グリッド・スナップと配管頂点の直接編集   | [操作・仕様](docs/user-guide.md#guide-049) |
| <a id="キャンバスでのサイズ変更"></a>キャンバスでのサイズ変更                             | [操作・仕様](docs/user-guide.md#guide-050) |
| <a id="複数画面の管理"></a>複数画面の管理                                                 | [操作・仕様](docs/user-guide.md#guide-051) |
| <a id="symbol-ライブラリと定義編集"></a>Symbol ライブラリと定義編集                       | [操作・仕様](docs/user-guide.md#guide-052) |
| <a id="部品の検索と配置"></a>部品の検索と配置                                             | [操作・仕様](docs/user-guide.md#guide-053) |
| <a id="ズーム全体表示パン"></a>ズーム・全体表示・パン                                     | [操作・仕様](docs/user-guide.md#guide-054) |
| <a id="編集ワークスペースとスクリーンショット"></a>編集ワークスペースとスクリーンショット | [操作・仕様](docs/user-guide.md#guide-055) |

</details>
