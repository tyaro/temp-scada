# Banto SCADA — 一時開発 workspace

状態: **最小エディタ実装済み**。図形の追加・選択・移動・プロパティ編集・削除、Project JSON の保存・読込と表示プレビュー。Hub 接続・設備操作は未実装。

`tyaro/banto-industrial` で計画している SCADA を、同リポジトリの開発と並行して作るための一時 workspace です。最終的に `apps/banto-scada` と `crates/scada-*` を industrial に戻します。

## 起動

Node **24 以上**、pnpm **10.33.0**、Rust **1.98.1**（rustfmt / clippy）を使用します。Tauri や PLC、Hub、DB、認証情報は現在のサンプル実行には不要です。

```sh
cd /workspace/temp-scada
bash scripts/cloud-install.sh
source scripts/cloud-env.sh
pnpm dev
```

`cloud-install.sh` はこの Linux x86_64 クラウド向けです。ツールとキャッシュを `/workspace/.toolchains`、`/workspace/.cache` に保存します。システム Chromium があれば E2E で利用し、なければ Playwright の Chromium を導入します。ローカルの別環境では上記バージョンのツールを用意して `pnpm install --frozen-lockfile` と `cargo fetch --locked` を実行してください。

画面ではサンプルの Rectangle / Ellipse / Text を表示します。「編集」で図形を追加し、画面上のクリックまたは図形一覧で選択できます。ドラッグで移動、プロパティで座標・サイズ・色・文字列を変更して適用、選択図形を削除できます。「表示プレビュー」では同じ Project を編集用の枠なしで確認できます。Project JSON を開く、JSON を保存、画面を選択する操作ができます。読み込んだファイルが不正なら、現在表示中の Project を保持してエラーを表示します。アップロード先やネットワーク保存はありません。

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
```

E2E は開発サーバーを自動起動します。既に同じサーバーを起動しているときは再利用します。

## 構成

- `apps/banto-scada`: Svelte 5 / TypeScript / Vite の最小エディタと共通描画部品。将来 Tauri の host を追加する配置。
- `crates/scada-model`: GUI 非依存の Project 検証・JSON 往復と検証 CLI。
- `crates/scada-model/schema/project.schema.json`: Rust / ブラウザ共通の初期 JSON Schema。
- `examples`: サンプルと、Rust / TypeScript が共に実行する契約テストのケース。
- `docs/upstream/industrial`: industrial の設計ドキュメントを変更せず保存した参照スナップショット。
- [開発・統合方針](docs/development-plan.md)

これは S0 / S1 / S2 の最小部分です。JSON 形式 `0.1.0` は開発用の暫定契約で、設計上の正式な `.bantoscada` directory / ZIP パッケージではありません。バージョン不一致や未知のフィールドは拒否し、未対応情報を黙って捨てません。ID は lowercase UUID v7、座標は有限数、表示順は明示的な `order`、SVG は `xMidYMid meet` を使用します。

変更は JSON ファイルへの保存までブラウザ内だけに保持されます。ページを再読込する前に保存してください。編集コマンドはコピー上で検証し、成功時に revision を増やします。Undo / Redo、複数選択、グループ化、正式な Runtime の起動時 mode・Rust 側の権限分離はまだありません。
