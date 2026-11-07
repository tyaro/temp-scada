# 記録registryの認証・host gate

状態: **設計案（レビュー待ち）**。2026-11-07（日本時間）。[native registry adapter](historian-recording-native-registry-adapter.md)の受入1〜6を閉じた後の区切りで、製品hostのsession issuer、権限失効後の結果開示、epoch生成と永続衝突防止、Tauri endpointを定める。製品transportと通常Appへの接続はこの後の区切りとする。

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
- **record・workflowの開示範囲**: 既存のregistryは、recordとworkflowを同じprincipalへ限って開示する。あるAdminが始めたworkflowは、別のAdminからは照会できない（§8の未決事項1）。
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
- **権限変更後**: roleがViewerへ下がったユーザーは、read sessionだけを受ける。自分のworkflowの照会・Observationは続けられ、新しい変更はできない。

**権限失効後の結果開示**は、この再発行で扱う。registryは、失効したgrantにも別principalにも開示しない。開示できるのは、hostが同じprincipalへ新たに発行したsessionだけである。

## 5. Tauri endpoint

記録registryの入口を、native hostだけのTauri commandとして追加する。

- **command**: `recording_lease`、`recording_admission`、`recording_admission_inspection`、`recording_observation`、`recording_cancel`、`recording_call_inspection`、`recording_attach`、`recording_control`。
- **引数**: wire request JSONの一つだけである。principal・role・session IDを引数に取らない。
- **sessionの選び方**: hostは§4の再検証の後、requestのroleに対応する現在のregistry sessionを選ぶ。
- **未ログイン**: sessionがなければ`unauthorized`を返す。
- **権限不足**: mutationに必要なAdminを満たさなければ`forbidden`を返す。

- **受付処理**: Tauri commandのFutureがdropされても、登録からhandle保存までが途中で切れないようにする。そのためroot所有の受付処理を使う（adapter設計§4の3）。
- **返信**: UIは非同期の受付と元返信をそのまま扱い、同期の`RecordingOperationsService`へ偽装しない。
- **購読frame**: Tauri eventで配送する。
- **監査**: mutationの登録とcancelを、`origin: "tauri"`でBantoの監査logへ記録する。監査の失敗で操作を止めない（Bantoの`record`と同じbest-effort）。拒否は`denied`として記録する。

認証用のcommandは、Bantoの`auth_status`、`auth_setup`、`auth_login`、`auth_logout`、`auth_resolve`、`auth_change_password`を移植する。

- **UI**: native実行時に`TauriAuthProvider`を使う。
- **移植しないもの**: Bantoのauto-login（OS keyring）とLAN用の`AuthState` token。後続とする。
- **待受**: HTTP待受は追加しない。

## 6. 開発・初期設定フェーズと運用への移行

**新しい認証DBの初期値**: 認証DBを新たに作ったとき、hostは`auth.disabled=true`と`auth.disabled_role=admin`を保存する。これを開発・初期設定フェーズとする。

- **このフェーズでの動作**: ログインせずに`AuthDisabledLocal`のsessionで動き、記録変更も許す。
- **既存DB**: 保存値に従う。

**運用への移行**: 次の手順で行う。

1. 最初の管理者を`auth_setup`で作る。
2. その管理者でログインする。
3. 認証無効モードを切る。

- **移行の確認**: 管理者が存在することを、ブラウザの保存値でなくbackendで確認してから移行を確定する。
- **移行で失効するもの**: `banto-local:auth-disabled`の全registry sessionが失効する（§4）。
- **移行の制限**: native処理を進行中に移行しても、受理済み操作は監視が続くだけで止まらない。ただし運用側のユーザーからは照会できない（§8の未決事項1）。そのためUIは、未静止のworkflowがある間は移行を確認ダイアログで止める。

**認証DBが開けない場合**: 記録registryの入口はすべて拒否する。初期設定へ自動で戻さず、無認証の変更を許さない（access-policyのとおり）。

## 7. epoch生成と永続衝突防止

`ownerEpoch`は、root作成のたびにhostが生成する。

- **生成方法**: OSのCSPRNGから得た128bitを、32桁の小文字16進にする。
- **前回値との照合**: hostは、直前に使ったepochをアプリdata dirの`recording-epoch.json`へ保存する。生成値が前回値と一致したら、生成し直す。
- **保存の順序**: 保存はroot作成の前に行う。保存に失敗したら、rootを作らずに記録registryの入口を拒否する。

- **`ownerRef`**: インストールごとの固定値とする。初回に同じ方法で生成し、同じfileへ保存する。
- **旧epochの扱い**: 旧epochのref・lease・sessionを新rootへ移さない（wire・host契約のとおり）。
- **1件だけ保存する理由**: 128bitの乱数は再起動のたびに独立に生成されるので、衝突の確率は無視できる。前回値の照合は、乱数源の故障などで同じ値が出た場合への防御に限る。履歴の全件は保存しない。

## 8. 未決事項（レビューで確定する）

1. **principalごとの開示**: 現行registryはrecordとworkflowをprincipalに束縛している。そのため、Admin Aが始めたworkflowをAdmin Bが監視・取消できない。また開発フェーズのworkflowは、運用移行後に照会できない。初回は単一workflowなので現行のままとし、交代運用が必要になった時点で「Admin共有principal」案を別に設計するか。
2. **認証無効モードの初期値**: 新しい認証DBで認証無効をonとする（§6）のは、Bantoの既定（off）と逆である。access-policyの「開発中はログイン不要」に合わせる案だが、これでよいか。
3. **認証DBの置き場所**: 認証DBをHistorian DBと別fileにする（§2）。

## 9. 実装順

1. `scada-host`へ`HostAuth`（Bantoの依存、migrationのコピー、`DesktopSession`の再検証、`require_role`）を追加する。試験は一時SQLiteで行う。
2. `scada-runtime`へ`RecordingSessionIssuer`と`RecordingPrincipal`を追加し、失効の連動を試験する。
3. epochの生成と保存を追加する。
4. Tauri commandとUIの`TauriAuthProvider`を追加する。認証無効モード、ログイン、logout、role変更による失効、Viewerの読取限定をnativeで試験する。

製品transportと実ownerの配置（C5）は、この区切りの後に行う。
