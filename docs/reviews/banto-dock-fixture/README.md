# Banto DockHostの再現fixture

比較評価で用いた10ケースを再実行するための最小画面と観測スクリプト。Bantoのソースは同梱・変更しない。指定したcheckoutからdock-svelteとthemeだけを一時ディレクトリへコピーし、SCADAの実`createDraftGuard`を使う。

## 実行

temp-scadaの依存導入とChromiumの準備後、リポジトリのルートで実行する。Bantoの元評価版は`591294bea61c7dcbd0b41102dae57c3bdf0602b8`。修正後のcheckoutを指定して比較することもできる。

```sh
source scripts/cloud-env.sh
BANTO_SOURCE_DIR=/path/to/banto node docs/reviews/banto-dock-fixture/run.mjs
```

`BANTO_SOURCE_DIR`は`packages/dock-svelte`と`packages/theme`を含むBantoソースのルート。認証情報は不要で、ネットワーク取得はこのrunnerでは行わない。既定ポート5229は`DOCK_EVALUATION_PORT`で変更できる。Chromiumの場所は通常の`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`設定を使う。

実行結果は表示された一時ディレクトリの`results.json`へ保存し、サーバーは終了する。一時ファイルは修正・確認のため残す。runnerはSCADAのProjectやUI設定を変更しない。

## 結果の扱い

これは**挙動の観測fixture**であり、不具合が直ったことを緑で示す受入テストではない。操作前提が崩れれば失敗するが、未適用入力の消失などはJSONへそのまま記録する。元評価の[10ケースと観測値](../banto-dock-evaluation-2026-10-21.json)、[比較資料](../banto-dock-comparison.md)と照合する。上流修正時には必要な期待値をassertionへ変え、Banto自身のテストへ移す。

IMEは実OSで未検証。blurと別pointerIdは合成イベント。key付きの代表的なpaneであり、全consumerの回帰や完全なSCADA移植を証明しない。フォーム保護はSCADA guardを使い、Banto formsの現行テストを置き換えない。

## 再利用する既存資産

- [SCADA guard](../../../apps/banto-scada/src/lib/designer/drafts.svelte.ts): 現在のDOM依存契約を確認する実consumer。
- [共通浮動controller](../../../apps/banto-scada/src/lib/designer/controllers/floating-panel.svelte.ts): 単一gesture所有者、取消、keyboard、上位layerとの連携の参考。
- [配置計算と保存値検証](../../../apps/banto-scada/src/lib/designer/floating-panel-layout.ts)と[単体テスト](../../../apps/banto-scada/src/lib/designer/floating-panel-layout.test.ts)。
- [Inspectorのブラウザテスト](../../../e2e/inspector-floating.spec.ts)、[左右パネルのブラウザテスト](../../../e2e/sidebar-floating.spec.ts): DOM・draft、取消、保存失敗、狭幅、前面化の受入仕様。

上流への移植は、SCADAのpanel ID・Project・Undoへ依存する部分をcallbackとして外す。SCADA全体のコピーやBantoからtemp-scadaへの依存は作らず、汎用契約と最小fixtureを上流自身のテストへ抽出する。
