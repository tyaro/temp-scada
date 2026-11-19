# Runtime mode の設計（O0、#279）

状態: **設計案（2026-11-19 作成、ユーザー確認待ち）**。Fable の通しレビュー 18 件を反映。[段階3 運転操作の設計](operation-stage3-design.md)の O0 で、Issue [#279](https://github.com/tyaro/temp-scada/issues/279) の範囲を具体化する。§10 の確認事項に回答を得てから実装する。

## 1. 目的と範囲

同じ実行ファイルを、起動時に Editor mode か Runtime mode のどちらかに決めて動かす。Runtime mode からは Editor の機能に届かないようにする。段階3の書込み（O1 以降）は Runtime mode だけで行うので、その前提になる。

範囲:

- 起動時の mode の決め方と、実行中に切り替えないこと。
- Tauri の窓と capability の分け方、アプリ独自 command の ACL 宣言。
- Rust 側の mode の検査。
- Runtime mode の画面（起動時に読んだ Project で運転表示を出すだけ）。
- 多重起動の禁止。

範囲外: 書込み Action（O1〜O4）、権限 `equipment.operate`（O5）、サービス host、別の実行ファイルへの分離、インストーラ（ショートカットの作成）。Design API は未実装だが、作るときも Runtime mode では listener を開かない（上流 §19.13。将来の不変条件）。

## 2. 前提

上流 §18（[上流 SCADA 設計](../../upstream/industrial/scada-design.md)、2026-10-01 決定）:

- Editor と Runtime は同じ実行ファイルの mode。Runtime mode では Editor の UI を隠すだけでなく、Editor 専用の機能に届かないようにする。
- Tauri では Editor と Runtime の窓か capability を分け、Runtime 側へ Editor の command の permission を渡さない。Rust 側でも mode を確かめる。
- mode は起動時に CLI 引数か配布設定で決め、実行中は切り替えない。未指定時の既定は Project の契約にしない。
- Runtime だけの配布に Hub の管理用の資格情報を置かない。

**上流 §18 と実装の差（この repo の tauri 2.12.5 で確認）**: 上流は「宣言漏れの command は capability で制限できない」と書くが、今の Tauri では逆になる。`build.rs` の `AppManifest::commands` で 1 つでも宣言すると app の ACL manifest ができ（`tauri-build` の `acl.rs`）、以後は ACL の解決が無いアプリ独自 command を**すべての窓で断る**（`tauri` の `webview/mod.rs` の `has_app_acl_manifest` の分岐）。宣言漏れは「どこからも呼べない」側に倒れる。差分は `development-plan.md` に記録する。この版で本当に危ないのは、`runtime.json` に Editor 専用の `allow-*` を誤って足すことと、capability の `windows` の書き間違いである。Rust 側の mode 検査は、この誤りと、ACL が効かない試験・開発の構成に対する多層防御として置く。

この repo の現状（2026-11-19）:

- mode の概念は webview の `edit`／`preview` と、プレビューから開く運転表示（`OperatorView`）だけ。host（`apps/banto-scada/src-tauri`）に mode は無い。
- 窓は `tauri.conf.json` の静的な 1 枚（label `main`）。capability は `default.json` の 1 つで、`core:default`・`core:event:default`・`core:window:allow-set-title` だけを許す。`dialog:*` などプラグインの permission は無い（webview から `tauri-plugin-dialog` を直接は呼べない）。アプリ独自 command は ACL に宣言しておらず、`generate_handler!` の **56 個**（Hub 6、終了 1、Project 2、警報 10、認証と利用者 15、履歴 3、記録の管理 8、記録の操作 11）がどの窓からも呼べる。
- 起動時に Project のファイルを開く経路は無い（`project_open` はファイル選択の窓から）。`main.ts` は `App.svelte` を静的に import している。
- 次の 4 つは webview から Project の JSON を受け取る: `hub_read_start`・`history_context`・`recording_context`・`project_save`（記録の操作にも Project を受けるものがある）。
- `hub_connect` は `Bootstrapper::connect` を呼ぶ。保存済みの読み用キーが無効だと、Hub が試運転のモードなら管理 API（commissioning grant）で読み用キーを発行し直し、keyring と接続の記録を書き換える。`Bootstrapper::status` は何も発行しない（設定の画面を開くだけでキーを作らないための別の入口）。
- 多重起動は止めていない。認証 DB・記録 DB・警報の端末 DB を 2 つのプロセスが同時に開けてしまう。
- 記録はプロセスの中で動く。アプリを再起動したら `recording_resume` で再開する（自動では始まらない）。

## 3. mode の決め方

- CLI 引数で決める。`--runtime <Project のファイル>` で Runtime mode、引数なしで Editor mode（既定は実装の決めごと）。相対パスは起動時の作業フォルダで解決し、正規化した絶対パスで持つ。
- 引数が壊れている（`--runtime` だけでパスが無い、知らない引数がある）ときは、窓を開かずに理由を出して終わる（Windows ではメッセージの窓）。Editor へ落とさない（Runtime のショートカットの誤りで Editor が開くと、Runtime の配布に Editor の窓が出てしまう）。
- 引数の検査は単一起動（§7）の判定より先に行う。壊れた引数の 2 つ目の起動は、1 つ目に知らせずに理由を出して終わる。
- 配布設定のファイルで決める経路は、今回は作らない（§10-1）。
- mode は host の `AppMode`（`Editor`／`Runtime { project_path }`）として起動時に 1 回だけ作り、Tauri の state に置く。書き換える API を持たない。親設計 §4 の 8 の「mode の変化」は起きないので、親の文言を直す。

## 4. 窓と capability

- 窓を `tauri.conf.json` から外し、`setup` で mode に合わせて 1 枚だけ作る。label は Editor が `editor`、Runtime が `runtime`。窓の URL は Editor が `index.html`、Runtime が `runtime.html`（vite の入口を 2 つにする。§6 の 5）。
- capability を 2 つにし、`default.json` は消す。
  - `editor.json`（windows: `editor`）: 今の `core:*` 3 つと、§5 の「Editor 専用」「両方」の `allow-*`。
  - `runtime.json`（windows: `runtime`）: 今の `core:*` 3 つと、§5 の「Runtime 専用」「両方」の `allow-*`。
- 不変条件（試験にする）:
  1. `runtime.json` に Editor 専用の `allow-*` が無い。
  2. 両方の capability にプラグインの permission（`dialog:*` など）を足さない。ファイル選択の窓は host の command の中だけで開く。
  3. `runtime.json` に窓・webview を作る permission（`core:window:allow-create`、`core:webview:allow-create-webview`・`allow-create-webview-window`）を足さない。
  4. ACL は窓の label で決まるので、`runtime` の窓が何らかの理由で `index.html`（Editor の bundle）を開いても、Editor 専用の command は断られる。
  5. devtools は release のビルドで開けない（Tauri の既定。`devtools` の feature を有効にしない）。
- `build.rs` の `AppManifest::commands` に、`generate_handler!` の command を**すべて**宣言する。一覧は 1 つのファイル（例: `src-tauri/command_list.rs` の定数。区分付き）に置き、`build.rs` は `include!` で読む。試験で、一覧・`generate_handler!`・2 つの capability の `allow-*` が §5 の表と一致することを確かめる。
- 窓の label が `main` でなくなるので、label に依る既存の経路を確かめて直す: `close.rs` の閉じる確認、`recording::Pages`（label ごとの購読の後始末）、窓のタイトルの設定、e2e の前提。

## 5. command の振り分け

方針:

- Project・警報の定義・Hub の接続先とキー・記録の計画を変えるものは Editor 専用。
- 運転の画面を出す・見る・警報を確認する・ログインするものは両方。
- **Runtime は webview から Project を受け取らない**。host が起動時に読んだ Project だけを使う。webview から Project を受ける command は、Runtime 用の入口（引数に Project を持たない）を別に作り、元の command は Editor 専用にする。
- ロールの検査（Admin など）は今のまま残し、mode の検査はその前に置く。

| 区分                 | command                                                                                                                                                                                                                                                                                                                                                                                      | 理由                                                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Editor 専用          | `project_open`・`project_save`                                                                                                                                                                                                                                                                                                                                                               | Project を選ぶ・変える                                                                                                                                             |
| Editor 専用          | `alarm_apply`                                                                                                                                                                                                                                                                                                                                                                                | 警報の定義を適用する（§6 の 3）                                                                                                                                    |
| Editor 専用          | `hub_connect`・`hub_catalog`                                                                                                                                                                                                                                                                                                                                                                 | `hub_connect` は接続先を変え、読み用キーを発行し直すことがある。`hub_catalog` は割付の編集の catalog                                                               |
| Editor 専用          | `hub_read_start`・`history_context`・`recording_context`                                                                                                                                                                                                                                                                                                                                     | webview から Project を受ける。Runtime は下の Runtime 用の入口を使う                                                                                               |
| Editor 専用          | `recording_initial_setup`・`recording_reconfigure`・`recording_owner_rebind`、記録の操作の 11 個（`recording_workflow_reserve`・`recording_workflow_resumption`・`recording_workflow_lease`・`recording_lease`・`recording_admission`・`recording_admission_inspection`・`recording_observation`・`recording_cancel`・`recording_call_inspection`・`recording_attach`・`recording_control`） | 記録の計画を作る・変える。UI もメニューバー（Editor）にしか無い                                                                                                    |
| §10-3 で決める       | `recording_resume`・`recording_stop`                                                                                                                                                                                                                                                                                                                                                         | 案 A は Editor 専用、案 B は Runtime 用の入口で適用済みの計画の再開・停止を許す                                                                                    |
| 両方                 | `hub_disconnect`・`hub_read_stop`・`hub_saved_endpoint`                                                                                                                                                                                                                                                                                                                                      | 運転表示の購読の停止と、接続先の表示                                                                                                                               |
| 両方                 | `alarm_snapshot`・`alarm_ack`・`alarm_buzzer_silence`・`alarm_history`・`alarm_sound_test`・`alarm_settings_get`・`alarm_settings_set`・`alarm_sound_reset`                                                                                                                                                                                                                                  | 警報の確認・消音・履歴と、端末の警報設定（Admin のまま）                                                                                                           |
| §10-4 で決める       | `alarm_sound_import`                                                                                                                                                                                                                                                                                                                                                                         | host がファイル選択の窓を開く。キオスクとして使う端末で OS のファイル選択に出られる                                                                                |
| 両方                 | `auth_status`・`auth_phase`・`auth_login`・`auth_logout`・`auth_resolve`・`auth_change_password`                                                                                                                                                                                                                                                                                             | ログイン                                                                                                                                                           |
| §10-2 で決める       | `users_*`（5 個）・`auth_config_get`・`auth_config_apply`・`auth_setup`・`auth_transition_to_operational`                                                                                                                                                                                                                                                                                    | 端末の利用者管理と認証の設定・フェーズの遷移。親設計 §6 では初期設定のフェーズは Runtime でログインなしに書けるので、書込みの解禁と直結する                        |
| 両方                 | `history_query`・`history_cancel`                                                                                                                                                                                                                                                                                                                                                            | 履歴トレンドの窓（読むだけ）。文脈は下の `runtime_history_context` から得る                                                                                        |
| 両方                 | `recording_status`・`recording_slot`                                                                                                                                                                                                                                                                                                                                                         | 記録の状態を見るだけ                                                                                                                                               |
| 両方                 | `app_close_reply`                                                                                                                                                                                                                                                                                                                                                                            | 閉じる確認                                                                                                                                                         |
| Runtime 専用（新規） | `runtime_project`                                                                                                                                                                                                                                                                                                                                                                            | 起動時に読んだ Project を返す（§6）                                                                                                                                |
| Runtime 専用（新規） | `runtime_hub_connect`                                                                                                                                                                                                                                                                                                                                                                        | 引数なし。保存済みの接続先とキーで、何も発行せずにつなぐ（`Bootstrapper::status` と同じく発行しない経路）。キーが無効・未設定なら「Editor で接続し直してください」 |
| Runtime 専用（新規） | `runtime_read_start`・`runtime_history_context`・`runtime_recording_context`                                                                                                                                                                                                                                                                                                                 | 引数に Project を持たず、host の Project で購読・履歴の文脈・記録の文脈を作る                                                                                      |
| 両方（新規）         | `app_mode`                                                                                                                                                                                                                                                                                                                                                                                   | mode を返す（webview が画面を選ぶため）                                                                                                                            |

Rust 側の検査:

- Editor 専用の command は、最初に `mode.require_editor()?` を呼ぶ。Runtime では `editorOnly` を返し、ほかの検査（認証・ロール）より先に断る（断られた要求で認証 DB・監査・Project のファイル・Hub を触らない）。
- Runtime 専用の command は `mode.require_runtime()?`（Editor では `runtimeOnly`）。
- 断ったことは監査に残さず、host のログに残す（§10-5）。
- Runtime で記録の Candidate（閉じる確認で捨てるもの）を作る経路は無い。`app_close_reply` の `discard` が Runtime で記録を変えないことを試験にする（§10-3 で案 B を採るときは見直す）。

`runtime_*` の Runtime 用の入口は、中身を元の command と共通の関数にし、Project の取り方だけを変える（同じ処理を 2 つ持たない）。運転表示が使う sources（`native/sources.ts`）は Runtime では `catalogSource` を持たない（段階3の書込みで使う catalog は host の中で取り、command にはしない。親設計 §4 の 4）。

## 6. Runtime mode の画面と Project

1. 起動時に host が `--runtime` のファイルを読み、`Project` として検査する（`project_open` と同じ読込と検査。JSON とパッケージの両方の形式）。読めない・検査に通らないときは、窓に理由（ファイル名と、読めない／形式が違う）だけを出す画面にし、運転表示を出さない。Editor へは切り替えない。
2. host は読んだファイルのバイト列と、その SHA-256（小文字 hex）を `projectDigest` として持つ。警報の適用の記録の `file_hash`（`alarm_project.rs`）と同じ計算にする。実行中にファイルを読み直さない（差し替えは再起動。§10-6）。`runtime_project` は `project_open` と同じ形（frame）で内容と digest を返す。起動後にファイルを差し替えても、返す内容と digest は変わらない。
3. 警報の定義は Runtime では適用しない（§10-7）。Runtime は、端末に適用済みの定義（Editor の保存・「警報を適用」で入ったもの）で動く（起動時の `start_events` が端末の適用済みのものを再開する）。起動時に、読んだ Project と適用の記録を比べ、上端に出す:
   - 適用の記録が無い: 「警報の定義が適用されていません（Editor で適用してください）」。警報は鳴らない。
   - 別の Project（Project の ID が違う）が適用済み: 「この端末の警報は、別の Project の定義で動いています」。警報の一覧・確認はその定義のまま使える（§10-7）。
   - 同じ Project で `file_hash` が違う: 警報の定義だけを比べ（適用せずに定義ごとの hash を作る関数を `alarm_project.rs` に足し、`condition_hashes` と比べる）、違えば「警報の定義が、この Project と違います」。同じなら何も出さない。
4. Runtime の画面（`RuntimeShell`）:
   - 運転表示（今の `OperatorView`）を窓いっぱいに出す。開始画面は Project の運転表示の設定（`operatorFrame`）に従う。
   - 起動時に `runtime_hub_connect` で保存済みの接続先へつなぐ。接続先の入力欄は出さない。保存済みの接続先が無い端末は、Editor で 1 回接続してから Runtime を使う（画面にもそう出す）。
   - 上端に、接続の状態・ログイン（今の `AuthControls`）・警報（一覧の窓）・履歴トレンドの窓の入口・記録の状態・§6 の 3 の表示を出す。
   - メニューバー・作業タブ・左右のペイン・ファイルの操作・表示プレビューへの切替は出さない。
5. 入口を分ける: vite の入口を `index.html`（Editor、`main.ts`）と `runtime.html`（Runtime、`runtime.ts`）の 2 つにする。`runtime.ts` は `App.svelte`（Editor）を import しない。共有する部品（`OperatorView`・警報の窓・履歴の窓・`AuthControls`）が Editor の部品に依っていれば、O0b で依存を切る。Runtime の窓から Editor の画面へ移る経路（URL の切替・キー操作）は作らない。仮に `index.html` が開いても §4 の不変条件 4 で Editor の command は断られる。

## 7. 多重起動

- `tauri-plugin-single-instance`（banto-industrial の banto-hub・chronogazer と同じ）で、端末で 1 プロセスにする。plugin は Builder の最初に登録する。
- **mode に関わらず 1 つ**（§10-8）。Editor と Runtime を同時に動かさない。認証 DB・記録 DB・警報の端末 DB と、段階3の「端末で送信中の書込みは 1 つ」を 1 つのプロセスで持つため。親設計は「Runtime の多重起動」だけを禁じていたので、親 §10・§11-9 に追記する。
- 2 つ目の起動は、1 つ目の窓を前に出して終わる。1 つ目の mode・Project は変えない。2 つ目が違う mode か、Runtime で違う Project（正規化した絶対パスで比べる）を指したときは、1 つ目の窓に「すでに起動しています。別の Project・別の mode で使うときは、いまの窓を閉じてから起動してください」と出す。
- 1 つ目が失敗の画面（§6 の 1）を出しているときも同じ（前に出すだけ）。

## 8. 記録への影響

O0 で記録の開始（`recording_initial_setup`）を Editor 専用にし、Editor と Runtime を同時に動かさないので、**§10-3 で案 A を採ると、Runtime で運転している間は記録が取れない**（記録はプロセスの中で動き、再起動後は `recording_resume` が要る）。履歴トレンドは、Editor で記録していた間のデータだけになる。

- 案 A（O0 は Editor 専用のまま）: 記録の運用は C6 で Runtime 側に作る。それまで Runtime の試運転では記録しない。
- 案 B（Runtime でも適用済みの計画を再開・停止できる）: `runtime_recording_resume`・`runtime_recording_stop` を足す（引数に Project を持たず host の Project を使う。Admin のまま）。計画を変えることはできない。Runtime の上端に記録の開始・停止の入口が要る。

## 9. 実装の区切りと試験

- **O0a（host）**: `AppMode` と引数の解釈、窓を `setup` で作る、2 つの capability と `default.json` の削除、`AppManifest::commands` の宣言、Editor 専用・Runtime 専用の検査、`runtime_*` の入口、`app_mode`、単一起動、label の変更に伴う既存の経路の修正。
  - mode の試験（`mock_context` の IPC 試験。capability は効かないので Rust の検査を見る）: Runtime の mode で Editor 専用の command を表のとおりに直接呼ぶと `editorOnly` で、認証 DB・Project のファイル・警報 DB・記録 DB・Hub の接続の記録を変えないこと。Editor の mode で `runtime_*` が `runtimeOnly`。§5 の「両方」が Runtime の mode で通ること。
  - ACL の試験: `tauri::test::mock_builder().build(tauri::generate_context!())` で実際の capability を埋め込み、`runtime` の label の窓から Editor 専用の command が ACL で断られ、`editor` の窓からは通ることを確かめる。組めないときは、生成された capability と §5 の表の照合で代え、その旨を PR に書く。
  - 一覧の試験: 一覧・`generate_handler!`・2 つの capability が §5 と一致し、`runtime.json` が §4 の不変条件 1〜3 を満たす。
  - 引数の試験: 正常・パス無し・知らない引数・相対パス。
  - Project の試験: `runtime_project` が起動時の内容と digest を返し、ファイルを差し替えても変わらない。`runtime_read_start` などが webview の Project を受けない（引数が無い）。
  - 実機の手順（smoke）: release ビルドを `--runtime` で起動し、引数の誤りで窓が出ないこと、2 つ目の起動が 1 つ目を前に出すこと、devtools が開かないこと。
- **O0b（webview）**: `runtime.html`・`runtime.ts`・`RuntimeShell`、起動時の Project の読込と失敗の画面、`runtime_hub_connect`、上端の入口と §6 の 3 の表示。
  - e2e（`mockNativeHost` の形で `app_mode` を Runtime にする）: 運転表示だけが出てメニューバー・作業タブ・ファイル操作が無いこと、キー操作で Editor へ移れないこと、Project が読めないときの画面、保存済みの接続先が無いときの表示、警報の定義の 3 つの場合分けの表示。Editor の既存 e2e が変わらず通ること。
- 文書: code-map（mode の境界・一覧のファイル）、implementation-status、README の起動方法（`--runtime`）、development-plan（上流 §18 と ACL の差）、親設計の §4 の 8・§10・§11-9 の文言。

## 10. 確認したいこと

1. **mode は CLI 引数だけで決める（推奨）**。配布設定のファイルはインストーラと一緒に決める。代案は今から `%ProgramData%` の設定も読むこと（どちらを優先するかの規則が要る）。
2. **利用者管理・認証の設定・フェーズの遷移（`users_*`・`auth_config_*`・`auth_setup`・`auth_transition_to_operational`）**:
   - 推奨: `auth_setup`（最初の管理者の作成）と `users_*`・`auth_config_get` は Runtime でも使える（Admin のまま）。Runtime だけの端末でも利用者を管理できるようにする。
   - 推奨: `auth_transition_to_operational`（運用フェーズへの遷移）と `auth_config_apply`（ログイン不要モードの切替など）は Editor 専用。フェーズとログイン不要は書込みの解禁（親設計 §6）に直結するので、運転の画面から変えられないようにする。
   - 代案は全部 Runtime でも使える、または全部 Editor 専用。
3. **記録の再開・停止（§8）**: **案 A（O0 では Editor 専用、Runtime での記録は C6 で作る）を推奨**。O0 の範囲を広げず、C6 で Runtime の記録の運用（自動再開を含む）をまとめて決める。代案は案 B（O0 で Runtime に再開・停止を許す）。
4. **`alarm_sound_import` は Editor 専用にする（推奨）**。Runtime の端末で OS のファイル選択の窓を開かない。音を戻す（`alarm_sound_reset`）と試聴は Runtime でも使える。代案は Runtime でも取り込める（Admin のまま）。
5. **mode で断った要求は監査に残さず、host のログに残す（推奨）**。届くのは capability の設定誤り・不具合・改ざんのとき。代案は監査に `denied` で残す（認証 DB を開けないときの扱いが要る）。
6. **Runtime は実行中に Project を読み直さない（推奨）**。差し替えは Runtime の再起動。代案はファイルの変更を見て読み直す（段階3の `project_changed` が実行中に起き得る）。
7. **Runtime は警報の定義を適用しない（推奨）**。適用は Editor の保存・「警報を適用」で行い、Runtime は §6 の 3 の違いを上端に出すだけ。別の Project の定義で動いているときも、その警報の一覧・確認は使える。代案は Runtime の起動時に自動で適用する（利用者なしで定義を変える経路ができる）。
8. **Editor と Runtime を同時に動かさない（推奨。§7）**。代案は mode ごとに 1 つ（同じ DB を 2 つのプロセスが開くので、DB ごとの排他を先に作る必要がある）。
9. **Runtime は Hub のキーを発行しない（推奨。§5 の `runtime_hub_connect`）**。キーが無効なら Editor で接続し直す。代案は Runtime でも `hub_connect` と同じく発行し直す（上流 §18 の「Runtime だけの配布に管理用の資格情報を置かない」の趣旨に反する）。
10. **Runtime は webview から Project を受け取らない（推奨。§5）**。Runtime 用の入口を足す。代案は受け取った Project の digest を `projectDigest` と照合する（元の command を両方で使える）。
11. **引数の誤りでは Editor へ落とさず、理由を出して終わる（推奨。§3）**。
