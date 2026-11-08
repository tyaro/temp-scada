# 記録registryの認証・host gate

状態: **採用**。2026-11-07作成、2026-11-08にユーザー判断で§8を確定（日本時間）。[native registry adapter](historian-recording-native-registry-adapter.md)の受入1〜6を閉じた後の区切りで、製品hostのsession issuer、権限失効後の結果開示、epoch生成と永続衝突防止、Tauri endpointを定める。製品transportと通常Appへの接続はこの後の区切りとする。

## 1. 前提とユーザー判断

2026-11-07のユーザー判断で、[開発・運用フェーズとログイン](access-policy.md)の認証延期を解除した。同日の判断は次の三点である。

1. 記録計画を変更する利用者は、**SCADAのTauri host内のBantoユーザー**で認証する。Hubのユーザー・sessionを使わない。Hubとのread接続は従来どおり`read`スコープのAPIキーで、記録変更の権限とは別である。
2. 記録変更（wireの`mutation` role）は**Admin**だけに許す。監視・照会（`reconciliation` role）は**Viewer以上**に許す。
3. 開発・初期設定フェーズは、Bantoの**認証無効モード**（`AuthSettings.disabled`）の合成sessionに、そのモードの`disabled_role`で記録変更を許す。

上流の確認結果は次のとおり。

- **上流industrial**（固定rev `33410f6`）: `banto-hub-bootstrap`が自己発行できるscopeは`read`だけで、`admin`と`write:*`は禁止されている。記録変更の権限をHubのAPIキーから得る経路はない。
- **Banto v6.10.0**: `banto-admin-services`はaxumに依存しない。次のlibraryを提供する。
  - `UsersService`。setup、argon2id照合、`auth_epoch`を持つ。
  - `Role`。順序は`Viewer` < `Editor` < `Admin`。
  - `SettingsService`。`AuthSettings`を持つ。
  - `AuditLogService`。
- **Bantoのmigration**: app側に置かれている（`apps/admin-template/core/migrations-sqlite`の0002・0003・0004・0005・0007・0008）。banto-hubもこれをコピーして使っている。
- **Banto側のTauri実装の手本**: `apps/admin-template/src-tauri`に、HTTPを使わない次の実装がある。
  - `DesktopSession`（`Account`と`AuthDisabledLocal`）。
  - 各commandでの再検証（`current_session`）。
  - `require_role`。
  - `auth_status`、`auth_setup`、`auth_login`、`auth_logout`、`auth_resolve`の各command。
- **UI側**: `@banto/admin-core`の`TauriAuthProvider`がこれらのcommandを呼ぶ。
- **SQLite依存の統一**: `banto-admin-services`のsqlx 0.9.0（最新）は`libsqlite3-sys >=0.30.1,<0.38`を要求し、HistorianとruntimeのSQLite（rusqlite 0.41.1、libsqlite3-sys 0.39.1）と同じbuildへ同居できない（`links = "sqlite3"`）。2026-11-08のユーザー判断で、rusqliteを`=0.39.0`（libsqlite3-sys 0.37.0、bundled SQLite 3.51.3）へ下げた。sqlxが新しいlibsqlite3-sysへ対応したら、両方を上げ直す。

## 2. 所有と配置

| 値・所有者                 | 置き場所                             | 役割                                                                                              |
| -------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `HostAuth`                 | Tauri host（`scada-host`の新module） | Banto `UsersService`・`SettingsService`・`AuditLogService`と、webviewの`DesktopSession`一枠を持つ |
| 認証DB                     | アプリdata dirの`scada-auth.sqlite3` | Bantoのusers／settings／audit_log。Project・Historian DB・ブラウザstorageとは別file               |
| `RecordingRegistryRoot`    | composition root（Tauri host）       | 既存。view・Project切替・Hub再接続でdropしない                                                    |
| `RecordingSessionIssuer`   | `HostAuth`だけが保持                 | root作成時に一つだけ返す非Clone capability。これを持つ者だけが製品sessionを発行できる             |
| `RecordingRegistrySession` | `HostAuth`の現在session表            | 既存。認証済みdesktop sessionごとにroleを分けて発行し、wire・UIへ渡さない                         |

Vite単体起動のオフライン編集は従来どおりログイン不要のまま残し、記録変更の入口を持たない。`localFileAuth`は認証済みsessionを捏造しない現行のまま維持する。

## 3. 製品session issuer

`RecordingRegistryRoot::try_new`の成功時に、rootと一対一の`RecordingSessionIssuer`を返す。

