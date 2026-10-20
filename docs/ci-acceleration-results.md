# CI並列化の実装と検証

状態: **設定とローカル検証を完了。Actionsの実測はPush後に確認する。** 2026-10-20。[変更案](ci-acceleration-proposal.md)に沿い、機能実装と分けて実施した。

## 変更内容

`.github/workflows/ci.yml`をfrontend・rust・4つのE2E shardと集約checkへ分割した。各ランナーはubuntu-latest。Node24・pnpm固定版・Rust1.98.1とlocked installを維持し、Rust cacheはSwatinem/rust-cache v2の取得時commit `6323deb102c322ba6fcbdcafc7e3dddab59af2b6`へ固定した。

E2Eは各shardで独立したVite開発サーバーを使い、2 workersで実行する。fullyParallel・retry・timeout・assertion・対象テストを変更しない。fail-fastはfalseとし、失敗診断のtest-results／HTML reportをshardとrun_attemptごとに保存する。frontendとrustは相互に待たず開始する。既存の検証コマンドとサンプル3件は全て維持した。

集約ジョブは従来の`check`を維持し、alwaysで結果を評価する。frontend・rust・全E2E matrixが成功した場合だけ成功する。明示bashのfail-fastを使い、失敗・取消・skipを成功にしない。

## ローカル確認

- actionlint v1.7.12でworkflow検査が成功。配布archiveの公式SHA256を確認して使用した。
- Playwrightの同じ設定で全件と4shardをJSON列挙し、526件の集合と多重度が一致した。shardごとの件数は132／133／136／125、欠落・重複なし。
- 実際の集約run scriptをbashで実行し、success／failure／cancelled／skippedの全64組を確認。3結果がsuccessの1組だけが成功した。
- workflowのPrettierとdiff checkが成功。

GitHubのrulesets APIは空配列。従来型のworkブランチ保護APIはintegration権限による403で読み取れなかったため、必須チェック設定全体との互換性は断定しない。チェック名を維持し、保護設定は変更していない。これはシェルの自動承認拒否ではなく、GitHub APIの読取権限制約。

アプリ・Project・テスト・Playwright設定は変更していない。CI速度の見込みを測定完了とは扱わず、全ジョブ成功・実時間・cache hitはActionsの結果から追記する。
