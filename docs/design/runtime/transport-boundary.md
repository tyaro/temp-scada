# P3b: 製品transportと接続設定の再開条件

2026-11-01（日本時間）。状態: **境界を採用、製品transportは保留**。P3aはPR #12でマージ済み。認証延期はユーザーの既存指示であり、今回の調査で解除しない。

現行はViteのローカル編集アプリとRustライブラリで、Tauri hostもSCADA serverもない。P3aの`ReadSource`は配送の差込み口であり、利用可能な製品transportではない。現在の段階で無認証HTTP待受やブラウザからHubへの接続を追加しない。

## 所有と配送

- Rust hostが接続先・資格情報・SDK・Project読取sessionを所有する。Project、ブラウザstorage、表示DTOへ資格情報を入れない。
- 接続設定はProject外のhost設定とする。接続先の変更は読取とcatalogの両所有者を置換し、先に画面deliveryを無効化する。
- `ReadDisplayStream`と`ReadSource.subscribe`へ渡す`begin()`のdeliveryを一対一にする。購読開始応答で対応を確定し、通常payloadでsessionを作らない。旧通知・旧終了通知は新deliveryへ適用しない。
- 切断・失敗・停止・Project置換では値を消す。再接続は新しい購読開始応答とdeliveryを必要とする。配送queueは最新値に制限し、履歴記録に流用しない。
- catalogは値の配送と分離し、Hostの明示した読取要求で取得する。値を参照していないProjectでもcatalogを取得できる。catalogをSDKの値snapshotへ混ぜない。

## 再開時に確定する項目

1. 最初の製品hostをTauri／SCADA serverのどちらに置くかと、Bantoの既存API・認証の最新契約を確認する。
2. 接続設定の保存先・配布・切替、資格情報の提供と破棄、匿名閲覧の接続範囲を決める。既存の[アクセス方針](access-policy.md)に従う。
3. transportの購読開始／終了・取消・サイズ制限・timeout・backpressureと、配送sessionの対応を実装する。任意の遅延イベントで新sessionを開始できる経路を作らない。
4. 実Hubへの接続はS7 SOAKの終了と接続対象の確認後に行う。実PLC・Windows・本番運用の結果をモック試験から推定しない。

この保留はRustのcatalog取得・表示DTO・選択session・fixtureでの受入を妨げない。次のP4を独立して進める。P3bを完了扱いしない。