- **発行できる場所**: 製品sessionは`issuer.issue(&mut root, principal: RecordingPrincipal, role)`だけで発行する。
- **`RecordingPrincipal`**: 非JSONの型である。`scada-host`の`HostAuth`が、Bantoの照合結果からだけ作る。
- **既存の試験経路**: `test_session`は`#[cfg(test)]`のまま残す。
- **作らないもの**: 公開の`issue_session(principal: String, ...)`は作らない。wireの文字列、role文字列、Hub read keyからsessionを復元しない。

発行したsessionのprincipalは、次の固定文字列である。

| desktop session            | principal                   | 発行するrole                                                   |
| -------------------------- | --------------------------- | -------------------------------------------------------------- |
| `Account`（Bantoユーザー） | `banto-user:{users.id}`     | Viewer以上でread。Adminならmutationも別sessionで発行           |
| `AuthDisabledLocal`        | `banto-local:auth-disabled` | `disabled_role`に従い、上と同じ規則                            |
| なし（未ログイン）         | 発行しない                  | 監視画面の閲覧はHub read経路のみ。記録registryは`Unauthorized` |

- **principalの束縛先**: usernameは変更され得るので、principalはusernameでなく`users.id`へ束縛する。Bantoはidを再利用しない。
- **record・workflowの開示範囲**: 既存のregistryは、recordとworkflowを同じprincipalへ限って開示する。あるAdminが始めたworkflowは、別のAdminからは照会できない（§8の1）。
- **認証無効モード**: 開発・初期設定フェーズのworkflowは`banto-local:auth-disabled`に属する。運用への移行で認証無効モードを切ると、そのsessionは失効する。

## 4. 再検証と失効

各Tauri commandは、まず`HostAuth::current()`でdesktop sessionを再検証する（Bantoの`current_session`と同じ規則）。

- **`Account`**: usersの行を読み直す。次の場合はdesktop sessionを捨てる。
  - 行がない。
  - `id`が違う。
  - `auth_epoch`が違う。role変更、password変更・resetで変わる。
- **`AuthDisabledLocal`**: `AuthSettings`を読み直す。`disabled`がoffならdesktop sessionを捨てる。roleは現在の`disabled_role`を使う。
- **読取の失敗**: sessionを残し、そのcommandだけを失敗させる。DBの一時障害でログアウトさせない。
- **logout**: desktop sessionを捨てる。

desktop sessionを捨てたとき、またはroleが変わったときは、そのdesktop sessionへ発行した全registry sessionを`root.revoke_session`で失効させる。

- **再発行**: 新しいdesktop sessionで必要になったとき、発行し直す。
- **既存の失効契約**: 失効はnative状態を変えない。受理済み操作の内部監視は続く。失効したgrantには何も開示しない。
- **logout後の復帰**: 同じユーザーが再ログインすると、同じprincipalのsessionが再発行される。元返信、Observation、cancelの再取得はそのsessionで続けられる。
- **権限変更後**: roleがViewerへ下がったユーザーは、read sessionだけを受ける。自分のworkflowの照会・Observation・購読は続けられ、新しい変更はできない。
- **未静止workflowがある間の降格・削除**: AdminがworkflowをCandidate／Pausedまで進めた後に降格や削除をされると、本人はdiscardできず、別のAdminもprincipalの制約で操作できない。そこでhostは、§6の運用移行と同じ排他で、この状態を作る変更を拒否する。
  - **対象**: Adminから下位roleへの変更と、ユーザー削除である。password変更・resetは対象外とする。これらは`auth_epoch`を上げてsessionを失効させるが、同じprincipalが再ログインすれば、従来どおりAdminとしてdiscardや続きを実行できるためである。
  - **確認**: 変更commandは移行lockを取り、対象ユーザーのprincipalのworkflowについて`root.quiescence()`で静止を確かめる。未静止なら`busy`で拒否し、UIはdiscardか完了の待機を促す。静止していれば変更を確定し、§4のとおり即時に失効させる。
  - **lockの外で起きた変更**: 認証DBを外部から書き換えられた場合など、この確認を通らずに降格・削除が起きても、registryの状態は変えない。その場合の解消（別のAdminによる引継ぎかdiscard）は、§8の1と合わせて設計する。
- **降格後の元返信の回収**: 現行の`inspect_call`は元callと同じroleを要求する（adapter設計§7）。そのままでは、Adminの時に返信を失ったapplyの元返信を、Viewerへ降格した後に回収できない。そこでCallInspectionの契約を次のように変える。
  - **必要なrole**: 元callのkindによらずread roleとする。mutation sessionでの照会も従来どおり受ける。
  - **開示の条件**: 見つかったrecordの開示は、従来どおりそのrecordまたはworkflowのprincipalに限る。
  - **照会でしないこと**: 未登録originalの登録、native配送、lease発行、cancel通知、購読開始をしない。これは従来と同じで、照会からは新しい実行・再配送が起きない。
  - **変えないもの**: 元Admission・lease・cancelの同ID再取得は、元のroleのままとする。同ID再取得は登録済みticketの配送につながり得るためである。降格後の回収は、CallInspectionの`terminal`か`pending`で行う。
  - **反映先**: この変更はadapter設計§7とwire・host契約§9の記述も直す。実装順§9の2で行う。

