# Banto SCADA — 一時開発 workspace

状態: **Banto 基盤の最小工程図エディタを実装済み**。図形の追加・選択・移動・プロパティ編集・削除、Project JSON の保存・読込と表示プレビュー。線・配管と再利用可能なポンプ / バルブの Symbol に対応。Hub 接続・設備操作は未実装。

`tyaro/banto-industrial` で計画している SCADA を、同リポジトリの開発と並行して作るための一時 workspace です。最終的に `apps/banto-scada` と `crates/scada-*` を industrial に戻します。

## Banto 基盤

industrial と同じ **Banto v6.7.0** を git サブディレクトリ依存で利用します。`pnpm-lock.yaml` は参照先コミット `1ffe507da973ca5103ede93b5ca438cda7c28d4e` を固定しています。

- `@banto/admin-core`: 起動時の `initBanto`、通知の接続、ローカル UI 設定の保存。
- `@banto/theme`: アプリ外枠のカラートークン、ダーク / ライト / OS 連動。
- `@banto/ui`: PageHeader、SurfaceCard、StatusBadge、ToastHost。

現在は**ログインなしのローカルファイル編集**です。認証済みセッションは作らず、Project は Banto の CRUD リソースに見せかけず、既存の SCADA 編集コマンドと JSON 保存を使います。テーマ設定だけをブラウザのストレージに保存し、ストレージが利用できなくても編集を継続できます。アプリのテーマ変更は Project 内の図形色やキャンバス背景を変更しません。

Banto の Rust サーバー・認証・ユーザー管理・Tauri の host はまだ接続していません。開発時はログイン不要、運用時はユーザー管理必須、再起動後はログインなしで閲覧専用の監視画面へ入る方針を [運用・ログイン方針](docs/access-policy.md) に記録しています。運用モードの切替機能は未実装です。

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

## 工程図を試す

サイドバーの「工程図サンプルを開く」で、槽・配管・ポンプ・バルブの静的な配置例を表示できます。「編集」で部品を追加し、「表示プレビュー」で同じ Project の表示を確認します。現在の編集内容をサンプルで置き換える場合は確認を表示します。

- 「線を追加」「配管を追加」は折れ線を配置します。全体をドラッグで移動でき、プロパティの「頂点」に `x,y` を 1 行ずつ入力して経路を変更します。座標はオブジェクトの原点からの design unit で、負数も使えます。線幅・色・終点の矢印も変更できます。
- 「ポンプを追加」「バルブを追加」は Project 内の共有 Symbol 定義を参照する配置インスタンスを作ります。同じ部品を複数配置しても定義は増えません。インスタンスごとに位置・表示サイズ・色を変更できます。
- サンプルは [examples/process.project.json](examples/process.project.json)。`ems-apps` のコード・画像は使用せず、このリポジトリで作った図形です。数値表示や設備状態・操作には接続していません。

機器への配管の自動追従・接続判定、Symbol 定義そのものの編集、Symbol の入れ子は未対応です。現在の Symbol は単色の表示部品で、Equipment のタグ割付や動的状態は後続です。

## 編集履歴と配置操作

「編集」では次の操作が使えます。

- 「元に戻す / やり直す」: 最大 50 操作の Project 内容を保持します。新たな編集をするとやり直し履歴を消し、別の JSON やサンプルを読み込むと履歴をリセットします。履歴はファイルに保存しません。
- 「選択図形を複製」: 新しい配置 ID で右下へ 20 design unit ずらして作成します。Symbol は配置インスタンスのみの複製で、定義を共有します。配管の頂点列は独立して編集できます。
- 「最背面 / 1 つ背面 / 1 つ前面 / 最前面」: 同一画面内の明示的な `order` を更新します。ID は変えません。
- キーボード: `Ctrl / ⌘ + Z` で元に戻す、`Ctrl / ⌘ + Shift + Z` または `Ctrl + Y` でやり直す、`Ctrl / ⌘ + D` で選択図形の配置を複製します。入力欄内ではこれらのアプリ操作を実行せず、文字入力の標準操作を使えます。表示プレビューでは編集ショートカットを受け付けません。

Undo / Redo で内容を復元しても、Project の revision は現在値から増加させます。内容が変わらない適用や重なり順の端での移動は、revision と履歴を変更しません。

## 複数選択・整列

