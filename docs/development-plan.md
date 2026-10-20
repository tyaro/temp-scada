# SCADA の独立開発と industrial への統合

状態: **今後の実施計画**。現在の実装・保存契約・検証範囲は[実装状況](implementation-status.md)、日付付き記録は[実装履歴](implementation-history.md)へ集約した。機能仕様の基準は[統合設計](scada-integrated-design.md)。

`banto-industrial`の開発と並行してtemp-scadaで先行開発し、最終的にindustrialへ戻す。Banto基盤を維持し、認証はindustrial側の修正中につき延期する。リリース前のProject互換性は保証せず、変更後のTS／Rust／schema／現行サンプルの整合性を維持する。

## 次の実装順

画像トリミングまでの機能区切りを保存し、[リファクタリング実行計画](maintenance-refactoring-plan.md)のR0〜R4とR5a〜R5fを実装した。R5はコマンド型・分類、各handlerと入口全体の網羅性まで分離し、型・TS637件・全ブラウザ509件・Rust30件・本番ビルド・整形のローカル全体検証を完了。最終差分`4daf011`の[全体CI](https://github.com/tyaro/temp-scada/actions/runs/39338577347)も成功し、R0〜R5を完了した。各小区切りの詳細は実行計画へ集約する。機能追加・保存契約変更を構造整理と同じ差分へ混ぜない。R6は[初回計測と候補コピーの限定改善](editor-performance.md)を実施した。大きなProjectでの重複検証を減らし、差分Undoやcacheの導入は見送った。以降の性能改善も実測から選び、必要性を確認せず先行導入しない。

構造整理後のEditor拡張は、幾何グループ、Equipment／型付きslotと読取表示、実Tag Browser、設備Faceplate等を依存順に具体化する。[幾何グループの初回設計](geometric-groups-design.md)に、所属モデル・一括移動／90度回転・既存操作の拒否条件・clipboard・実装順を整理した。0.22.0でG1／G2の保存契約・ドメイン・再利用とG3のDesigner接続を実装し、G4の全体ブラウザ521件と両テーマの実画面・プレビュー画素一致も確認した。Equipmentの前段として[型付き読取slotのadapter](typed-read-slots-design.md)を実装し、bool／numberと機器contextを共通投影へ接続した。[Equipmentの保存契約と初期台帳](equipment-register-design.md)を0.23.0で実装した。0.24.0で[Symbol配置の機器参照・使用先・削除保護](equipment-symbol-association.md)を実装した。0.25.0で[Symbolの型付きslot要求と機器contextの取得前状態表示](symbol-read-slots.md)を追加した。[ReadSlotView受入境界とGood／Quality表示](read-slot-presentation.md)も実装し、世代・型・外部名の照合と同一mount更新をテスト入力で確認する。実Hostへはまだ接続していない。[slot宣言の追加・未使用編集／削除と参照保護](symbol-slot-editing.md)を追加した。[bool状態判定の前段](bool-slot-state.md)としてGood限定の型付き値・true／false／unknown・SIMと理由の分離を実装した。0.26.0で[bool Textの状態別文字色](bool-text-colors.md)の保存・描画・編集UIを実装した。[図面外の読取状態表示](slot-status-summary.md)を追加し、縮小・α・クリップと独立した取得不能／SIMの確認へ進めた。0.27.0で[共有図形・配管の状態色追従](state-color-following.md)と参照保護を追加した。以後は実catalogとHost・Faceplateを依存順に接続する。任意拡縮・入れ子・Symbol定義内グループは後続とする。[機器作成の追加検討](equipment-authoring-detail-proposal.md)は採用候補と独立試作であり、全機能の着手指示ではない。原本プレビュー上のドラッグcropは[入力補助として実装](image-crop-pointer-design.md)した。埋込Viewのclipboardは[依存画面・原本を含むv4](screen-view-clipboard-design.md)を追加した。図面上の直接crop、正式RuntimeのPopupは独立した後続工程。浮動／再ドッキング・レイアウト全体の保存も機能と責務を揃えた後の工程とする。

実catalogとHost接続へ着手するときはindustrial #682等の最新SDK契約を確認する。現在はSDK投影・モックHubまでで、正式Runtimeの完成ではない。認証・ユーザー管理・運用への移行は延期を維持し、ローカル編集はログイン不要。再起動後にログインなしで読取監視へ入る要望も維持する。

Core v1へ向けた技術工程:

1. S0／S1を拡張し、Design Domain、正式Project layout、型・参照整合性・revision／contentHashを固める。
2. S2の配置・選択・移動・プロパティ編集をDesign Domainへ接続する。
3. S3は共有`banto-tagclient`による実Hub接続と値・Quality、停止と再接続を検証する。
4. S4は正式directory／ZIPとimport preview。リリース前の旧形式migrationは必須にしない。
5. Equipment／Symbol、Tag Browser、基本Actionとmode分離を段階追加し、S9bのscada-server core＋host 1をCore v1基盤として整える。

v1.1のAlarm・常時Event／Action・History／Trend・recorderとWindowsサービス化はS9bの上に追加する。Design DomainはCore v1、Design APIのREST／OpenAPI公開は後続という区分を維持する。

## 作成支援・プラント運用の追加検討（2026-10-20・日本時間）

[追加検討資料](scada-authoring-plant-operations-proposal.md)に、機器台帳と図面の双方向登録、機器ごとの任意信号・遠隔操作・Faceplate、図形合成、Studio／ドックの仕上げ、Hubタグからの記録設定・ペン選択・用途グループ・自動配色、監視用メニュー・文書・試験生成、機器／シーケンス／ステップの条件、アラーム対処、通信状態と復旧・引継ぎを整理した。ユーザー要望と追加提案、既存計画への対応、未決事項、受入観点を区別している。

設計資料の追加であり、実装状況表を完了へ変更するものではない。記録対象と表示グループのモデル対応、PLC情報との対応、各機能の提供範囲は詳細設計で決める。S9bはCore v1、Alarm／History等はその上のv1.1という既存段階、認証統合の延期、共有層の再利用とPLC直接接続なしの方針を維持する。

## 参照元

- repository: https://github.com/tyaro/banto-industrial
- branch: main（取得時点）
- commit: `c4a61bc08ddf6d03fa56974bf1fcad08d12cbb5a`
- [SCADA 設計書](upstream/industrial/scada-design.md)
- [ドキュメント索引](upstream/industrial/README.md)
- [Hub client SDK](upstream/industrial/banto-tagclient-design.md)
- [実装時の注意点](upstream/industrial/implementation-checklist.md)

`docs/upstream/industrial` は出典コミットの `docs/` 全体をそのままコピーした参照用スナップショットです。文書間のリンクを保つため全体を保存しています。リポジトリ外やコードへの相対リンクは元の GitHub の同コミットを参照してください。上流の「実装済み」は industrial 側の状態を指します。§20 の monorepo 配置の決定は維持し、ここでの独立開発を一時的な例外として扱います。コピーした原文は編集せず、この文書に独立開発上の差分を記録します。

## 外部の参考実装の取り扱い

`https://github.com/tyaro/ems-apps` は操作感や情報構成の参考に限る。ユーザー指示（2026-10-18）に従い、画面・コンポーネント・画像等のコードやアセットをこのリポジトリへ取り込まない。SCADA のエディタとランタイムはこちらの設計に沿って独立実装する。

## 共有部品の扱い

SCADA は PLC に直接接続しません。Hub を独立した外部サービスとして利用し、SCADA 側に PLC ドライバをコピーしません。式評価を TypeScript で再実装しません。

`banto-tagclient` / `banto-expr` が必要になった時点で、industrial の動作確認済みコミットを `git + rev` に固定して依存に追加します。最初の参照候補は上記コミットです。`banto-tagclient` は今回の投影境界で利用を開始しました。`banto-expr` は式機能がまだないため依存に追加していません。SDK の変更が必要になったら industrial 側で共有契約を変更してから参照を更新します。

## 戻す手順

- `apps/banto-scada` / `crates/scada-*` と固有のサンプル・テストを元の配置へ移す。
- 共有 crate の `git + rev` 参照を industrial workspace の既存 `path` 参照に変更する。
- frontend / Rust の workspace、必要な依存、lockfile を industrial 側で統合する。この一時 repo のルート設定で上流の設定全体を置換しない。
- industrial の CI にある SCADA 追加手順に従い、path-aware CI と frontend / E2E の対象に追加する。
- SCADA の検証と、影響した Hub / 共有 crate の回帰検証を実行する。
- この repo の独立開発上の決定を上流設計書に反映する。参照元コミットと再統合時の upstream 差分をレビューする。

## 過去のリンクからの案内

以下は既存リンクを維持する移動案内。実装済み機能の一覧は[実装状況](implementation-status.md)で確認する。

<a id="implementation-status"></a>

## 現在の実装状況（2026-10-20・日本時間）

現在情報は[実装状況](implementation-status.md)へ集約した。

<a id="image-crop-progress"></a>

## 配置画像トリミングの保存・描画・操作（2026-10-20・日本時間）

[この時点の実装・検証記録](implementation-history.md#image-crop-progress)へ移動した。

<a id="image-crop-foundation-progress"></a>

## 配置画像トリミングの計算基盤（2026-10-20・日本時間）

[この時点の実装・検証記録](implementation-history.md#image-crop-foundation-progress)へ移動した。

<a id="image-replacement-progress"></a>

## 配置画像の差し替え（2026-10-20・日本時間）

[この時点の実装・検証記録](implementation-history.md#image-replacement-progress)へ移動した。

<a id="preview-fullscreen-progress"></a>

## ブラウザ全画面での表示確認（2026-10-20・日本時間）

[この時点の実装・検証記録](implementation-history.md#preview-fullscreen-progress)へ移動した。

<a id="preview-popup-progress"></a>

## プレビュー専用の画面内Popup（2026-10-20・日本時間）

[この時点の実装・検証記録](implementation-history.md#preview-popup-progress)へ移動した。

## 画面内Popupの計算基礎（2026-10-20・日本時間）

[この時点の実装・検証記録](implementation-history.md#history-007)へ移動した。

<a id="screen-view-progress"></a>

## 別画面の埋込表示（2026-10-20・日本時間）

[この時点の実装・検証記録](implementation-history.md#screen-view-progress)へ移動した。

## 埋込Viewに向けた共通描画の分離（2026-10-20・日本時間）

[この時点の実装・検証記録](implementation-history.md#history-009)へ移動した。

<a id="screen-reference-foundation-progress"></a>

## 埋込Viewの参照計算基礎（2026-10-20・日本時間）

[この時点の実装・検証記録](implementation-history.md#screen-reference-foundation-progress)へ移動した。

<a id="pattern-paint-progress"></a>

## 繰返しパターンの編集・保存（2026-10-20・日本時間）

[この時点の実装・検証記録](implementation-history.md#pattern-paint-progress)へ移動した。

<a id="pattern-foundation-progress"></a>

## 繰返しパターンのタイル計算（2026-10-20・日本時間）

[この時点の実装・検証記録](implementation-history.md#pattern-foundation-progress)へ移動した。

<a id="linear-gradient-progress"></a>

## 2色線形グラデーション（2026-10-20・日本時間）

[この時点の実装・検証記録](implementation-history.md#linear-gradient-progress)へ移動した。

<a id="linear-gradient-foundation-progress"></a>

## 線形グラデーションの計算基礎（2026-10-20・日本時間）

[この時点の実装・検証記録](implementation-history.md#linear-gradient-foundation-progress)へ移動した。

<a id="asset-clipboard-progress"></a>

## 原本を含む図形clipboard（2026-10-20・日本時間）

[この時点の実装・検証記録](implementation-history.md#asset-clipboard-progress)へ移動した。

<a id="image-paste-progress"></a>

## OS画像の貼り付け（2026-10-20・日本時間）

[この時点の実装・検証記録](implementation-history.md#image-paste-progress)へ移動した。

<a id="image-placement-progress"></a>

## 画面上のImage配置（2026-10-20・日本時間）

[この時点の実装・検証記録](implementation-history.md#image-placement-progress)へ移動した。

<a id="background-image-progress"></a>

## 背景画像と画像同梱の最小package（2026-10-20・日本時間）

[この時点の実装・検証記録](implementation-history.md#background-image-progress)へ移動した。

<a id="image-assets-foundation-progress"></a>

## 不変画像Storeの基礎（2026-10-20・日本時間）

[この時点の実装・検証記録](implementation-history.md#image-assets-foundation-progress)へ移動した。

<a id="color-alpha-progress"></a>

## 単色と枠線のα（2026-10-20・日本時間）

[この時点の実装・検証記録](implementation-history.md#color-alpha-progress)へ移動した。

<a id="opacity-progress"></a>

## 配置全体の不透明度（2026-10-20・日本時間）

[この時点の実装・検証記録](implementation-history.md#opacity-progress)へ移動した。

<a id="line-style-progress"></a>

## 実線・破線・点線（2026-10-20・日本時間）

[この時点の実装・検証記録](implementation-history.md#line-style-progress)へ移動した。

## 追加要望の用語確認を反映（2026-10-20・日本時間）

[この時点の実装・検証記録](implementation-history.md#history-023)へ移動した。

<a id="graphics-runtime-extension-review"></a>

## 画像・描画表現・運用画面の追加検討（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#graphics-runtime-extension-review)へ移動した。

<a id="folder-drag-progress"></a>

## フォルダー自身のドラッグによる親変更（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#folder-drag-progress)へ移動した。

<a id="text-style-progress"></a>

## Textの書式と枠内表示（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#text-style-progress)へ移動した。

<a id="interaction-snapshot-progress"></a>

## 編集途中の履歴変更に対する中断（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#interaction-snapshot-progress)へ移動した。

<a id="object-rotation-progress"></a>

## 配置の回転（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#object-rotation-progress)へ移動した。

<a id="rotation-foundation-progress"></a>

## 配置回転の計算基盤（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#rotation-foundation-progress)へ移動した。

<a id="layer-drag-progress"></a>

## レイヤー配置のドラッグによる所属変更（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#layer-drag-progress)へ移動した。

<a id="selection-view-progress"></a>

## 選択範囲の表示（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#selection-view-progress)へ移動した。

<a id="selection-outline-progress"></a>

## 矩形・楕円の枠線一括編集（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#selection-outline-progress)へ移動した。

<a id="shape-paint-progress"></a>

## 矩形・楕円の塗りと枠線（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#shape-paint-progress)へ移動した。

<a id="symbol-color-progress"></a>

## Symbolの静的な配色（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#symbol-color-progress)へ移動した。

<a id="selection-line-progress"></a>

## 線・配管の一括スタイル編集（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#selection-line-progress)へ移動した。

<a id="layer-folder-ui-progress"></a>

## レイヤーフォルダーの階層UI（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#layer-folder-ui-progress)へ移動した。

<a id="layer-folder-model-progress"></a>

## レイヤーフォルダーの保存契約（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#layer-folder-model-progress)へ移動した。

<a id="layout-reset-progress"></a>

## 標準固定レイアウトへの復元（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#layout-reset-progress)へ移動した。

<a id="distribute-progress"></a>

## 中心の等間隔配置（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#distribute-progress)へ移動した。

<a id="selection-color-progress"></a>

## 複数選択の色編集（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#selection-color-progress)へ移動した。

<a id="standard-names-progress"></a>

## Project名とF2／F1（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#standard-names-progress)へ移動した。

<a id="visibility-progress"></a>

## 静的な図面の表示切替（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#visibility-progress)へ移動した。

<a id="edit-lock-progress"></a>

## 配置の編集ロック（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#edit-lock-progress)へ移動した。

<a id="placement-name-progress"></a>

## 配置名とレイヤー・使用先検索（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#placement-name-progress)へ移動した。

<a id="new-project-progress"></a>

## 新しいProjectと標準ファイルキー（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#new-project-progress)へ移動した。

<a id="tag-picker-progress"></a>

## 数値Textへのサンプルタグ選択（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#tag-picker-progress)へ移動した。

## 選択配置の方向キー移動（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#history-047)へ移動した。

<a id="rulers-progress"></a>

## 図面の原点・倍率に追従するルーラー（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#rulers-progress)へ移動した。

## OSクリップボードとDeleteによる編集（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#history-049)へ移動した。

## Windows標準に合わせたホイール操作（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#history-050)へ移動した。

<a id="range-selection-progress"></a>

## 空白ドラッグによる範囲選択（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#range-selection-progress)へ移動した。

## Projectファイル操作をメニューへ集約（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#history-052)へ移動した。

<a id="minimap-progress"></a>

## 工程図のミニマップ（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#minimap-progress)へ移動した。

<a id="continuous-placement-progress"></a>

## クリック位置への連続配置（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#continuous-placement-progress)へ移動した。

<a id="favorites-progress"></a>

## お気に入り部品ドック（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#favorites-progress)へ移動した。

## 操作試作を基準にした Studio 外観の適用（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#history-056)へ移動した。

## ツリー行をフラットなデザインへ調整（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#history-057)へ移動した。

## プロジェクト・レイヤーのツリー表示（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#history-058)へ移動した。

## プロパティ数値のEnter／フォーカス移動での確定（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#history-059)へ移動した。

## サイドチャットの操作試作レビュー（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#history-060)へ移動した。

## 下部タグ参照パネルの高さ調整（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#history-061)へ移動した。

## 固定パネルの幅調整と保存（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#history-062)へ移動した。

## 画面背景色の保存と描画（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#history-063)へ移動した。

## 共有定義の使用先一覧と配置への移動（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#history-064)へ移動した。

## プロジェクト共有定義行の右クリック操作（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#history-065)へ移動した。

## プロジェクト画面行の右クリック操作（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#history-066)へ移動した。

## キャンバス・レイヤーの右クリック操作（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#history-067)へ移動した。

## ツールバー統合と薄いヘッダー（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#history-068)へ移動した。

## 部品パレットの右クリック操作（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#history-069)へ移動した。

## 共通編集操作のツールバー集約（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#history-070)へ移動した。

## 補助パネルの個別・一括表示切替（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#history-071)へ移動した。

## プロパティの分離・表示切替（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#history-072)へ移動した。

## 部品パレットの密度・表示形式・ドラッグ配置（2026-10-19・同日後続）

[この時点の実装・検証記録](implementation-history.md#history-073)へ移動した。

## 左3タブと部品分類の実装（2026-10-19）

[この時点の実装・検証記録](implementation-history.md#history-074)へ移動した。

## Designer メニューバーの実装（2026-10-18・統合設計採用後）

[この時点の実装・検証記録](implementation-history.md#history-075)へ移動した。

## 開発画面・監視部品・外部連携の統合（2026-10-18・同日後続）

[この時点の実装・検証記録](implementation-history.md#history-076)へ移動した。

## Designer UI の改訂提案（2026-10-18・同日後続）

[この時点の実装・検証記録](implementation-history.md#history-077)へ移動した。

## 機能優先とリリース前の形式変更（2026-10-18・初期方針）

[この時点の実装・検証記録](implementation-history.md#history-078)へ移動した。

## 最初の実装時点の機能（2026-10-18・履歴）

[この時点の実装・検証記録](implementation-history.md#history-080)へ移動した。

## 最小工程図の実装（2026-10-18）

[この時点の実装・検証記録](implementation-history.md#history-081)へ移動した。

## 編集履歴・配置操作（2026-10-18）

[この時点の実装・検証記録](implementation-history.md#history-082)へ移動した。

## 複数選択と整列（2026-10-18）

[この時点の実装・検証記録](implementation-history.md#history-083)へ移動した。

## グリッド / スナップ・頂点編集（2026-10-18）

[この時点の実装・検証記録](implementation-history.md#history-084)へ移動した。

## 参考画面から整理した対象（2026-10-18）

[この時点の実装・検証記録](implementation-history.md#history-085)へ移動した。

## Banto への統合（2026-10-18）

[この時点の実装・検証記録](implementation-history.md#history-086)へ移動した。

## 複数画面の管理（2026-10-18）

[この時点の実装・検証記録](implementation-history.md#history-087)へ移動した。

## 配置サイズの直接変更（2026-10-18）

[この時点の実装・検証記録](implementation-history.md#history-088)へ移動した。

## Symbol ライブラリ・定義編集（2026-10-18）

[この時点の実装・検証記録](implementation-history.md#history-089)へ移動した。

## 編集ワークスペース（2026-10-18）

[この時点の実装・検証記録](implementation-history.md#history-090)へ移動した。

## フロントエンド UX 設計（2026-10-18）

[この時点の実装・検証記録](implementation-history.md#history-091)へ移動した。

## 部品検索とパレットの分離（2026-10-18）

[この時点の実装・検証記録](implementation-history.md#history-092)へ移動した。

## キャンバスのズーム・パン（2026-10-18）

[この時点の実装・検証記録](implementation-history.md#history-093)へ移動した。

## 保存状態と未適用入力の保護（2026-10-18）

[この時点の実装・検証記録](implementation-history.md#history-094)へ移動した。

## 読み取りタグ割り当ての基礎（2026-10-18）

[この時点の実装・検証記録](implementation-history.md#history-095)へ移動した。

## Project 内タグ参照一覧（2026-10-18）

[この時点の実装・検証記録](implementation-history.md#history-096)へ移動した。

## SDK の読み取り投影境界（2026-10-18）

[この時点の実装・検証記録](implementation-history.md#history-097)へ移動した。

## 保存される画面順の並べ替え（2026-10-18）

[この時点の実装・検証記録](implementation-history.md#history-098)へ移動した。

## Symbol 配置の参照先変更と独立コピー（2026-10-18）

[この時点の実装・検証記録](implementation-history.md#history-099)へ移動した。

## 次の共有Symbol工程（2026-10-19）

[この時点の実装・検証記録](implementation-history.md#history-104)へ移動した。

## 次の図形スタイル工程（2026-10-19）

[この時点の実装・検証記録](implementation-history.md#history-105)へ移動した。

## 次の枠線スタイル工程（2026-10-19）

[この時点の実装・検証記録](implementation-history.md#history-106)へ移動した。

## 状態色の初期工程の完了（2026-10-20）

bool Textに続き、共有矩形／楕円の単色塗り・Polyline／矢印への状態色追従と参照保護を実装した。読取状態一覧を残し、色だけに状態判定を依存させない。[初期の提供範囲](state-color-following.md)を現在の実装とする。次は実catalog／Host接続の上流契約を再確認し、機器context付き共通画面・Faceplateへ進む。任意式・数値範囲・複数条件の状態規則は別途設計する。

## 機器の読取詳細の初期実装（2026-10-20）

共有SDK #682の対応を待つ間、保存形式を増やさない[機器の読取詳細](equipment-read-details.md)を先行する。機器の全採用slotを宣言順に表示し、既存画面小窓と同じstack・合計4件上限を共用する。正式Faceplateモデル・共通画面・遠隔操作は未導入。選択Symbolからの明示起動と、draft解決後の対象機器の再確認も実装した。実catalog／Hostは上流の最新契約確認後に接続する。

## 任意の機器種別の編集（2026-10-20）

既存EquipmentCommandに対応する[機器種別編集UI](equipment-type-editing.md)を接続した。種別名と任意のbool／number slotを一件単位で編集し、採用保護を維持する。機器割付との切替と構造draftを先に整え、新しいテンプレートや状態評価モデルは導入していない。続けて台帳の検索と20件ページ表示を実装した。使用先確認と実catalog／Hostの上流契約の確認を継続する。

## 機器の読取確認と図面の往復（2026-10-20）

読取詳細から全画面の機器使用先へ移動する入口を追加した。既存の使用先選択を共用し、非表示・ロックを維持し、幾何グループは一単位の選択とする。機器台帳検索の`adc1b08`は[全体CI](https://github.com/tyaro/temp-scada/actions/runs/39387797784)成功。正式Faceplate・型付き共通画面・実catalog／Hostは引き続き後続とする。

## 元機器から別機器を登録（2026-10-20）

Astraレビューの推薦に沿い、現行保存契約のまま独立した機器を作る入口を追加した。元種別・採用slotを引き継ぎ、外部名をnullへ戻して既存createコマンドで一括登録する。図形の複製は従来通り同じ機器を参照する。正式設備テンプレート・図面からの機器化・実catalog／Hostは後続。[詳細](equipment-register-design.md)。

## 関連付け候補の保存設定確認（2026-10-20）

Astraレビューの次候補として、Symbolが実際に使うslotと機器の保存設定を確認する読取表示を追加した。未適用の両選択候補へ追従し、hidden・未使用宣言とcatalog未確認を区別する。[範囲と実画面](symbol-equipment-check.md)。実catalog／Hostのindustrial #682は2026-10-20に再確認してOPEN、更新は2026-10-18のまま。共有購読のライフサイクルを独自実装せず、上流対応待ちを維持する。

## 図面と機器台帳の設定の往復（2026-10-20）

図面から関連機器の台帳へ移る明示的な入口を追加した。機器設定を選択配置のプロパティへ複製せず、既存台帳の編集へ集約する。読取詳細とは目的を分け、未適用入力と遅延focusの世代保護を維持する。[範囲](equipment-symbol-association.md)。図面からの機器化・正式テンプレート・Faceplateは後続とする。

## 機器操作のcontext入口（2026-10-20）

右クリックの既存選択メニューへ、単一Symbolからの台帳設定・読取詳細の入口を追加した。プロパティを隠した編集とレイヤーのキーボードメニューにも対応し、既存draft・対象再取得を共用する。共通操作をプロパティへ重複実装せず、メニュー生成の責務を維持する。

## 配置画像の表示方式（2026-10-20）

計画に残っていたcover／stretchを[配置Imageの独立設定](image-fit-design.md)として追加する。保存とminRuntimeVersionを0.28.0へ揃え、crop後の範囲を中央meet／slice／noneで枠へ写す。原本・配置枠・crop・回転・opacityを維持し、既存の原本付きpackage／clipboardを共用する。背景crop・ドラッグcrop・Symbol内画像は後続。機器context／Hostの上流待ちとは独立した工程とする。

## 背景画像の数値crop（2026-10-20）

[背景cropの独立設定](background-image-crop-design.md)を0.29.0へ追加する。切出し数値の意味検証と描画を配置Imageと共用し、背景のoriginalは切出し元画素サイズの中央配置とする。同hashの保持・別hashの解除・decode中のcrop／原本変更の永続失効を具体化した。配置Image・通常選択・clipboardは変更しない。ドラッグcrop・Symbol内画像・埋込Viewのclipboardは引き続き後続。

## 埋込Viewのclipboardの後続実装（2026-10-20）

[clipboard v4](screen-view-clipboard-design.md)を追加した。参照画面の共有とsnapshot import、必要Symbol／原本の閉包、ID再発行、同一編集世代の現行再利用、失敗時と切取の原子性を既存経路へ接続する。1段の埋込制約・機器関連付けを含むコピー拒否は維持し、正式Runtimeや機器context付き共通画面とは分離する。

## 標準の選択modifierの補完（2026-10-20）

Windows標準操作の補完として、Ctrl／Command＋クリックをキャンバス・レイヤーの追加／解除へ接続した。範囲選択の追加にも対応し、Shift操作・グループ単位・draft保護・Undoを維持する。関連ブラウザ14件で確認した。

## 2色放射グラデーションの後続実装（2026-10-20）

[2色放射gradient](radial-gradient-design.md)を0.30.0へ追加した。正規化中心／半径・両端のRGBとα・種類別draftを共有描画へ接続し、線形とpatternの既存操作を維持する。多点stop・独立焦点・図上ハンドル・枠線gradientは引き続き後続。

## レイヤーフォルダーの整理操作

同じ親内での一つ上・下への手動順変更を追加した。既存のorderを交換し、図面の重なり順や所属を変更しない。右クリックとShift＋F10、検索中と端の無効状態、未適用入力・Undoを確認する。位置指定ドラッグはこの工程と分ける。

## 機器metadata表示の先行工程

[機器情報Text](equipment-property-design.md)をProject0.31.0へ追加する。詳細提案§16.2／§17 C段階のうち、保存済み機器名・コード・種別名だけを共有Symbolへ投影する。定義例示・未関連状態・排他とコピー制約を明記し、現在Projectの台帳を表示元とする。正式Faceplate、機器context付きView、実catalog／Hostは引き続き後続。直前のフォルダー順変更`db4906b`は[全CI](https://github.com/tyaro/temp-scada/actions/runs/39406247823)成功。