**権限失効後の結果開示**は、この再発行で扱う。registryは、失効したgrantにも別principalにも開示しない。開示できるのは、hostが同じprincipalへ新たに発行したsessionだけである。

## 5. Tauri endpoint

記録registryの入口を、native hostだけのTauri commandとして追加する。

- **command**: `recording_workflow_reserve`、`recording_workflow_lease`、`recording_lease`、`recording_admission`、`recording_admission_inspection`、`recording_observation`、`recording_cancel`、`recording_call_inspection`、`recording_attach`、`recording_control`。
- **引数**: wire request JSONの一つだけである。principal・role・session IDを引数に取らない。
- **sessionの選び方**: wire requestで`role`を持つのはLeaseRequestだけである。そこでhostは§4の再検証の後、次の表でcommandとrequest本文から必要なroleを決め、そのroleの現在のregistry sessionを選ぶ。callerはroleを指定しない。

| command                                 | 必要なrole（Bantoの権限）                                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `recording_workflow_reserve`            | mutation（Admin）                                                                                           |
| `recording_workflow_lease`              | mutation（Admin）                                                                                           |
| `recording_lease`                       | read（Viewer以上）。requestの`role`が`reconciliation`のものだけを受け、`mutation`は`forbidden`とする        |
| `recording_admission`                   | 操作種別で決める。preflight・pause/join・apply・discardはmutation（Admin）、reconcileはread（Viewer以上）   |
| `recording_admission_inspection`        | read（Viewer以上）                                                                                          |
| `recording_observation`                 | read（Viewer以上）                                                                                          |
| `recording_cancel`                      | 対象の種別で決める。operationはmutation（Admin）、reconciliationはread（Viewer以上）。adapter設計§5のとおり |
| `recording_call_inspection`             | 元callのkindによらずread（Viewer以上）。§4の降格後の回収のため                                              |
| `recording_attach`・`recording_control` | read（Viewer以上）                                                                                          |

**workflowの段階別入口**: registryの変更操作は、段階ごとの公開APIに分かれている。最初に変更要求の全文で`reserve_workflow`を呼んで初回workflowを予約し、その後は保持したworkflow ticketから段階ごとの専用leaseを発行する。汎用の`issue_lease`で先にmutation leaseを発行すると、`reserve_workflow`は`Busy`になり、初回preflightを始められない。そこでhostは次のように対応する。

- **`recording_workflow_reserve`**: 引数は変更要求（`RecordingChangeRequest`）の全文である。認可の後に`reserve_workflow`を呼び、workflowの全段階の容量を予約する。同じ本文の再呼出しは同じ予約を返し、別本文は既存の契約のとおり拒否する。返信はchangeIdと予約の成否だけで、ticketそのものは返さない。
- **`recording_workflow_lease`**: 引数は段階（`preflight`、`pauseJoin`、`apply`、`discard`）とLeaseRequestである。`pauseJoin`と`apply`の段階は、その段階のadmissionが運ぶnative操作のoperationId（`action.operation.operationId`）も受ける。registryがlease発行時にこのIDを束縛するためである。hostは保持したworkflow ticketと前段の登録ticketで、その段階の専用lease（`issue_preflight_lease`、`issue_pause_join_lease`、`issue_apply_lease`、`issue_discard_lease`）を発行する。
- **`recording_lease`**: reconcile用のread leaseだけを汎用の`issue_lease`で発行する。mutation leaseは受けない。workflow外のmutation leaseには用途がなく、発行すると初回workflowの予約を妨げるためである。
- **`recording_admission`**: requestの操作種別から段階を決め、保持したticketで`register_*`と`dispatch_*`を呼ぶ。reconcileでは、保持した元applyの登録ticketを使う。
- **ticketの保持**: workflow ticketと各段階の登録ticketは、hostがrootと同じ寿命で保持する。予約したsessionのprincipalに束縛し、同じprincipalのsessionからだけ使う。ticketはwire・UIへ渡さず、IDの文字列から作り直さない（adapter設計§2のとおり）。
- **受入試験**: Tauri commandだけで、予約から初回preflight、pause/join、apply、元applyのreconcileまで進めることを確かめる。先に`recording_lease`でmutation leaseを求めても`forbidden`になり、予約が妨げられないことも確かめる。

- **未ログイン**: sessionがなければ`unauthorized`を返す。
- **権限不足**: mutationに必要なAdminを満たさなければ`forbidden`を返す。

