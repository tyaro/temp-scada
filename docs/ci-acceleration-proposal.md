# CI高速化の変更案・メインチャットへの引継ぎ

状態: **採用した変更案と実装前の根拠**。2026-10-20（日本時間）。並列化設定とローカル検証を実施した。現在の進捗・Actions実測は[実装と検証記録](ci-acceleration-results.md)を参照する。以下は変更前の根拠と提案を保持する。

## 目的と根拠

検証範囲と成功条件を維持し、Push後に結果が分かるまでの時間を短縮する。PublicリポジトリでGitHub標準ホストランナーを利用する前提とする。標準ランナーの通常のActions実行は無料だが、大型ランナーは別扱い。同時実行数の上限とキュー待ちは残る。

成功済みの[基準CI（fdea3df）](https://github.com/tyaro/temp-scada/actions/runs/39348714448)のジョブ・ログを読み取った結果:

| 対象                                |                           実測 |
| ----------------------------------- | -----------------------------: |
| checkジョブ全体（開始〜完了）       |                      約12分7秒 |
| 型・TS単体・ビルド・E2E・整形の合計 |                       10分47秒 |
| うちPlaywright                      | 521件、2 workers、ログ上10.4分 |
| ChromiumとOS依存の導入              |                           20秒 |
| Rust fmt・clippy・test              |                           32秒 |
| Rustによるサンプル3件の検証         |                          約6秒 |

主な短縮対象はE2E。同時点のTS単体は8.14秒、Viteビルドは1.26秒であり、単体テストの隔離を弱める変更などは優先しない。件数・時間は当該コミットの基準値であり、Equipment等を追加した最新コードの値とは区別する。

現行設定: [ci.yml](../.github/workflows/ci.yml)、[playwright.config.ts](../playwright.config.ts)。現行は1ジョブでフロントエンドからRustまで直列実行し、pnpm storeのキャッシュのみ設定している。Playwrightのworkersは明示しておらず、基準ログでは2だった。

## 推奨する初期構成

| ジョブ         | 検証・設定                                                                         |
| -------------- | ---------------------------------------------------------------------------------- |
| frontend       | pnpm check / pnpm test / pnpm build / pnpm format:checkを別stepで実行              |
| rust           | cargo fmt / clippy / test / サンプル検証を別stepで実行。Rustビルドキャッシュを追加 |
| e2e（4ジョブ） | shard=1,2,3,4のmatrix。それぞれ依存とChromiumを導入し、全テストを4分担             |
| check          | 全ジョブをneedsで待ち、すべて成功した場合だけ成功する集約ジョブ                    |

frontend・rust・e2eは相互にneedsを設けず、並行開始する。E2Eは現在のVite開発サーバーを各ランナーで独立起動する。既存テストには開発モジュールを参照するものがあるため、本番previewへの切替を同時に行わない。

初期目標は全体4〜6分程度。ただし、ファイルごとの偏り、各ジョブの導入時間、キュー待ちがあり、実測前の見込みに留める。4分割のため同時に最大6つの検証ジョブを使用する。

### E2E分割の設定要点

実装時の骨格。checkout・Node・pnpm・依存導入・診断保存のstepは現行設定を引き継ぐ。

```yaml
e2e:
  name: e2e (${{ matrix.shard }}/4)
  runs-on: ubuntu-latest
  strategy:
    fail-fast: false
    matrix:
      shard: [1, 2, 3, 4]
  steps:
    # checkout / pnpm / Node / pnpm install
    - run: pnpm exec playwright install --with-deps chromium
    - run: pnpm e2e --shard=${{ matrix.shard }}/4 --workers=2
    - name: Save failure diagnostics
      if: failure()
      uses: actions/upload-artifact@v4
      with:
        name: scada-e2e-${{ matrix.shard }}-${{ github.run_attempt }}
        path: |
          test-results/
          playwright-report/
        if-no-files-found: ignore
        retention-days: 7
```

同じランナーのworkersを増やさず、ランナーを分けて負荷を分散する。各shardは独自のサーバーとブラウザを持つ。`fail-fast: false`で1つの失敗後も他のshardを確認する。診断artifact名にはshardとrun_attemptを含め、衝突を防ぐ。

初期は`fullyParallel`を追加せず、現行のファイル単位の実行契約を保つ。shard間で長さに偏りが出たら、遅いファイルとテスト間の依存を確認してから再評価する。分割だけで均等な実行時間になるとは保証しない。

HTMLレポートはshard別に確認できれば初期範囲として十分。統合HTMLが必要になった場合はblob reporterとmerge-reportsを別工程で追加する。レポート統合の成功でテスト失敗を隠さない。

### 集約ジョブと必須チェック

従来のジョブ名`check`を集約先に使い、frontend・rust・全shardの結果を評価する。概念例:

```yaml
check:
  if: ${{ always() }}
  needs: [frontend, rust, e2e]
  runs-on: ubuntu-latest
  steps:
    - name: Require all checks to pass
      env:
        FRONTEND_RESULT: ${{ needs.frontend.result }}
        RUST_RESULT: ${{ needs.rust.result }}
        E2E_RESULT: ${{ needs.e2e.result }}
      run: |
        test "$FRONTEND_RESULT" = success
        test "$RUST_RESULT" = success
        test "$E2E_RESULT" = success
```

上記は各testの失敗で終了するGitHub標準bashの設定を前提とする。`continue-on-error`は設けない。失敗・取消・意図しないskipを成功扱いしない。実装時はGitHub側のbranch protection／rulesetを読み取り、実際の必須チェック名と整合することを確認する。名称を保っても、その確認なしに互換性があるとは断定しない。保護設定の変更はこの案の対象外。

### キャッシュと導入処理

- Nodeは現行の24、pnpmはpackageManagerの指定、Rustは現行の固定バージョンを維持する。依存導入は`--frozen-lockfile`／Rustは`--locked`を維持する。
- Nodeを使う各ジョブに現行のpnpm storeキャッシュを設定する。ブラウザはE2Eジョブだけ、Rust toolchainはRustジョブだけに導入する。
- Rustには`Swatinem/rust-cache`等の標準的なキャッシュを導入する。採用版・参照固定方法は既存方針に合わせ、lockfile・toolchain・workspaceとの対応を確認する。キャッシュがなくても検証を完遂できることを条件とする。
- Chromium導入は基準で20秒のため、初期はブラウザキャッシュを追加しない。OS依存の導入は必要であり、取得・保存の時間まで含めて利益が確認できた場合に追加する。
- フロントエンドとRustの両方で使うJSON Schema／サンプルがあるため、初期は変更パスによる検証省略を導入しない。

## 初期範囲から外すもの

テストの削減、タイムアウト延長、retry追加、assertion緩和、テスト隔離の解除、アプリの仕様変更は行わない。失敗を再試行で隠して高速化の成功としない。

push／pull_requestの二重起動対策と同一ブランチの古い実行取消は、必要なイベント・参照・必須チェックへの影響を整理してから検討する。初期は現行の両イベントを維持する。大型ランナー・self-hostedへの移行も初期範囲に含めない。

## 実装・検証手順と完了条件

1. メイン側の最新HEAD・未コミット差分・CI成功状況を確認する。作業中のEquipment等の変更をCI差分へ混ぜない。
2. 原則`.github/workflows/ci.yml`だけを変更し、既存コマンドをすべて引き継ぐ。Playwright設定やアプリの変更が必要なら、その理由を別途記録する。
3. workflowをactionlint等で静的確認し、リポジトリ指定の整形を確認する。GitHub式とmatrixの構文も検証する。
4. 同じテスト集合について`--list`の全体と4shardの結果を比較し、欠落・重複がないことを確認する。521件を固定値にせず、実装時点の全件を基準にする。
5. ローカルで可能な構文・列挙確認を終えてから、CIだけの区切りでコミット・Pushし、実際のActionsを確認する。ローカル成功だけではCI高速化完了としない。
6. 全shard、frontend、rust、サンプル検証、集約checkの成功と、既存の失敗診断保存設定が残ることを確認する。集約条件は成功／失敗／取消／skipの入力で静的・ローカルに確認し、意図的な失敗コミットのPushは不要。
7. 変更後の実行URL、SHA、各shardの件数・時間、全体所要時間、キュー待ちとcache hitの有無を記録する。可能なら通常の連続した2〜3回で安定性を確認し、初回とcache利用時を区別する。

全体の成功条件・対象テストを維持し、短縮を実測できた時点で完了とする。4分割が偏る場合や同時実行枠が不足する場合は、shardごとの実測から調整する。目標未達を理由に判定条件を弱めない。

## メインチャットへ渡す依頼文

```text
サイドチャットでまとめたCI高速化案を確認し、実装してください。
/workspace/temp-scada/docs/ci-acceleration-proposal.md

E2Eの4shard化、frontend／Rustの並行実行、Rustキャッシュ、
既存check名の集約ジョブを中心に進めてください。
検証範囲・成功条件・失敗診断は維持してください。
最新の機能開発差分と分け、CIで実測してから完了を判断してください。
この文書は提案であり、CI設定自体はまだ変更していません。
```

このサイドチャットの変更は本ファイルのみ。既存の開発計画・実装状況・workflow・アプリには手を加えず、コミットもメインチャットへ引き継ぐ。
