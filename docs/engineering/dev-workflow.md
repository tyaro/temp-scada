# 開発の進め方と検証の注意

状態: **作業の決まりと検証の注意の正本**。2026-11-20 に、Git 管理外の覚え書き（`docs/STATUS.md`）から、誰が作業しても守ることを移した。機能の責務と回帰の入口は [code-map](code-map.md)、実装の状況は [implementation-status](../project/implementation-status.md) を見る。端末ごとの状態（退避先・Hub のキーの id など）はここに書かない。

## PR とマージ

- PR は ready for review で作る（draft にしない）。マージは PR ごとにユーザーの承認を得てから、merge commit で行う。自動マージは使わず、CI の完了を待って手でマージする。
- 積んだ PR は、土台のブランチを消す前に向き先を変える。
- ブランチの削除は、マージとは別に、明示的に許可された場合だけ行う。マージの承認は削除の承認を含まない。
- 削除を許可されたときも、**マージ → `gh pr view --json state` で `MERGED` を確かめる → ブランチを消す**、の順に分ける。`MERGED` は削除の前提で、承認の代わりではない。`gh` が TLS handshake timeout を起こす環境では、マージが通らないままブランチを消して PR が閉じたことがある（#233）。
- マージの前に、オーナーのレビュー結果（PR の会話欄の issue comment。再レビューを含む全件）と Codex の要約を読む。Auto-fix が Codex の「問題なし」だけを知らせてきたときも、会話欄のオーナーのコメントを必ず読む（#307 で見落とした）。
- CI（`.github/workflows/ci.yml`）は PR と `work` への push で走る。作業ブランチへ push しただけでは走らないので、PR を作って確かめる。同じ PR へ新しいコミットを積むと、前の実行は取り消される。Windows の native ジョブは src-tauri・`src/native`・`crates/`・ルートの `Cargo.toml`・ツールチェーン・CI 定義の変更で走る（src-tauri は crates をすべて path で参照し、crates はルートの `[workspace.dependencies]` を継承する）。
- 設計 PR は自動レビューが 1 件ずつ指摘して収束しにくい。Fable の通しレビューでまとめて洗う。境界の規則は最初から全入力に当てて考える。

## 整形と文書の編集

- prettier は変更したファイルだけにかける（ツリー全体にかけると改行コードが数百ファイル崩れる）。委譲するときも同じ指示を渡す。
- fixture の JSON に追記するときは、既存の書式の行に差し込む。JSON Schema を Python で書き直すと全体の書式が変わるので、Edit で直す。
- 文書を Python で書き換えるときは、バックスラッシュを含む文字列を raw 文字列か `chr(92)` で書く。
- src-tauri はルートの workspace の外なので、`cargo fmt --all`・clippy・test は `apps/banto-scada/src-tauri` でも実行する（CI の native が整形検査で止まる）。

## 依存の更新

- banto-industrial は rev 固定（tagclient はルートの workspace、hub-bootstrap は scada-host と src-tauri）。lockfile は該当行だけ手で直し、`cargo metadata --locked` で確かめる（`cargo update -p` は無関係な windows-sys を下げた）。
- scada-host の依存を変えたら `apps/banto-scada/src-tauri/Cargo.lock` も更新する。
- 認証 DB の migration を含む Banto の更新を実機の DB で試す前に、認証 DB を退避する（#239 の手順。適用後はタグを戻すだけでは戻らない）。

## e2e（Playwright）

- `main.ts` の `mount(App, …)` の形と `__TAURI_INTERNALS__` の分岐は、e2e がモック（警報の feed `mock-alarm-feed.ts` など）を差し込む前提になっている。変えると既存の e2e が一斉に落ちる。製品のコードからモックを import しない。
- e2e の共通の前提やエントリー・共通部品を触ったら、既存の e2e の代表も走らせる。
- 上の段の Tauri 専用の札を出すときは `native-recording-management.spec.ts` の `mockNativeHost` を使う。
- 閉じたメニューの popover は `visibility: hidden` で大きさを持つので、重なりの判定では `checkVisibility` で除く。
- ヘッドレス Chromium はスクロールバーを隠す。スクロールバーの出入りによる循環は e2e では起きないので、原因を検査する。
- 反転の中の入れ子の `<svg>` に `getBoundingClientRect` を使うと Chrome で約 80px ずれる。中心は `getScreenCTM` から計算する（#340）。
- 時間に頼る試験は、CI の遅さで境界をまたがないよう、判定の前に十分なゆとりを取る。vitest（node）では `$effect` が動かないので、scope の失効は e2e で確かめる。
- ローカルの webServer は `reuseExistingServer`（CI では再利用しない）。別フォルダの vite が 5173 にいるとそのコードで試験が走る。使い回しの dev server が、rebase の途中で一時的に消えたファイルの import 失敗を覚えたままになることもある。そのときは別のポートで vite を起こし、`PLAYWRIGHT_BASE_URL` で走らせる。
- Playwright が vite を毎回起こすと、最初の `goto` が 30 秒で時間切れになることがある。`pnpm dev` を先に起こして使い回す（ローカルだけ）。

