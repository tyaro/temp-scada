# temp-scada

`tyaro/banto-industrial`で計画するSCADAを並行開発する一時workspace。最終的に`apps/banto-scada`と`crates/scada-*`をindustrialへ戻します。現在はローカル工程図エディタと読取表示確認を提供し、正式Runtime・serverは開発中です。

- [現在の実装状況](docs/implementation-status.md): 対応機能、保存契約、検証範囲、未実装。
- [操作ガイド](docs/user-guide.md): 編集、画像、画面再利用、入力保護、パネルとキー操作。
- [開発計画](docs/development-plan.md)と[実装履歴](docs/implementation-history.md): 今後と過去を分離。
- [埋込画面のコピー](docs/screen-view-clipboard-design.md): 参照画面・Symbol・画像原本の同梱と再利用。
- [マウスによる切出し調整](docs/image-crop-pointer-design.md): 原本上の指定・移動・サイズ変更と取消。
- [背景の数値トリミング](docs/background-image-crop-design.md): 背景4方式と原本・切出しの保持。
- [画像の表示方式](docs/image-fit-design.md): contain／cover／stretchと切出し・原本保持。
- [機器種別の編集](docs/equipment-type-editing.md): 任意のbool／number読取slotと採用保護。
- [機器の読取詳細](docs/equipment-read-details.md): 採用信号の状態と機器ごとの読取小窓。
- [共有図形・配管の状態色追従](docs/state-color-following.md): bool状態色、参照保護と実画面。
- [統合設計](docs/scada-integrated-design.md): 機能仕様の基準。
- [コードと検証の対応表](docs/code-map.md): 変更対象の責務・入口・関連テスト。
- [リファクタリング計画](docs/maintenance-refactoring-plan.md): R0〜R5の責務・不変条件・検証と進捗。

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

機能別の詳しい操作は[操作ガイド](docs/user-guide.md)に集約しています。以下は従来の見出しへのリンクを維持する案内です。

## フロントエンドの UX 設計