- **受付処理**: Tauri commandのFutureがdropされても、登録からhandle保存までが途中で切れないようにする。そのためroot所有の受付処理を使う（adapter設計§4の3）。
- **返信**: UIは非同期の受付と元返信をそのまま扱い、同期の`RecordingOperationsService`へ偽装しない。
- **返信の世代確認**: 各commandは、開始時のdesktop sessionの世代（`AuthSlot`のseq）に束縛する。hostは返信を返す直前に、§4の規則で認証と世代を確かめ直す。
  - **世代が変わっていた場合**: 受付の途中でlogoutやユーザー交代が起きていれば、結果を返さず`unauthorized`を返す。返信には世代を添え、UIは現在の世代と違う返信を捨てる。
  - **registryの状態は変えない**: 返信を捨てても、registryの登録・配送・元返信の保存はそのまま残り、受理済み操作の内部監視も続く。同じprincipalが再ログインすれば、CallInspectionで元返信を回収できる（§4）。
  - **受入試験**: 受付後・返信前のlogoutとユーザー交代で、旧ユーザーの結果がwebviewへ返らないこと、registryの記録と監視が残ること、再ログイン後に同じprincipalが回収できることを確かめる。
- **購読frame**: Tauri eventで配送する。配送のたびに、§4と同じ規則でdesktop sessionを再検証する。これにより、次のcommandが来なくても購読中の失効を検知できる。
  - **失効を検知した場合**: そのdesktop sessionの全registry sessionを`revoke_session`で失効させる。購読を切り、配送を止める。
  - **認証DBの読取に失敗した場合**: そのframeを配送せずに保留し、次の配送機会に再検証する。保留中のframeはregistryの最新一件slotに残るので、保留しても容量は増えない。保留したframeを、再検証の前に配送しない。
  - **session世代への束縛**: 購読はattach時のdesktop sessionの世代（`AuthSlot`のseq）へ束縛する。logout、ユーザー交代、世代が変わる再ログインでは、旧世代の購読を切る。hostは、旧世代の購読のframeを新しいsessionへ送らない。UIは、現在の世代と違う世代のeventを捨てる。
  - **認証の変更commandを受けた場合**: 同じhostのcommandでlogout、role変更、password変更・reset、ユーザー削除、認証無効モードの切替をしたときは、そのcommandの中で影響するdesktop sessionを再検証し、失効させる。配送の次の機会まで待たない。
- **監査**: mutationの登録とcancelを、`origin: "tauri"`でBantoの監査logへ記録する。監査の失敗で操作を止めない（Bantoの`record`と同じbest-effort）。拒否は`denied`として記録する。

認証用のcommandは、Bantoの`auth_status`、`auth_setup`、`auth_login`、`auth_logout`、`auth_resolve`、`auth_change_password`を移植する。

- **UI**: native実行時に`TauriAuthProvider`を使う。
- **移植しないもの**: Bantoのauto-login（OS keyring）とLAN用の`AuthState` token。後続とする。
- **待受**: HTTP待受は追加しない。

## 6. 開発・初期設定フェーズと運用への移行

**フェーズの記録**: hostは、認証DBとは別に、アプリdata dirの`auth-phase.json`へフェーズを記録する。値は`bootstrapping`（初回初期化の途中）、`initializing`（開発・初期設定）、`transitioning`（運用への移行の途中）、`operational`（運用）の四つである。

- **初回起動**: `auth-phase.json`も認証DBもないときだけ、初回起動とする。hostは次の順に進める。
  1. `auth-phase.json`を`bootstrapping`にする。
  2. 認証DBを作り、migrationを適用し、`auth.disabled=true`と`auth.disabled_role=admin`を保存する。
  3. `auth-phase.json`を`initializing`にする。
- **初回初期化の再開**: 起動時に`bootstrapping`なら、認証DBの有無や中身によらず2から再開する。2は何度実行しても同じ結果になる。DBが途中まで作られていればmigrationと設定の保存を続け、なければ作る。`bootstrapping`は`operational`に達する前にしか存在しないので、ここでDBを作り直しても、運用済み端末を無認証へ戻すことにはならない。
- **フェーズの記録がない場合**: `auth-phase.json`がなく認証DBだけがある状態は、上の順序からは生じない。フェーズの記録を失ったものとして扱い、記録registryの入口を拒否する。
- **このフェーズでの動作**: ログインせずに`AuthDisabledLocal`のsessionで動き、記録変更も許す。
- **既存DB**: 保存値に従う。

**認証DBが開けない、または欠けている場合**: 記録registryの入口はすべて拒否する。

