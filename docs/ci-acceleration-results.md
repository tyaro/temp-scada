# CI並列化の実装と検証

状態: **設定・ローカル検証・初回Actions成功を確認。キャッシュ利用時も継続確認する。** 2026-10-20。[変更案](ci-acceleration-proposal.md)に沿い、機能実装と分けて実施した。

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

## 初回のActions実測

`35789b5`の[初回実行](https://github.com/tyaro/temp-scada/actions/runs/39353860620)は全ジョブと集約checkが成功した。作成01:31:01 UTCから集約完了まで**4分25秒**。検証ジョブは作成から2〜3秒で開始し、各検証を開始できるまでのキュー待ちはほぼなかった。

| ジョブ   |                             件数 | ジョブ所要時間 | E2E実行step |
| -------- | -------------------------------: | -------------: | ----------: |
| frontend |           TS715、型・build・整形 |           34秒 |           — |
| rust     | Rust43、fmt・clippy・サンプル3件 |           77秒 |           — |
| e2e 1/4  |                              132 |        4分18秒 |     3分50秒 |
| e2e 2/4  |                              133 |        3分58秒 |     3分27秒 |
| e2e 3/4  |                              136 |         4分6秒 |     3分31秒 |
| e2e 4/4  |                              125 |        3分25秒 |     2分39秒 |
| check    |                    全needsの成功 |            3秒 |           — |

E2E全526件が成功し、skip・retryによる成功への置換はない。Rust cacheは初回missで、実行後に約241MBのcacheを保存した。pnpm storeは既存cache hit。ジョブ時刻はActions jobs API、件数・テスト時間・cache状態は各ジョブのログから確認した。matrix名にslashがあるジョブのログはgh run全体ログで欠けたため、jobs APIから個別取得して確認した。

変更案の旧基準`fdea3df`は521件で12分7秒。今回の初回は4分25秒で、件数が5件増えても約64%短い。ただし同一件数526件の直前CI `4ed2f52`も別途確認し、条件差を区別して記録する。ここまでの値は単一の初回測定で、毎回の所要時間を保証するものではない。