[操作ガイドの該当節](docs/user-guide.md#guide-001)へ移動しました。

## 画像・描画表現・運用画面の追加検討

[操作ガイドの該当節](docs/user-guide.md#guide-002)へ移動しました。

## 別画面の埋込表示

[操作ガイドの該当節](docs/user-guide.md#guide-003)へ移動しました。

## 画面内の小窓で表示確認

[操作ガイドの該当節](docs/user-guide.md#guide-004)へ移動しました。

## 全画面での表示確認

[操作ガイドの該当節](docs/user-guide.md#guide-005)へ移動しました。

## 図面上への画像配置

[操作ガイドの該当節](docs/user-guide.md#guide-006)へ移動しました。

## クリップボード画像の貼り付け

[操作ガイドの該当節](docs/user-guide.md#guide-007)へ移動しました。

## 背景画像と持ち運べる保存

[操作ガイドの該当節](docs/user-guide.md#guide-008)へ移動しました。

## サイドチャットの操作試作レビュー

[操作ガイドの該当節](docs/user-guide.md#guide-009)へ移動しました。

## Project の読み込み・保存

[操作ガイドの該当節](docs/user-guide.md#guide-010)へ移動しました。

## 名前の変更と操作ガイド

[操作ガイドの該当節](docs/user-guide.md#guide-011)へ移動しました。

## Studio の外観

[操作ガイドの該当節](docs/user-guide.md#guide-012)へ移動しました。

## クリック位置へ連続配置

[操作ガイドの該当節](docs/user-guide.md#guide-013)へ移動しました。

## 図形の線形グラデーション

[操作ガイドの該当節](docs/user-guide.md#guide-014)へ移動しました。

## 繰返しパターン

[操作ガイドの該当節](docs/user-guide.md#guide-015)へ移動しました。

## 配置名とレイヤー検索

[操作ガイドの該当節](docs/user-guide.md#guide-016)へ移動しました。

## レイヤーフォルダー

[操作ガイドの該当節](docs/user-guide.md#guide-017)へ移動しました。

## 選択範囲を表示

[操作ガイドの該当節](docs/user-guide.md#guide-018)へ移動しました。

## 配置の回転

[操作ガイドの該当節](docs/user-guide.md#guide-019)へ移動しました。

## Textの書式と枠内表示

[操作ガイドの該当節](docs/user-guide.md#guide-020)へ移動しました。

## 配置全体の不透明度

[操作ガイドの該当節](docs/user-guide.md#guide-021)へ移動しました。

## 色ごとの不透明度

[操作ガイドの該当節](docs/user-guide.md#guide-022)へ移動しました。

## 中心の等間隔配置

[操作ガイドの該当節](docs/user-guide.md#guide-023)へ移動しました。

## 複数選択の色編集

[操作ガイドの該当節](docs/user-guide.md#guide-024)へ移動しました。

## 線・配管の一括スタイル編集

[操作ガイドの該当節](docs/user-guide.md#guide-025)へ移動しました。

## 実線・破線・点線

[操作ガイドの該当節](docs/user-guide.md#guide-026)へ移動しました。

## 矩形・楕円の塗りと枠線

[操作ガイドの該当節](docs/user-guide.md#guide-027)へ移動しました。

## 矩形・楕円の枠線をまとめて編集

[操作ガイドの該当節](docs/user-guide.md#guide-028)へ移動しました。

## 配置の編集ロック

[操作ガイドの該当節](docs/user-guide.md#guide-029)へ移動しました。

## 図面の表示切替

[操作ガイドの該当節](docs/user-guide.md#guide-030)へ移動しました。

## サンプルタグから選択

[操作ガイドの該当節](docs/user-guide.md#guide-031)へ移動しました。

## 方向キーでの移動

[操作ガイドの該当節](docs/user-guide.md#guide-032)へ移動しました。

## ルーラー

[操作ガイドの該当節](docs/user-guide.md#guide-033)へ移動しました。

## コピー・切り取り・貼り付け

[操作ガイドの該当節](docs/user-guide.md#guide-034)へ移動しました。

## ミニマップ

[操作ガイドの該当節](docs/user-guide.md#guide-035)へ移動しました。

## お気に入り部品

[操作ガイドの該当節](docs/user-guide.md#guide-036)へ移動しました。

## プロジェクトとレイヤーのツリー

[操作ガイドの該当節](docs/user-guide.md#guide-037)へ移動しました。

## プロパティの数値入力

[操作ガイドの該当節](docs/user-guide.md#guide-038)へ移動しました。

## パネルの幅

[操作ガイドの該当節](docs/user-guide.md#guide-039)へ移動しました。

## 下部パネルの高さ

[操作ガイドの該当節](docs/user-guide.md#guide-040)へ移動しました。

## 画面の背景色

[操作ガイドの該当節](docs/user-guide.md#guide-041)へ移動しました。

## Runtime の SDK 境界

[操作ガイドの該当節](docs/user-guide.md#guide-044)へ移動しました。

## タグ表示の割り当て

[操作ガイドの該当節](docs/user-guide.md#guide-045)へ移動しました。

## 工程図を試す

[操作ガイドの該当節](docs/user-guide.md#guide-046)へ移動しました。

## 編集履歴と配置操作

[操作ガイドの該当節](docs/user-guide.md#guide-047)へ移動しました。

## 複数選択・整列

[操作ガイドの該当節](docs/user-guide.md#guide-048)へ移動しました。

## グリッド・スナップと配管頂点の直接編集

[操作ガイドの該当節](docs/user-guide.md#guide-049)へ移動しました。

## キャンバスでのサイズ変更

[操作ガイドの該当節](docs/user-guide.md#guide-050)へ移動しました。

## 複数画面の管理

[操作ガイドの該当節](docs/user-guide.md#guide-051)へ移動しました。

## Symbol ライブラリと定義編集

[操作ガイドの該当節](docs/user-guide.md#guide-052)へ移動しました。

## 部品の検索と配置

[操作ガイドの該当節](docs/user-guide.md#guide-053)へ移動しました。

## ズーム・全体表示・パン

[操作ガイドの該当節](docs/user-guide.md#guide-054)へ移動しました。

## 編集ワークスペースとスクリーンショット

[操作ガイドの該当節](docs/user-guide.md#guide-055)へ移動しました。

0.28.0で[配置画像の表示方式](docs/image-fit-design.md)にcontain／cover／stretchを追加しました。切出し・原本・配置枠を保持し、編集・表示プレビュー・埋込・小窓・ミニマップの共通描画へ接続します。

0.29.0で[背景画像の数値トリミング](docs/background-image-crop-design.md)を追加しました。配置と共通の数値契約を使い、背景4方式・原本保持・取込の世代保護へ接続します。