- **再作成しない**: フェーズが`initializing`・`transitioning`・`operational`なのに認証DBがない場合は、DBを再作成しない。これにより、運用済み端末で認証DBだけを失ったときに、再起動で無認証の記録変更ができるようになることを防ぐ。
- **自動で戻さない**: 初期設定へ自動で戻さず、無認証の変更を許さない（access-policyのとおり）。
- **防げる範囲**: 防げるのは、DBの偶発的な消失と再作成である。data dirを書き換えられる者による改変は、この仕組みの対象外とする。
- **復旧**: 正式な復旧手順は、運用から初期設定へ戻す手順と合わせて後続で設計する。

**運用への移行**: Bantoは、認証無効モードの間は`auth_setup`も`auth_login`も拒否する（admin-templateの`setup_body`）。そのため、Bantoの手順を組み合わせただけでは移行できない。hostに、移行専用のcommand `auth_transition_to_operational(username, password, display_name)`を追加する。

- **呼べる条件**: 次のどちらかのときだけ受ける。
  - フェーズが`initializing`で、認証無効モードがonであり、現在のsessionがroleがAdminの`AuthDisabledLocal`である。
  - フェーズが`transitioning`（移行の途中）である。認証無効モードのon／offと現在のsessionは問わない。管理者がいれば、資格情報の照合を必ず通す。
- **確定の順序**: 各段階は、前の段階の保存が成功してから進む。どの段階も、二度実行しても同じ結果になる。
  1. `auth-phase.json`を`transitioning`にする。以後の失敗や強制終了は、すべてこの状態から再開する。
  2. 管理者がいなければ`setup_first_user`で作る。いれば、渡された資格情報を`verify`で照合し、そのアカウントがAdminであることを確かめる。`transitioning`で認証無効モードが既にoffなら、作成の経路を通らず照合だけを行う。
  3. `auth.disabled=false`を保存する。
  4. `auth-phase.json`を`operational`にする。
  5. そのアカウントのdesktop sessionを入れ、`banto-local:auth-disabled`の全registry sessionを失効させる（§4）。
- **途中で失敗した場合**: 1より前の失敗では`initializing`のまま残る。1の後から4の保存が終わるまでの失敗や強制終了では`transitioning`が残る。再起動後も同じcommandを管理者の資格情報で呼べば、2の照合から続きを完了できる。
- **移行の完了点**: 4の`operational`の保存を、移行の永続的な完了点とする。4の後に終了したり返信を失ったりしても、移行はやり直さない。再起動後は`operational`・認証有効・管理者ありの状態で起動し、通常のログインへ進む。5のsession導入は、そのログインで行われる。5の失効対象は旧processのメモリ上のsessionだけで、再起動でrootごと消えている。返信を失ったUIは、`auth_status`とフェーズを読み直して通常のログイン画面へ進む。
- **`transitioning`の間**: 記録registryの入口はすべて拒否する。認証無効モードがonのままでも、`AuthDisabledLocal`のsessionへregistry sessionを発行しない。UIは移行の再実行を促す。
- **移行の確認**: 管理者の存在は、ブラウザの保存値でなくbackendで確認する。
- **未静止のworkflowがある場合**: 移行すると旧principalのsessionは失効する。運用側のユーザーからは照会も操作もできない（§8の1）ので、Candidate／Pausedを解くdiscardも実行できなくなる。そのため、静止の確認はhostで行う。
  - **排他**: 移行commandは、hostの移行lockを取ってから始める。registryの入口（workflowの予約、lease、Admission、cancel）も同じlockの下で受け付けるので、確認と移行の間に新しい要求は入らない。
  - **新規mutationの停止**: lockの下で、まず新しいworkflowの予約・mutation lease・Admissionの受付を止める。
  - **静止の確認**: 次に、registryのread-onlyの照会`root.quiescence()`で、workflowがないか、正常に終端しており、未配送の登録・未完了のnative操作・未確定の受付がないことを確かめる。この照会は状態を変えない。実装順§9の2で追加する。
  - **未静止なら**: 受付の停止を解き、`busy`で拒否する。`transitioning`は保存しない。UIは理由を表示し、discardや完了の待機を促す。
  - **静止していれば**: そのまま`transitioning`を保存し、以後は`transitioning`の規則で入口を拒否する。
  - **`transitioning`からの再開時**: 再開時も同じ確認を行う。`transitioning`の間は新しい受付がないので、静止は保たれている。
- **認証無効モードに戻す場合**: `operational`で認証無効モードをonに戻すことは、この区切りでは提供しない。

## 7. epoch生成と永続衝突防止

`ownerEpoch`と`ownerRef`は、どちらもroot作成のたびにhostが新しく生成する。