## 不安定な試験と CI

- e2e（ローカルの全体実行で負荷に依存して落ちる。再実行で合格）: `selection-context.spec.ts:169`、asset-clipboard、background-image、binding-references、favorites、image-crop-gesture、panel-visibility、selection-paint-alpha。初回の light-theme の試験は dev server の初回ビルドで 30 秒の時間切れになることがある。runtime-mode の購読の失敗の 2 件（763・1055 行目）は全体実行で 1 回落ち、単独で合格した。
- Rust（負荷に依存。単独や `--test-threads=2` では合格。CI で落ちたら再実行）: `the_first_setup_maps_applies_and_records_ticks`、`registry_call_inspection_recovers_lost_cancel_attach_and_control_acks`、`registry_discard_lease_registered_then_expired_is_never_reissued`。src-tauri の `a_known_file_is_overwritten_without_a_dialog` も 1 回だけ落ちた。
- GitHub の runner が `*.ubuntu.com` を名前解決できず、`playwright install --with-deps` で止まることがある。失敗した job だけ再実行する。

## release ビルドと実機の操作

- 作り方: `pnpm build` の後、`apps/banto-scada/src-tauri` で `cargo build --release --locked --features tauri/custom-protocol`。
- release は CSP に unsafe-eval が無いので、Ajv の実行時 compile は使えない。検査コードは `pnpm generate:validators` で事前に生成する（#346、CSP の e2e は `e2e/release-csp.spec.ts`）。
- 実機の画面は `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` で起動し、Playwright の `connectOverCDP` で操作できる。
- アプリ・`real_hub_read`・DB probe は Windows の通常の terminal から起動する。Codex デスクトップの配下では `%LOCALAPPDATA%` がパッケージ領域へリダイレクトされる。
- 画面取得のツール（computer use）は、許可していない別アプリの小窓を塗りつぶす。アプリの描画かどうかは DevTools で `body` を `display: none` にして確かめる。
- 記録の wire fixture の更新: `SCADA_BLESS_WIRE_FIXTURES=1 cargo test -p scada-runtime registry_wire_dto` の後に prettier。

## クラウド環境での検査

- Rust: `source scripts/cloud-env.sh; export CARGO_INCREMENTAL=0` の後、`cargo test -p scada-host` など。
- src-tauri: 一時の `apps/banto-scada/src-tauri/icons/icon.png`（32x32 の PNG を python で生成。コミット前に消す）を置き、`cargo test --locked`・`cargo clippy --locked --all-targets`（2 分を超えるので background で実行）。
- TS: scratchpad の `nm/` に `{}` の package.json を置き、`npm install --legacy-peer-deps svelte@5.57.2 svelte-check@4.7.7 typescript@6.0.3 vite@8.3.4 vitest@5.0.5 @sveltejs/vite-plugin-svelte@7.3.1 @tauri-apps/api@2.12.1 ajv@8.20.0 fflate@0.8.3 prettier@3.9.10 prettier-plugin-svelte@4.1.1 @playwright/test@1.63.0`。
  - Banto の clone（`git clone --depth 1 --branch v8.0.0 https://github.com/tyaro/banto.git`）から `packages/{admin-core,ui,theme}` などを `nm/node_modules/@banto/` へ copy し、`apps/banto-scada/node_modules` をそこへ symlink する。
  - トレンドの共通部品は banto-industrial の clone（`--branch trend-v0.1.0`）から `packages/trend` を `nm/node_modules/@banto-industrial/trend` へ、その依存の `@banto/charts` は Banto `v7.8.0` の `packages/charts` から copy する（#359）。
  - vitest 5 では `vi.fn().mockRejectedValue` が reject を未処理扱いにして試験が落ちる。reject を返す invoke は手書きの関数にする。
- e2e: ルートの `node_modules/{@playwright/test,playwright,playwright-core}` へ symlink し、`apps/banto-scada` で `vite --host 127.0.0.1 --port 5173` を起動して、`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome node node_modules/@playwright/test/cli.js test <spec> --trace off`。初回は vite の起動が遅いので、最初の操作の poll は長め（30 秒）にする。
- prettier: ルートの `node_modules/` に `prettier`・`prettier-plugin-svelte`・`svelte` の symlink を張り、`nm/node_modules/.bin/prettier --check <変更したファイル>`。リンクの検査は `node scripts/check-doc-links.mjs`。
- 後片付け: symlink・vite・`test-results/`・icon.png を消す。`git add` はパスを指定して行う。

## AI エージェントへの委譲

- サブエージェントが黙って落ちることがある。長く知らせが無ければ、作業ツリーの変更と記録のファイルの更新時刻で確かめ、止まっていれば始め直す。
