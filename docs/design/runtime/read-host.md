# P2: Project単位の読取Host

2026-11-01（日本時間）。状態: **実装・ローカル検証済み**。[SOAK中の計画](../../project/soak-independent-runtime-plan.md)のP2。P1は[PR #10](https://github.com/tyaro/temp-scada/pull/10)でマージ済み。

## 対象と責務

`crates/scada-runtime`にUI非依存のRust Hostを置く。検証済みProjectから数値Textと採用済み機器slotのplanを作り、外部名を重複排除してSDK handleを1つ所有する。SDK接続状態の更新をP1の純粋adapterへ渡し、Textとslotの表示DTOを同じ更新として公開する。

接続・再試行・再解決・Quality・Staleの判定は固定SDKが所有する。Hostはそれらの状態機械を実装しない。PLC・S7環境へ接続しない。Tauri／REST transport、認証、接続設定UI、正式Runtime modeはP2に含めない。画面との接続が完成したとは扱わない。

## 公開API

- `ReadHost::new(&Project)`はplanと停止中の表示を用意する。Tokio runtimeやネットワークは不要。
- `replace(&mut self, &Project, Option<RestClient>)`はProject・接続先・資格情報・要求集合の置換入口。`None`は未接続。`Some`でも要求0件ならSDKを開始しない。呼出側が用意したRestClientの資格情報を保持するのはSDKであり、Hostの表示DTOには載せない。
- `stop(&mut self)`はsessionを更新して表示を先に停止状態へ置き換え、その後で旧pumpを中止・joinし、SDKをshutdownする。SDKが返す終端エラーは保持し、正常終了へ変換しない。
- `state()`／`state_watch()`はbounded latestの表示frameを返す。frameはローカルsession token・SDK generation・Text／slotのDTOを持つ。catalog全件・接続先・資格情報は公開しない。
- `ReadSession`はopaqueなプロセス内token。ProjectのID／revisionやSDK generationから生成せず、読込・置換・停止のたびに新しくする。保存・JSON化しない。`is_current()`で旧通知を判別する。

フロントエンドの既存session tokenとはまだ接続しない。P3のtransport接続時に、Host sessionの変更をUIのresetへ対応させる。保管済みのframeは過去のsnapshotであり、古い値を新しいsessionへ適用しない。watchは全履歴の配信口ではなく、購読側はborrowをcloneしてから非同期処理へ渡す。

## 置換の順序と失敗

1. 新Projectからplanを作る。plan構築に失敗した場合は旧sessionを保持する。
2. 新tokenと無値のframeを**最初のawaitより前**に公開し、新planを所有する。この時点から旧taskのtokenによるpublishを拒否する。
3. 旧pumpをabort・joinし、旧SDKをshutdownしてjoinする。新旧の購読を同時に開始しない。
4. RestClientあり・要求ありなら、新要求の`start()`を呼ぶ。`restart()`は要求集合を引き継ぐため使わない。pumpはSDK watchの最新状態を投影する。
5. `start()`が失敗した場合は新sessionを無値の停止状態に保ち、安定したErrorKindを返す。資格情報や任意文字列をframeに含めない。

旧SDKがUnauthorized等で終了済みでも、shutdownで得たエラーは置換結果の`previous_error`へ残し、新接続の開始を妨げない。旧エラーを新sessionの現在エラーにしない。明示stopはshutdownのエラーを呼出側へ返す。

置換futureを途中でdropすると、表示は既に無効化されたsessionのまま、旧pumpとSDKの所有者は破棄される。新接続は開始されない。再開は明示的な次のreplaceで行う。Hostのdropも先に新tokenの停止frameを公開し、pumpをabort・SDKをdropする。通常停止はstopによるjoinを使う。

## publishと世代

公開frameのwatch slotをsessionの唯一の権威とする。resetとpublishは同じslotのロックで直列化し、pumpは`send_if_modified`内でtokenを照合してから置き換える。旧taskが投影を終えていてもreset後に上書きできない。SDK更新をHostが別の無制限queueへ複製しない。

一つのSDK状態からText／slotの両方を投影する。各planは集約購読の部分集合で、binding keyは外部名へ統一する。未割付slotと機能未採用を区別する。要求0件では無値のstopped frameを維持する。

## 受入

実SDKとloopbackモックで次を確認する。

1. Textとslotの同名要求が1つのsubscribeになり、複数contextへ同じ世代の値が届く。
2. 未割付を保持し、要求0件ではHTTP／WSを送らない。
3. 同ID／revisionのProject再読込でもtokenが変わり、変更後の要求だけを購読する。
4. 接続先変更で旧socketを閉じてから新接続を始め、旧値と旧通知を拒否する。
5. replace／stopの最初のpollで無値になり、待機中の取消とHost dropでも旧値が復帰しない。
6. Bad／Stale・切断・Unbound・UnauthorizedをP1の表示へ反映する。資格情報がDTOへ混入しない。
7. shutdownの終端エラーを保持しつつ、明示した新接続へ置換できる。
8. watch購読後の初期状態・最新値・停止通知を確認する。旧tokenのpublishをreset後に実行しても拒否されることを契約試験で確認する。

Rust workspaceテスト・Clippy・fmtを実行する。今回はTS／保存形式／UIを変更しないため、ブラウザのHost接続試験はP3に残す。CIはReady for ReviewのPRで確認する。

## 実施結果

`src/host.rs`と`tests/read_host.rs`へ実装した。Rust workspace68件、Clippy `-D warnings`、rustfmtが成功した。Hostのモック統合12件に加え、旧tokenのpublish拒否を単体で確認した。TS／画面・SDK rev・Project0.35.0は変更していない。全体CIの結果はPR、次工程と未検証は[実行計画](../../project/soak-independent-runtime-plan.md)を参照する。