- **生成方法**: それぞれOSのCSPRNGから得た128bitを、32桁の小文字16進にする。
- **`ownerRef`も世代ごとにする理由**: 既存c4aのAdmissionRequestやAdmissionInspectionRequestは`ownerEpoch`を持たず、ownerRefとcontextだけで照合される。インストール固定のownerRefにすると、再起動前の要求と新ownerへの要求を区別できない。そのため[wire・host契約](historian-recording-wire-host.md)§3のとおり、ownerRefをepochをまたいで再利用しない。
- **前回値との照合**: hostは、直前に使ったownerRefとepochの組をアプリdata dirの`recording-epoch.json`へ保存する。生成値のどちらかが前回値と一致したら、生成し直す。
- **保存の順序**: 保存はroot作成の前に行う。保存に失敗したら、rootを作らずに記録registryの入口を拒否する。
- **旧世代の扱い**: 旧ownerRef・旧epochのref・lease・sessionを新rootへ移さない（wire・host契約のとおり）。
- **Windowsでの永続性**（2026-11-08ユーザー判断）: Windowsでは、同じvolume内のrenameと新しく作ったdirの親について、保存成功後の電源断でも残るという文書化された保証がない。`MOVEFILE_WRITE_THROUGH`が保証するflushは、copyと削除を伴う移動だけである。そのためWindowsではbest-effortとし、file本体のsyncと`MOVEFILE_WRITE_THROUGH`付きの置き換えまでを行う。この保存は乱数源の故障への防御に限られる。失われた場合の影響は、次回の照合相手が一つ前の組（またはなし）になることだけで、旧世代のref・lease・sessionは新rootへ持ち越されない。
- **1組だけ保存する理由**: 128bitの乱数は再起動のたびに独立に生成されるので、衝突の確率は無視できる。前回値の照合は、乱数源の故障などで同じ値が出た場合への防御に限る。履歴の全件は保存しない。

## 8. 確定事項（2026-11-08ユーザー判断）

2026-11-08のユーザー判断で、次の3点を推奨案のとおり確定した。

1. **principalごとの開示**: 現行registryは、recordとworkflowをprincipalに束縛している。そのため、Admin Aが始めたworkflowを、Admin Bは監視も取消もできない。開発フェーズのworkflowも、運用移行後には照会できない。初回は単一workflowなので、現行のままとする。
   - 交代運用が必要になった時点で、「Admin共有principal」案を別に設計する。
   - その設計は、lockの外で起きた降格・削除の後に、別のAdminがworkflowを引き継ぐかdiscardする復旧経路も扱う（§4）。
2. **認証無効モードの初期値**: 初回起動（`auth-phase.json`も認証DBもない）でだけ、認証無効をonとする（§6）。Bantoの既定（off）とは逆だが、access-policyの「開発中はログイン不要」に合わせる。
3. **認証DBの置き場所**: 認証DBは、Historian DBとは別のfile（`scada-auth.sqlite3`）とする（§2）。

## 9. 実装順

