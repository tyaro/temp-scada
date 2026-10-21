# SCADA の独立開発と industrial への統合

状態: **現在の計画・統合方針**。2026-10-21（日本時間）更新。[文書索引](../README.md)、[実装状況](implementation-status.md)、[操作ガイド](../guides/user-guide.md)、[実装履歴](../history/implementation-history.md)を使い分ける。機能仕様の基準は[統合設計](../design/scada-integrated-design.md)。

## 次の実装順

[SCADA単体開発計画](upstream-independent-plan.md)のI0〜I4・I6は完了し、全体CIの成功を確認済み。I5は限定改善と候補評価までを完了した。大図面の読込・操作遅延は残課題であり、性能改善全体の完了とはしない。

| 区分                                | 現在の状態・次の判断                                                                       | 根拠                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| ローカル作図                        | 比率固定・兄弟内挿入・折返し・単色paintα一括編集を提供                                     | [I0〜I4](upstream-independent-plan.md#工程と保存区切り)                    |
| タグ参照名の置換                    | 全画面差分・入力保護・明示適用を提供。I6b CI成功                                           | [I6設計・実画面](../design/equipment/text-reference-replacement-design.md) |
| 大図面の性能                        | 限定改善を採用、I5d／I5e候補は未採用。遅延は残る                                           | [計測・採否](../performance/mixed-editor-quality.md)                       |
| 次のローカル機能                    | I7a〜c・I8a／bは全体CI成功。I8cのInspector接続・解除UIを実装・ローカル検証済み／CI確認待ち | [接続・配管追従の段階設計](../design/editor/connection-follow-design.md)   |
| 共通パネル・入力基盤                | Bantoの公開API・受入テスト・固定依存更新を確認して再計画                                   | [共通機能引渡し](../reviews/banto-contribution-handoff.md)                 |
| 実Hub／catalog・正式Faceplate・認証 | Industrialの契約変更中につき保留                                                           | [保留と再開条件](upstream-independent-plan.md#今は保留するもの)            |

次機能の候補調査は採用・着手完了を意味しない。新しい機能は詳細仕様→基盤→UI→受入の区切りで進める。

## Core v1と後続工程

S0／S1のDesign Domain・正式Project layout・型／参照整合性・revision／contentHashを固め、S2の編集を接続する。S3は共有SDKによる実Hub接続・Quality・再接続、S4は正式directory／ZIPとimport previewを整える。Equipment／Symbol・Tag Browser・基本Actionとmode分離を段階追加する。

**S9b（scada-server core＋host 1）はCore v1のserver基盤**。v1.1のAlarm・常時Event／Action・History／Trend・recorder・Windowsサービス化をその上に追加する。Design DomainはCore v1、Design APIのREST／OpenAPI公開は後続。現行のローカル読取プレビューを正式Runtimeの完成とはしない。

## 作成支援・プラント運用の追加検討（2026-10-20・日本時間）

[追加検討資料](../design/proposals/scada-authoring-plant-operations-proposal.md)と[機器作成の詳細提案](../design/proposals/equipment-authoring-detail-proposal.md)は、採用候補・未決事項・後続機能の根拠。文書の存在だけで実装済み・着手指示と扱わない。提供段階は統合設計、現在の機能は実装状況に従う。

## 参照元

- repository: https://github.com/tyaro/banto-industrial
- 固定commit: `c4a61bc08ddf6d03fa56974bf1fcad08d12cbb5a`
- [SCADA設計](../upstream/industrial/scada-design.md)、[上流索引](../upstream/industrial/README.md)、[Hub SDK](../upstream/industrial/banto-tagclient-design.md)、[実装時の注意](../upstream/industrial/implementation-checklist.md)

`docs/upstream/industrial`は出典付きの参照スナップショットであり編集しない。上流の「実装済み」はIndustrial側の状態。monorepoへ戻す配置方針を維持し、独立開発を一時的な例外とする。

## 外部の参考実装の取り扱い

`https://github.com/tyaro/ems-apps`は操作感・情報構成の参考に限り、画面・コード・画像等を取り込まない。SCADAはこの設計に沿って独立実装する。

## 共有部品の扱い

Banto v6.7.0を使い、汎用機能の共通化は上流へ還元する。SCADAはPLCへ直接接続せず、Hubを外部サービスとして利用する。ドライバ・式評価を複製しない。`banto-tagclient`は固定commit依存で利用済み。`banto-expr`は式機能を導入するときに動作確認済みcommitへ固定する。

認証はIndustrial側の修正中につき延期。ローカル編集はログイン不要。運用時のユーザー管理必須と、再起動後の読取監視の要望は[運用・ログイン方針](../design/runtime/access-policy.md)を維持する。リリース前の旧Project互換性を必須とせず、変更後のTS／Rust／schema／サンプル／検証を揃える。

## 戻す手順

- `apps/banto-scada`／`crates/scada-*`と固有サンプル・テストを元の配置へ移す。
- 共有crateの`git + rev`をIndustrial workspaceの`path`参照に変更する。SCADAの数値往復に必要なserde_jsonの`float_roundtrip`設定を保持する。
- frontend／Rust workspace・依存・lockfileを統合する。一時repoのルート設定で上流設定全体を置換しない。
- Industrialのpath-aware CI・frontend／E2E対象へSCADAを追加し、影響したHub・共有crateの回帰も確認する。
- 独立開発の決定と出典commit以降の上流差分をレビューして設計へ反映する。

## 過去のリンクからの案内

実施記録は[実装履歴](../history/implementation-history.md)へ集約した。以下は既存の外部リンク用の入口。新しいリンクは移動先を直接参照する。

<details>
<summary>従来の見出しと移動先</summary>

| 従来の項目                                                                                                                                                            | 移動先                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| <a id="現在の実装状況2026-10-20日本時間"></a><a id="implementation-status"></a>現在の実装状況（2026-10-20・日本時間）                                                 | [記録／現在情報](implementation-status.md)                                                  |
| <a id="配置画像トリミングの保存描画操作2026-10-20日本時間"></a><a id="image-crop-progress"></a>配置画像トリミングの保存・描画・操作（2026-10-20・日本時間）           | [記録／現在情報](../history/implementation-history.md#image-crop-progress)                  |
| <a id="配置画像トリミングの計算基盤2026-10-20日本時間"></a><a id="image-crop-foundation-progress"></a>配置画像トリミングの計算基盤（2026-10-20・日本時間）            | [記録／現在情報](../history/implementation-history.md#image-crop-foundation-progress)       |
| <a id="配置画像の差し替え2026-10-20日本時間"></a><a id="image-replacement-progress"></a>配置画像の差し替え（2026-10-20・日本時間）                                    | [記録／現在情報](../history/implementation-history.md#image-replacement-progress)           |
| <a id="ブラウザ全画面での表示確認2026-10-20日本時間"></a><a id="preview-fullscreen-progress"></a>ブラウザ全画面での表示確認（2026-10-20・日本時間）                   | [記録／現在情報](../history/implementation-history.md#preview-fullscreen-progress)          |
| <a id="プレビュー専用の画面内popup2026-10-20日本時間"></a><a id="preview-popup-progress"></a>プレビュー専用の画面内Popup（2026-10-20・日本時間）                      | [記録／現在情報](../history/implementation-history.md#preview-popup-progress)               |
| <a id="画面内popupの計算基礎2026-10-20日本時間"></a>画面内Popupの計算基礎（2026-10-20・日本時間）                                                                     | [記録／現在情報](../history/implementation-history.md#history-007)                          |
| <a id="別画面の埋込表示2026-10-20日本時間"></a><a id="screen-view-progress"></a>別画面の埋込表示（2026-10-20・日本時間）                                              | [記録／現在情報](../history/implementation-history.md#screen-view-progress)                 |
| <a id="埋込viewに向けた共通描画の分離2026-10-20日本時間"></a>埋込Viewに向けた共通描画の分離（2026-10-20・日本時間）                                                   | [記録／現在情報](../history/implementation-history.md#history-009)                          |
| <a id="埋込viewの参照計算基礎2026-10-20日本時間"></a><a id="screen-reference-foundation-progress"></a>埋込Viewの参照計算基礎（2026-10-20・日本時間）                  | [記録／現在情報](../history/implementation-history.md#screen-reference-foundation-progress) |
| <a id="繰返しパターンの編集保存2026-10-20日本時間"></a><a id="pattern-paint-progress"></a>繰返しパターンの編集・保存（2026-10-20・日本時間）                          | [記録／現在情報](../history/implementation-history.md#pattern-paint-progress)               |
| <a id="繰返しパターンのタイル計算2026-10-20日本時間"></a><a id="pattern-foundation-progress"></a>繰返しパターンのタイル計算（2026-10-20・日本時間）                   | [記録／現在情報](../history/implementation-history.md#pattern-foundation-progress)          |
| <a id="2色線形グラデーション2026-10-20日本時間"></a><a id="linear-gradient-progress"></a>2色線形グラデーション（2026-10-20・日本時間）                                | [記録／現在情報](../history/implementation-history.md#linear-gradient-progress)             |
| <a id="線形グラデーションの計算基礎2026-10-20日本時間"></a><a id="linear-gradient-foundation-progress"></a>線形グラデーションの計算基礎（2026-10-20・日本時間）       | [記録／現在情報](../history/implementation-history.md#linear-gradient-foundation-progress)  |
| <a id="原本を含む図形clipboard2026-10-20日本時間"></a><a id="asset-clipboard-progress"></a>原本を含む図形clipboard（2026-10-20・日本時間）                            | [記録／現在情報](../history/implementation-history.md#asset-clipboard-progress)             |
| <a id="os画像の貼り付け2026-10-20日本時間"></a><a id="image-paste-progress"></a>OS画像の貼り付け（2026-10-20・日本時間）                                              | [記録／現在情報](../history/implementation-history.md#image-paste-progress)                 |
| <a id="画面上のimage配置2026-10-20日本時間"></a><a id="image-placement-progress"></a>画面上のImage配置（2026-10-20・日本時間）                                        | [記録／現在情報](../history/implementation-history.md#image-placement-progress)             |
| <a id="背景画像と画像同梱の最小package2026-10-20日本時間"></a><a id="background-image-progress"></a>背景画像と画像同梱の最小package（2026-10-20・日本時間）           | [記録／現在情報](../history/implementation-history.md#background-image-progress)            |
| <a id="不変画像storeの基礎2026-10-20日本時間"></a><a id="image-assets-foundation-progress"></a>不変画像Storeの基礎（2026-10-20・日本時間）                            | [記録／現在情報](../history/implementation-history.md#image-assets-foundation-progress)     |
| <a id="単色と枠線のα2026-10-20日本時間"></a><a id="color-alpha-progress"></a>単色と枠線のα（2026-10-20・日本時間）                                                    | [記録／現在情報](../history/implementation-history.md#color-alpha-progress)                 |
| <a id="配置全体の不透明度2026-10-20日本時間"></a><a id="opacity-progress"></a>配置全体の不透明度（2026-10-20・日本時間）                                              | [記録／現在情報](../history/implementation-history.md#opacity-progress)                     |
| <a id="実線破線点線2026-10-20日本時間"></a><a id="line-style-progress"></a>実線・破線・点線（2026-10-20・日本時間）                                                   | [記録／現在情報](../history/implementation-history.md#line-style-progress)                  |
| <a id="追加要望の用語確認を反映2026-10-20日本時間"></a>追加要望の用語確認を反映（2026-10-20・日本時間）                                                               | [記録／現在情報](../history/implementation-history.md#history-023)                          |
| <a id="画像描画表現運用画面の追加検討2026-10-19同日後続"></a><a id="graphics-runtime-extension-review"></a>画像・描画表現・運用画面の追加検討（2026-10-19・同日後続） | [記録／現在情報](../history/implementation-history.md#graphics-runtime-extension-review)    |
| <a id="フォルダー自身のドラッグによる親変更2026-10-19同日後続"></a><a id="folder-drag-progress"></a>フォルダー自身のドラッグによる親変更（2026-10-19・同日後続）      | [記録／現在情報](../history/implementation-history.md#folder-drag-progress)                 |
| <a id="textの書式と枠内表示2026-10-19同日後続"></a><a id="text-style-progress"></a>Textの書式と枠内表示（2026-10-19・同日後続）                                       | [記録／現在情報](../history/implementation-history.md#text-style-progress)                  |
| <a id="編集途中の履歴変更に対する中断2026-10-19同日後続"></a><a id="interaction-snapshot-progress"></a>編集途中の履歴変更に対する中断（2026-10-19・同日後続）         | [記録／現在情報](../history/implementation-history.md#interaction-snapshot-progress)        |
| <a id="配置の回転2026-10-19同日後続"></a><a id="object-rotation-progress"></a>配置の回転（2026-10-19・同日後続）                                                      | [記録／現在情報](../history/implementation-history.md#object-rotation-progress)             |
| <a id="配置回転の計算基盤2026-10-19同日後続"></a><a id="rotation-foundation-progress"></a>配置回転の計算基盤（2026-10-19・同日後続）                                  | [記録／現在情報](../history/implementation-history.md#rotation-foundation-progress)         |
| <a id="レイヤー配置のドラッグによる所属変更2026-10-19同日後続"></a><a id="layer-drag-progress"></a>レイヤー配置のドラッグによる所属変更（2026-10-19・同日後続）       | [記録／現在情報](../history/implementation-history.md#layer-drag-progress)                  |
| <a id="選択範囲の表示2026-10-19同日後続"></a><a id="selection-view-progress"></a>選択範囲の表示（2026-10-19・同日後続）                                               | [記録／現在情報](../history/implementation-history.md#selection-view-progress)              |
| <a id="矩形楕円の枠線一括編集2026-10-19同日後続"></a><a id="selection-outline-progress"></a>矩形・楕円の枠線一括編集（2026-10-19・同日後続）                          | [記録／現在情報](../history/implementation-history.md#selection-outline-progress)           |
| <a id="矩形楕円の塗りと枠線2026-10-19同日後続"></a><a id="shape-paint-progress"></a>矩形・楕円の塗りと枠線（2026-10-19・同日後続）                                    | [記録／現在情報](../history/implementation-history.md#shape-paint-progress)                 |
| <a id="symbolの静的な配色2026-10-19同日後続"></a><a id="symbol-color-progress"></a>Symbolの静的な配色（2026-10-19・同日後続）                                         | [記録／現在情報](../history/implementation-history.md#symbol-color-progress)                |
| <a id="線配管の一括スタイル編集2026-10-19同日後続"></a><a id="selection-line-progress"></a>線・配管の一括スタイル編集（2026-10-19・同日後続）                         | [記録／現在情報](../history/implementation-history.md#selection-line-progress)              |
| <a id="レイヤーフォルダーの階層ui2026-10-19同日後続"></a><a id="layer-folder-ui-progress"></a>レイヤーフォルダーの階層UI（2026-10-19・同日後続）                      | [記録／現在情報](../history/implementation-history.md#layer-folder-ui-progress)             |
| <a id="レイヤーフォルダーの保存契約2026-10-19同日後続"></a><a id="layer-folder-model-progress"></a>レイヤーフォルダーの保存契約（2026-10-19・同日後続）               | [記録／現在情報](../history/implementation-history.md#layer-folder-model-progress)          |
| <a id="標準固定レイアウトへの復元2026-10-19同日後続"></a><a id="layout-reset-progress"></a>標準固定レイアウトへの復元（2026-10-19・同日後続）                         | [記録／現在情報](../history/implementation-history.md#layout-reset-progress)                |
| <a id="中心の等間隔配置2026-10-19同日後続"></a><a id="distribute-progress"></a>中心の等間隔配置（2026-10-19・同日後続）                                               | [記録／現在情報](../history/implementation-history.md#distribute-progress)                  |
| <a id="複数選択の色編集2026-10-19同日後続"></a><a id="selection-color-progress"></a>複数選択の色編集（2026-10-19・同日後続）                                          | [記録／現在情報](../history/implementation-history.md#selection-color-progress)             |
| <a id="project名とf2f12026-10-19同日後続"></a><a id="standard-names-progress"></a>Project名とF2／F1（2026-10-19・同日後続）                                           | [記録／現在情報](../history/implementation-history.md#standard-names-progress)              |
| <a id="静的な図面の表示切替2026-10-19同日後続"></a><a id="visibility-progress"></a>静的な図面の表示切替（2026-10-19・同日後続）                                       | [記録／現在情報](../history/implementation-history.md#visibility-progress)                  |
| <a id="配置の編集ロック2026-10-19同日後続"></a><a id="edit-lock-progress"></a>配置の編集ロック（2026-10-19・同日後続）                                                | [記録／現在情報](../history/implementation-history.md#edit-lock-progress)                   |
| <a id="配置名とレイヤー使用先検索2026-10-19同日後続"></a><a id="placement-name-progress"></a>配置名とレイヤー・使用先検索（2026-10-19・同日後続）                     | [記録／現在情報](../history/implementation-history.md#placement-name-progress)              |
| <a id="新しいprojectと標準ファイルキー2026-10-19同日後続"></a><a id="new-project-progress"></a>新しいProjectと標準ファイルキー（2026-10-19・同日後続）                | [記録／現在情報](../history/implementation-history.md#new-project-progress)                 |
| <a id="数値textへのサンプルタグ選択2026-10-19同日後続"></a><a id="tag-picker-progress"></a>数値Textへのサンプルタグ選択（2026-10-19・同日後続）                       | [記録／現在情報](../history/implementation-history.md#tag-picker-progress)                  |
| <a id="選択配置の方向キー移動2026-10-19同日後続"></a>選択配置の方向キー移動（2026-10-19・同日後続）                                                                   | [記録／現在情報](../history/implementation-history.md#history-047)                          |
| <a id="図面の原点倍率に追従するルーラー2026-10-19同日後続"></a><a id="rulers-progress"></a>図面の原点・倍率に追従するルーラー（2026-10-19・同日後続）                 | [記録／現在情報](../history/implementation-history.md#rulers-progress)                      |
| <a id="osクリップボードとdeleteによる編集2026-10-19同日後続"></a>OSクリップボードとDeleteによる編集（2026-10-19・同日後続）                                           | [記録／現在情報](../history/implementation-history.md#history-049)                          |
| <a id="windows標準に合わせたホイール操作2026-10-19同日後続"></a>Windows標準に合わせたホイール操作（2026-10-19・同日後続）                                             | [記録／現在情報](../history/implementation-history.md#history-050)                          |
| <a id="空白ドラッグによる範囲選択2026-10-19同日後続"></a><a id="range-selection-progress"></a>空白ドラッグによる範囲選択（2026-10-19・同日後続）                      | [記録／現在情報](../history/implementation-history.md#range-selection-progress)             |
| <a id="projectファイル操作をメニューへ集約2026-10-19同日後続"></a>Projectファイル操作をメニューへ集約（2026-10-19・同日後続）                                         | [記録／現在情報](../history/implementation-history.md#history-052)                          |
| <a id="工程図のミニマップ2026-10-19同日後続"></a><a id="minimap-progress"></a>工程図のミニマップ（2026-10-19・同日後続）                                              | [記録／現在情報](../history/implementation-history.md#minimap-progress)                     |
| <a id="クリック位置への連続配置2026-10-19同日後続"></a><a id="continuous-placement-progress"></a>クリック位置への連続配置（2026-10-19・同日後続）                     | [記録／現在情報](../history/implementation-history.md#continuous-placement-progress)        |
| <a id="お気に入り部品ドック2026-10-19同日後続"></a><a id="favorites-progress"></a>お気に入り部品ドック（2026-10-19・同日後続）                                        | [記録／現在情報](../history/implementation-history.md#favorites-progress)                   |
| <a id="操作試作を基準にした-studio-外観の適用2026-10-19同日後続"></a>操作試作を基準にした Studio 外観の適用（2026-10-19・同日後続）                                   | [記録／現在情報](../history/implementation-history.md#history-056)                          |
| <a id="ツリー行をフラットなデザインへ調整2026-10-19同日後続"></a>ツリー行をフラットなデザインへ調整（2026-10-19・同日後続）                                           | [記録／現在情報](../history/implementation-history.md#history-057)                          |
| <a id="プロジェクトレイヤーのツリー表示2026-10-19同日後続"></a>プロジェクト・レイヤーのツリー表示（2026-10-19・同日後続）                                             | [記録／現在情報](../history/implementation-history.md#history-058)                          |
| <a id="プロパティ数値のenterフォーカス移動での確定2026-10-19同日後続"></a>プロパティ数値のEnter／フォーカス移動での確定（2026-10-19・同日後続）                       | [記録／現在情報](../history/implementation-history.md#history-059)                          |
| <a id="サイドチャットの操作試作レビュー2026-10-19同日後続"></a>サイドチャットの操作試作レビュー（2026-10-19・同日後続）                                               | [記録／現在情報](../history/implementation-history.md#history-060)                          |
| <a id="下部タグ参照パネルの高さ調整2026-10-19同日後続"></a>下部タグ参照パネルの高さ調整（2026-10-19・同日後続）                                                       | [記録／現在情報](../history/implementation-history.md#history-061)                          |
| <a id="固定パネルの幅調整と保存2026-10-19同日後続"></a>固定パネルの幅調整と保存（2026-10-19・同日後続）                                                               | [記録／現在情報](../history/implementation-history.md#history-062)                          |
| <a id="画面背景色の保存と描画2026-10-19同日後続"></a>画面背景色の保存と描画（2026-10-19・同日後続）                                                                   | [記録／現在情報](../history/implementation-history.md#history-063)                          |
| <a id="共有定義の使用先一覧と配置への移動2026-10-19同日後続"></a>共有定義の使用先一覧と配置への移動（2026-10-19・同日後続）                                           | [記録／現在情報](../history/implementation-history.md#history-064)                          |
| <a id="プロジェクト共有定義行の右クリック操作2026-10-19同日後続"></a>プロジェクト共有定義行の右クリック操作（2026-10-19・同日後続）                                   | [記録／現在情報](../history/implementation-history.md#history-065)                          |
| <a id="プロジェクト画面行の右クリック操作2026-10-19同日後続"></a>プロジェクト画面行の右クリック操作（2026-10-19・同日後続）                                           | [記録／現在情報](../history/implementation-history.md#history-066)                          |
| <a id="キャンバスレイヤーの右クリック操作2026-10-19同日後続"></a>キャンバス・レイヤーの右クリック操作（2026-10-19・同日後続）                                         | [記録／現在情報](../history/implementation-history.md#history-067)                          |
| <a id="ツールバー統合と薄いヘッダー2026-10-19同日後続"></a>ツールバー統合と薄いヘッダー（2026-10-19・同日後続）                                                       | [記録／現在情報](../history/implementation-history.md#history-068)                          |
| <a id="部品パレットの右クリック操作2026-10-19同日後続"></a>部品パレットの右クリック操作（2026-10-19・同日後続）                                                       | [記録／現在情報](../history/implementation-history.md#history-069)                          |
| <a id="共通編集操作のツールバー集約2026-10-19同日後続"></a>共通編集操作のツールバー集約（2026-10-19・同日後続）                                                       | [記録／現在情報](../history/implementation-history.md#history-070)                          |
| <a id="補助パネルの個別一括表示切替2026-10-19同日後続"></a>補助パネルの個別・一括表示切替（2026-10-19・同日後続）                                                     | [記録／現在情報](../history/implementation-history.md#history-071)                          |
| <a id="プロパティの分離表示切替2026-10-19同日後続"></a>プロパティの分離・表示切替（2026-10-19・同日後続）                                                             | [記録／現在情報](../history/implementation-history.md#history-072)                          |
| <a id="部品パレットの密度表示形式ドラッグ配置2026-10-19同日後続"></a>部品パレットの密度・表示形式・ドラッグ配置（2026-10-19・同日後続）                               | [記録／現在情報](../history/implementation-history.md#history-073)                          |
| <a id="左3タブと部品分類の実装2026-10-19"></a>左3タブと部品分類の実装（2026-10-19）                                                                                   | [記録／現在情報](../history/implementation-history.md#history-074)                          |
| <a id="designer-メニューバーの実装2026-10-18統合設計採用後"></a>Designer メニューバーの実装（2026-10-18・統合設計採用後）                                             | [記録／現在情報](../history/implementation-history.md#history-075)                          |
| <a id="開発画面監視部品外部連携の統合2026-10-18同日後続"></a>開発画面・監視部品・外部連携の統合（2026-10-18・同日後続）                                               | [記録／現在情報](../history/implementation-history.md#history-076)                          |
| <a id="designer-ui-の改訂提案2026-10-18同日後続"></a>Designer UI の改訂提案（2026-10-18・同日後続）                                                                   | [記録／現在情報](../history/implementation-history.md#history-077)                          |
| <a id="機能優先とリリース前の形式変更2026-10-18初期方針"></a>機能優先とリリース前の形式変更（2026-10-18・初期方針）                                                   | [記録／現在情報](../history/implementation-history.md#history-078)                          |
| <a id="最初の実装時点の機能2026-10-18履歴"></a>最初の実装時点の機能（2026-10-18・履歴）                                                                               | [記録／現在情報](../history/implementation-history.md#history-080)                          |
| <a id="最小工程図の実装2026-10-18"></a>最小工程図の実装（2026-10-18）                                                                                                 | [記録／現在情報](../history/implementation-history.md#history-081)                          |
| <a id="編集履歴配置操作2026-10-18"></a>編集履歴・配置操作（2026-10-18）                                                                                               | [記録／現在情報](../history/implementation-history.md#history-082)                          |
| <a id="複数選択と整列2026-10-18"></a>複数選択と整列（2026-10-18）                                                                                                     | [記録／現在情報](../history/implementation-history.md#history-083)                          |
| <a id="グリッド--スナップ頂点編集2026-10-18"></a>グリッド / スナップ・頂点編集（2026-10-18）                                                                          | [記録／現在情報](../history/implementation-history.md#history-084)                          |
| <a id="参考画面から整理した対象2026-10-18"></a>参考画面から整理した対象（2026-10-18）                                                                                 | [記録／現在情報](../history/implementation-history.md#history-085)                          |
| <a id="banto-への統合2026-10-18"></a>Banto への統合（2026-10-18）                                                                                                     | [記録／現在情報](../history/implementation-history.md#history-086)                          |
| <a id="複数画面の管理2026-10-18"></a>複数画面の管理（2026-10-18）                                                                                                     | [記録／現在情報](../history/implementation-history.md#history-087)                          |
| <a id="配置サイズの直接変更2026-10-18"></a>配置サイズの直接変更（2026-10-18）                                                                                         | [記録／現在情報](../history/implementation-history.md#history-088)                          |
| <a id="symbol-ライブラリ定義編集2026-10-18"></a>Symbol ライブラリ・定義編集（2026-10-18）                                                                             | [記録／現在情報](../history/implementation-history.md#history-089)                          |
| <a id="編集ワークスペース2026-10-18"></a>編集ワークスペース（2026-10-18）                                                                                             | [記録／現在情報](../history/implementation-history.md#history-090)                          |
| <a id="フロントエンド-ux-設計2026-10-18"></a>フロントエンド UX 設計（2026-10-18）                                                                                     | [記録／現在情報](../history/implementation-history.md#history-091)                          |
| <a id="部品検索とパレットの分離2026-10-18"></a>部品検索とパレットの分離（2026-10-18）                                                                                 | [記録／現在情報](../history/implementation-history.md#history-092)                          |
| <a id="キャンバスのズームパン2026-10-18"></a>キャンバスのズーム・パン（2026-10-18）                                                                                   | [記録／現在情報](../history/implementation-history.md#history-093)                          |
| <a id="保存状態と未適用入力の保護2026-10-18"></a>保存状態と未適用入力の保護（2026-10-18）                                                                             | [記録／現在情報](../history/implementation-history.md#history-094)                          |
| <a id="読み取りタグ割り当ての基礎2026-10-18"></a>読み取りタグ割り当ての基礎（2026-10-18）                                                                             | [記録／現在情報](../history/implementation-history.md#history-095)                          |
| <a id="project-内タグ参照一覧2026-10-18"></a>Project 内タグ参照一覧（2026-10-18）                                                                                     | [記録／現在情報](../history/implementation-history.md#history-096)                          |
| <a id="sdk-の読み取り投影境界2026-10-18"></a>SDK の読み取り投影境界（2026-10-18）                                                                                     | [記録／現在情報](../history/implementation-history.md#history-097)                          |
| <a id="保存される画面順の並べ替え2026-10-18"></a>保存される画面順の並べ替え（2026-10-18）                                                                             | [記録／現在情報](../history/implementation-history.md#history-098)                          |
| <a id="symbol-配置の参照先変更と独立コピー2026-10-18"></a>Symbol 配置の参照先変更と独立コピー（2026-10-18）                                                           | [記録／現在情報](../history/implementation-history.md#history-099)                          |
| <a id="次の共有symbol工程2026-10-19"></a>次の共有Symbol工程（2026-10-19）                                                                                             | [記録／現在情報](../history/implementation-history.md#history-104)                          |
| <a id="次の図形スタイル工程2026-10-19"></a>次の図形スタイル工程（2026-10-19）                                                                                         | [記録／現在情報](../history/implementation-history.md#history-105)                          |
| <a id="次の枠線スタイル工程2026-10-19"></a>次の枠線スタイル工程（2026-10-19）                                                                                         | [記録／現在情報](../history/implementation-history.md#history-106)                          |
| <a id="状態色の初期工程の完了2026-10-20"></a>状態色の初期工程の完了（2026-10-20）                                                                                     | [記録／現在情報](../history/implementation-history.md#plan-note-01)                         |
| <a id="機器の読取詳細の初期実装2026-10-20"></a>機器の読取詳細の初期実装（2026-10-20）                                                                                 | [記録／現在情報](../history/implementation-history.md#plan-note-02)                         |
| <a id="任意の機器種別の編集2026-10-20"></a>任意の機器種別の編集（2026-10-20）                                                                                         | [記録／現在情報](../history/implementation-history.md#plan-note-03)                         |
| <a id="機器の読取確認と図面の往復2026-10-20"></a>機器の読取確認と図面の往復（2026-10-20）                                                                             | [記録／現在情報](../history/implementation-history.md#plan-note-04)                         |
| <a id="元機器から別機器を登録2026-10-20"></a>元機器から別機器を登録（2026-10-20）                                                                                     | [記録／現在情報](../history/implementation-history.md#plan-note-05)                         |
| <a id="関連付け候補の保存設定確認2026-10-20"></a>関連付け候補の保存設定確認（2026-10-20）                                                                             | [記録／現在情報](../history/implementation-history.md#plan-note-06)                         |
| <a id="図面と機器台帳の設定の往復2026-10-20"></a>図面と機器台帳の設定の往復（2026-10-20）                                                                             | [記録／現在情報](../history/implementation-history.md#plan-note-07)                         |
| <a id="機器操作のcontext入口2026-10-20"></a>機器操作のcontext入口（2026-10-20）                                                                                       | [記録／現在情報](../history/implementation-history.md#plan-note-08)                         |
| <a id="配置画像の表示方式2026-10-20"></a>配置画像の表示方式（2026-10-20）                                                                                             | [記録／現在情報](../history/implementation-history.md#plan-note-09)                         |
| <a id="背景画像の数値crop2026-10-20"></a>背景画像の数値crop（2026-10-20）                                                                                             | [記録／現在情報](../history/implementation-history.md#plan-note-10)                         |
| <a id="埋込viewのclipboardの後続実装2026-10-20"></a>埋込Viewのclipboardの後続実装（2026-10-20）                                                                       | [記録／現在情報](../history/implementation-history.md#plan-note-11)                         |
| <a id="標準の選択modifierの補完2026-10-20"></a>標準の選択modifierの補完（2026-10-20）                                                                                 | [記録／現在情報](../history/implementation-history.md#plan-note-12)                         |
| <a id="2色放射グラデーションの後続実装2026-10-20"></a>2色放射グラデーションの後続実装（2026-10-20）                                                                   | [記録／現在情報](../history/implementation-history.md#plan-note-13)                         |
| <a id="レイヤーフォルダーの整理操作"></a>レイヤーフォルダーの整理操作                                                                                                 | [記録／現在情報](../history/implementation-history.md#plan-note-14)                         |
| <a id="機器metadata表示の先行工程"></a>機器metadata表示の先行工程                                                                                                     | [記録／現在情報](../history/implementation-history.md#plan-note-15)                         |
| <a id="隙間の均等化"></a>隙間の均等化                                                                                                                                 | [記録／現在情報](../history/implementation-history.md#plan-note-16)                         |
| <a id="配列複製の先行工程"></a>配列複製の先行工程                                                                                                                     | [記録／現在情報](../history/implementation-history.md#plan-note-17)                         |
| <a id="直近の保存区切り"></a>直近の保存区切り                                                                                                                         | [記録／現在情報](../history/implementation-history.md#plan-note-18)                         |
| <a id="bantoパネル基盤との比較評価2026-10-21"></a>Bantoパネル基盤との比較評価（2026-10-21）                                                                           | [記録／現在情報](../history/implementation-history.md#plan-note-19)                         |
| <a id="bantoへの追加還元2026-10-21"></a>Bantoへの追加還元（2026-10-21）                                                                                               | [記録／現在情報](../history/implementation-history.md#plan-note-20)                         |
| <a id="i1画像cropの比率固定2026-10-21"></a>I1：画像cropの比率固定（2026-10-21）                                                                                       | [記録／現在情報](../history/implementation-history.md#plan-note-21)                         |
| <a id="i2レイヤーの兄弟内挿入2026-10-21"></a>I2：レイヤーの兄弟内挿入（2026-10-21）                                                                                   | [記録／現在情報](../history/implementation-history.md#plan-note-22)                         |
| <a id="i3静的textの折返し2026-10-21"></a>I3：静的Textの折返し（2026-10-21）                                                                                           | [記録／現在情報](../history/implementation-history.md#plan-note-23)                         |
| <a id="i4単色塗り枠線α一括編集2026-10-21"></a>I4：単色塗り・枠線α一括編集（2026-10-21）                                                                               | [記録／現在情報](../history/implementation-history.md#plan-note-24)                         |
| <a id="i5初回混在図面の計測読込改善2026-10-21"></a>I5初回：混在図面の計測・読込改善（2026-10-21）                                                                     | [記録／現在情報](../history/implementation-history.md#plan-note-25)                         |
| <a id="次工程i62026-10-21"></a>次工程I6（2026-10-21）                                                                                                                 | [記録／現在情報](../history/implementation-history.md#plan-note-26)                         |

| <a id="i5b進捗履歴復元の重複検証2026-10-21"></a>I5b進捗：履歴復元の重複検証（2026-10-21） | [当時の記録](../history/implementation-history.md#i5b進捗履歴復元の重複検証2026-10-21) |
| <a id="i5c進捗project-snapshotの監視境界2026-10-21"></a>I5c進捗：Project snapshotの監視境界（2026-10-21） | [当時の記録](../history/implementation-history.md#i5c進捗project-snapshotの監視境界2026-10-21) |
| <a id="i5d進捗単一行text計測の切分けと候補評価2026-10-21"></a>I5d進捗：単一行Text計測の切分けと候補評価（2026-10-21） | [当時の記録](../history/implementation-history.md#i5d進捗単一行text計測の切分けと候補評価2026-10-21) |

</details>