- キャンバスや図形一覧で `Shift + クリック` すると、選択を追加・解除できます。図形一覧の通常クリックは単一選択です。「すべて選択」または入力欄以外で `Ctrl / ⌘ + A` を使うこともできます。
- 選択済みの図形をドラッグすると、複数の配置を相対位置を保ってまとめて移動します。複数選択時のプロパティでは「移動量 X / Y」に design unit を入力し、数値指定でもまとめて移動できます。
- 複数選択時も「選択図形を複製 / 削除」と `Ctrl / ⌘ + D` が使えます。複製後は新しい配置を選択し、もとの重なり順・相対位置と Symbol 定義の共有を維持します。
- 整列は選択全体の外枠を基準とする左・右・上・下・左右中央・上下中央です。Symbol は定義の表示領域、配管は線幅・矢印を含めた選択枠を使います。
- まとめての移動・複製・削除・整列はそれぞれ 1 操作として Undo / Redo できます。選択の切替自体は履歴や Project のデータを変更しません。表示プレビュー、画面切替、別 Project の読み込みでは選択を解除します。

これは一時的な複数選択です。保存されるグループ、ドラッグによる範囲選択、均等配置は未対応です。

## グリッド・スナップと配管頂点の直接編集

「編集」のグリッド設定で、表示とスナップをそれぞれ有効にできます。間隔は 5 / 10 / 20 / 50 design unit。初期状態では表示・スナップとも無効です。これらは編集補助の設定で、Project に保存せず、変更しても revision や履歴は増えません。

- 図形全体のドラッグでは、つかんだ図形の原点を画面のグリッドへ合わせます。複数選択では同じ移動量を適用し、相対位置を保持します。全ての配置を個別にグリッドへ丸める方式ではありません。
- 配管を単一選択すると頂点ハンドルが表示されます。ハンドルをドラッグすると、その頂点だけを変更できます。スナップ時は画面上の座標をグリッドへ合わせ、配管内の local 座標へ戻して保存します。
- ハンドルにフォーカスして方向キーを押すと 1 unit、Shift 併用で 10 unit 移動します。スナップが有効なら操作した軸の次のグリッド線へ移動します。
- Alt を押してドラッグするとスナップを一時解除できます。Esc または pointer cancel で進行中のドラッグを取り消します。クリックしただけではグリッドに吸着させません。
- ドラッグ中はプレビューのみを更新し、離したときに検証して 1 操作として確定します。線が完全につぶれる等の不正な編集は拒否して元へ戻します。既存の数値入力・頂点テキスト編集・整列にはスナップを強制しません。

グリッドと頂点ハンドルは表示プレビューには出ません。端点を機器へ結び付ける機能や自動配管は引き続き未対応です。

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

## 構成

- `apps/banto-scada`: Svelte 5 / TypeScript / Vite の最小エディタと共通描画部品。将来 Tauri の host を追加する配置。
- `crates/scada-model`: GUI 非依存の Project 検証・JSON 往復と検証 CLI。
- `crates/scada-model/schema/project.schema.json`: Rust / ブラウザ共通の初期 JSON Schema。
- `examples`: サンプルと、Rust / TypeScript が共に実行する契約テストのケース。
- `docs/upstream/industrial`: industrial の設計ドキュメントを変更せず保存した参照スナップショット。
- [開発・統合方針](docs/development-plan.md)

これは S0 / S1 / S2 の最小部分です。JSON 形式 `0.2.0` は開発用の暫定契約で、設計上の正式な `.bantoscada` directory / ZIP パッケージではありません。旧 `0.1.0` は旧 schema で検証した後、ID・配置・revision を保持して `0.2.0` へ移行し、空の Symbol 定義を追加します。保存時は `schemaVersion` と `minRuntimeVersion` を `0.2.0` にします。旧ランタイムには新形式を読み込ませません。未知のバージョンやフィールド、Symbol の参照切れ、ID の衝突は拒否し、未対応情報を黙って捨てません。ID は lowercase UUID v7、座標は有限数、表示順は明示的な `order`、SVG は `xMidYMid meet` を使用します。

変更は JSON ファイルへの保存までブラウザ内だけに保持されます。ページを再読込する前に保存してください。編集コマンドはコピー上で検証し、内容変更時に revision を増やします。グループ化、正式な Runtime の起動時 mode・Rust 側の権限分離はまだありません。