1. `scada-host`へ`HostAuth`（Bantoの依存、migrationのコピー、`DesktopSession`の再検証、`require_role`）を追加する。試験は一時SQLiteで行う。**実装済み**（`crates/scada-host/src/auth.rs`）。Bantoとの違いは一点で、認証無効モードの`disabled_role`が変わったときもslotの`seq`を進める。これで`seq`は認可の内容が変わったときだけ進むので、手順2ではregistry sessionを`seq`に束縛し、`seq`の比較だけで失効を判定できる。また、確認のたびに認証無効モードを先に読む。onならslotの中身（Account・空）によらず合成sessionへ置き換えるので、host外で設定が変わっても`auth.disabled`と`AuthDisabledLocal`の対応が崩れない。設定の変更は`HostAuth::set_auth_config`で保存し、同じ呼出しの中でslotを新しいモードへ合わせる。loginは照合の後にもモードを読み直す。
2. `scada-runtime`へ`RecordingSessionIssuer`と`RecordingPrincipal`、read-onlyの`quiescence()`を追加し、失効の連動を試験する。CallInspectionをread roleで受ける契約変更（§4）も行い、Adminで返信を失ったapplyをViewerへ降格した後に回収できることを試験する。**実装済み**（`recording_registry/issuer.rs`、試験`registry_issuer.rs`。詳細はadapter設計§7の末尾）。`scada-host`の`DesktopSession::principal()`は`RecordingPrincipal`を返す。registry sessionを`HostAuth`の`seq`へ束縛して失効させる部分は、hostがsessionを保持する手順4で行う。
3. ownerRef・epochの世代ごとの生成と保存を追加する。**実装済み**（`crates/scada-host/src/recording_epoch.rs`）。`create_recording_root`が`recording-epoch.json`の保存の成功後にだけ`RecordingRegistryRoot::try_new`を呼ぶ。保存は同じdirの一時fileへ書いてsyncし、renameで置き換える。unixではrename後にdirをsyncし、data dirを新しく作った場合は作った各dirの親もsyncする。Windowsでは`MoveFileExW`に`MOVEFILE_WRITE_THROUGH`を付けて置き換える（電源断への耐性はbest-effort。§7）。どちらでも、強制終了しても旧組か新組のどちらかが残る。前回値の読込から保存の完了までは、同じdirの`recording-epoch.lock`の排他lockを取る。別processの二重起動を含めて並行しても、一時fileを共有せず、返した組と保存した組が食い違わない。前回値の読込に失敗した場合や、中身が`version`・`ownerRef`・`ownerEpoch`の3項目で32桁小文字hexでない場合は、照合ができないので上書きせずに拒否する。生成値が前回のどちらかの値、または互いに一致したら引き直し、4回続けば乱数源の故障として拒否する。rootの結合はnativeのownerを組む手順4の試験で確かめる。
4. Tauri command（§5のworkflowの段階別入口とticketの保持を含む）とUIの`TauriAuthProvider`を追加する。範囲が大きいので、次の三つに分けて進める。
   1. **フェーズと運用移行**（§6）: **実装済み**（`crates/scada-host/src/auth_phase.rs`の`AuthHost`）。`AuthHost::start(data_dir)`が初回起動・初回初期化の再開・フェーズ記録の欠落（`PhaseLost`）・認証DBの欠落（`AuthDbMissing`、再作成しない）を扱う。`auth-phase.json`の保存は`recording-epoch.json`と同じ一時file→sync→置換（共通の`durable.rs`）で、読めない・不正な記録は上書きせず拒否する。hostは同じdata dirの`auth-phase.lock`を生存中ずっと排他で持ち（`try_lock`）、二つ目のhostは`InUse`で起動しない。フェーズは移行lock（`AuthHost::gate()`）の下にあり、registryの入口は手順4の2でこのlockを取って`AuthPhase::admits_registry()`（`initializing`と`operational`だけ真）を確かめる。`transition_to_operational`は同じlockの下で、呼出し元が渡す静止確認が偽なら何も保存せず`Busy`とする。`initializing`では、認証無効モードon・`AuthDisabledLocal`のAdminに加えて、アカウントが一つもないかAdminがいることを、1の保存より前に確かめる（Admin以外のアカウントだけがあると、作成も照合もできず`transitioning`から進めないため）。試験は保存境界ごとの中断（fault注入）と再起動後の再開を含む（`auth_phase/tests.rs`）。
   2. **registry gate**（§3〜§5のhost側）: registry sessionの保持と`seq`への束縛、command別のrole決定、workflow ticketと登録ticketの保持、返信の世代確認、降格・削除の静止確認、購読frameの再検証。Tauriに依存しない`scada-host`の型として作り、nativeのownerで試験する。範囲が大きいので、さらに次の三つに分ける。
      1. **gateの骨格と読取系の入口**: **実装済み**（`crates/scada-host/src/recording_gate.rs`の`RecordingGate`）。gateはrootとissuerを所有し、issuerを外へ出さない。各入口は、移行lock（`AuthHost::gate()`）を取って`admits_registry()`を確かめ、`require_role`で再検証とroleの確認（readはViewer以上、mutationはAdmin）を行い、desktop sessionの`seq`とroleごとに保持したregistry sessionを使う（初回に発行する）。`seq`が変わっていれば、旧世代のsessionを`revoke_session`で失効させてから発行し直す。返す直前にもう一度再検証し、`seq`が変わっていれば結果を返さず`unauthorized`とし、旧世代のsessionを失効させる。返信は`Bound { seq, reply }`で世代を添える。認証DBの読取失敗はsessionを残してそのcommandだけを失敗させる。この区切りの入口は`recording_lease`（reconciliationのみ。mutationは`forbidden`）、`recording_observation`、`recording_call_inspection`、`recording_cancel`（operationはmutation、reconciliationはread）、`recording_attach`、`recording_control`である。認証の変更commandから呼ぶ`refresh()`は、次のcommandを待たずに旧世代のsessionを失効させる。試験は`scada-runtime`の`test-support` feature（`recording_host::test_support::joined_owner`）でnativeのownerを組み、`create_recording_root`で作ったrootで行う（`recording_gate/tests.rs`）。
      2. **workflowの入口とticketの保持**: **実装済み**（`RecordingGate`の`workflow_reserve`・`workflow_lease`・`admission`・`admission_inspection`）。gateはrootの寿命の間、workflow ticketと、後段が使う登録ticket（preflight・pause/join・apply）を予約したprincipalに束縛して保持する。別principalのsessionからの使用は`forbidden`、予約前や前段の未登録は`invalidInput`とする。discardとreconcileの後には段階がなく、同じrequestの再登録が同じticketを返すので、そのticketは保持しない。`admission`は登録とdispatchをgateのlockの下でawaitを挟まずに行うので、commandのFutureがdropされても途中で切れない。監査は、予約とmutationの登録（新規の時だけ。再取得は記録しない）、cancel（呼出しごと）を`origin: "tauri"`で記録する。registryの`forbidden`・`unauthorized`は`denied`、その他の拒否は`failed`とし、roleによる拒否は`require_role`が`denied`を記録する。試験（`recording_gate/tests/workflow.rs`）は、gateだけで予約から初回preflight・pause/join・apply・元applyのreconcileまで進めることと、先に`recording_lease`でmutation leaseを求めても`forbidden`で予約が妨げられないことを含む。reconcileの試験のため、`scada-runtime`の`test-support`に`change`と`lose_next_apply_response`（次のapplyのnative返信を失わせる）を追加した。
      3. **認証の変更と購読**: **実装済み**（`RecordingGate`の`frames`・`logout`・`transition_to_operational`・`update_user`・`delete_user`・`set_auth_config`）。
         - **購読frame**: gateはattachで得た`subscriptionRef`を、attachした世代（`seq`）へ束縛して記録する。同じattachの再取得は、最初の世代の束縛を変えない。`frames`は配送のたびに移行lockの下で再検証し、その後にstateとcontrolの各slotを取る。認証DBの読取に失敗したら何も取らず`AuthUnavailable`とし、frameはregistryの最新一件slotに残る。購読の世代と現在の世代が違えば`unauthorized`とし、旧世代の購読を終える。取る前後で世代が変わっていれば、取ったframeも返さない。
         - **購読の終了**: 旧世代のregistry sessionを失効させるとき（`revoke_through`）に、その世代の購読もregistryの`end_subscription`で終える。これは`scada-runtime`に追加したhost専用の操作で、control記録を作らないdetachにあたる。live slotとdescriptor分の容量を返し、以後のframeとsnapshotを拒否する。保存済みの返信（attachの再取得、明示のdetach）は従来どおり返り、native処理には触れない。
         - **運用移行**: `transition_to_operational`は`root.quiescence().is_quiescent()`を移行lockの下で渡す。結果によらず最後に`refresh()`を呼び、合成sessionのregistry sessionと購読を失効させる。認証無効モードをoffにした後で失敗した場合も、合成sessionは終わっているためである。
         - **降格・削除**: `update_user`と`delete_user`はAdminを要し、移行lockの下で確かめる。AdminからAdmin未満への変更と削除は、`quiescence().holds(banto_user(id))`が真なら`busy`とし、何も変えない。表示名だけの変更と、workflowの持ち主でない利用者の変更は、未静止でも受ける。確定後は`refresh()`で、終わったsessionを同じcommandの中で失効させる。
         - **認証無効モードの設定**: `set_auth_config`はAdminを要する。モードのon／offはここでは切り替えない（`NotAllowed`）。offにするのは運用移行だけで、onに戻すことはこの区切りでは提供しない（§6）。`disabled_role`をAdminから下げる変更は、`holds(auth_disabled_local)`が真なら`busy`とする。
         - **logout**: `logout`は、logoutが設定した世代より前のregistry sessionと購読を、同じcommandの中で失効させる。
         - **変更後の再検証の失敗**: 変更を保存した後の`refresh()`で認証DBを読めなかった場合は、保持中のregistry sessionをすべて失効させる。次のcommandで同じprincipalへ発行し直すだけなので、失うものはない。購読は終えない。変更と関係のない利用者の購読を取り消せない形で切らないためで、frameは配送のたびに再検証される。
         - **4-3へ残すもの**: password変更・resetのcommandは、Banto側の変更の後に`refresh()`を呼ぶ。試験は`recording_gate/tests/auth_change.rs`。
   3. **Tauri commandとUI**: 2をTauri commandと購読eventへ載せ、認証commandと`TauriAuthProvider`を追加する。

   手順4全体の試験項目は次のとおり。Tauri commandだけで予約から初回preflight・pause/join・apply・reconcileまで進めることを試験する。認証無効モード、ログイン、logout、role変更による失効、Viewerの読取限定、購読配送中の失効検知・認証DB読取失敗時の保留・旧世代frameの不送信、初回初期化の各保存境界での強制終了と再起動後の再開、`auth-phase.json`がなく認証DBだけがある場合の拒否、移行commandの成功と、各保存境界（1〜3の後）での失敗・強制終了からの再起動後の再実行、4の後の強制終了・返信喪失から通常ログインへ進めること、未静止workflowでの移行拒否と並行するpreflightとの排他、Candidate／Pausedでの降格・削除の拒否と静止後の確定、`transitioning`中のregistry入口の拒否、`bootstrapping`以外のフェーズでの認証DB欠落の拒否をnativeで試験する。

製品transportと実ownerの配置（C5）は、この区切りの後に行う。
