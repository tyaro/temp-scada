# SCADAからBantoへの共通機能引渡し

2026-10-21（日本時間）。状態: **上流Issue起票・資産引渡し済み、共通化実装・採用は未完了**。既存の[パネル基盤比較](banto-dock-comparison.md)に加え、汎用化の候補と受入資産を記録する。

## 今回の4件

| Issue                                                                            | 目的・既存機構との関係                                                                                                                   | 渡したSCADA資産                                                                                   |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [#435 操作定義・ショートカット](https://github.com/tyaro/banto/issues/435)       | 既存PaletteCommand/searchCommandsに接続し、メニュー・toolbar・context・キーの実行／可否と入力欄・IME保護を共通化。優先度: 高             | `designer-actions.ts`、Appのshortcut、menubar／selection-context／clipboard／save-stateのE2E      |
| [#436 非同期要求の失効と資源解放](https://github.com/tyaro/banto/issues/436)     | request・owner寿命・対象epochから古い結果を不採用にする小さい共通契約。既存認証のrevisionやformsの遅延navigate対策と重複整理。優先度: 高 | image-import／project-files／clipboard controller、遅延画像差替え・非同期cutのE2E、AssetStore単体 |
| [#437 UI設定の保存状態](https://github.com/tyaro/banto/issues/437)               | UiSettingsProviderの上でcurrent／saved／saving／errorを管理。成功した送信snapshotだけを保存済みにする。優先度: 中                        | banto/setup.ts、floating controller、左右浮動の保存失敗・破損値・独立slotのE2E、配置検証単体      |
| [#438 ブラウザ画像の取込・原本・寿命](https://github.com/tyaro/banto/issues/438) | 形式・寸法検査、原本bytes／alpha、hash、Object URLとpin/releaseを抽出。既存添付処理との境界を確認。優先度: 中                            | image-assets.tsと単体、実decode／透過／URL寿命のE2E、画像差替えcontrollerとE2E                    |

各Issueには出典コミット`21ded7415178a763a34ef3897635be224dea71ac`の実装・テストへの固定リンク、受入候補、対象外、既存APIとの関係を記載した。上流修正後も元の資産を参照できる。起票前のBanto mainは`edecb214c87d9690e6e9933b073354ce84e3bc1b`で、比較基準591294…からadmin-coreの該当APIに変更がないことを確認した。

## 引渡しの方法

1. 既存SCADA実装とテストを読んで、Bantoの既存APIと責務を照合する。SCADAのcontrollerを丸ごと複製することは完了条件にしない。
2. Project・画面／機器の意味・Undo・保存形式をcallbackやconsumerへ残し、汎用処理と最小fixtureをBanto自身の単体／ブラウザテストへ抽出する。Bantoからtemp-scadaへの実行時依存は作らない。
3. 上流で公開API・回帰を確定した後、SCADAは固定コミット依存を更新して接続する。既存の入力保護・資源解放・失敗時保持のE2Eを通してから局所実装を外す。

#435の操作定義は現在のbuilderから抽出が必要で、汎用registryが完成しているという意味ではない。#436の失効は完了済みOS clipboard書込を巻き戻す機能ではなく、古い結果による削除・適用を防ぐ。#437の並行保存・全providerの検証と、#438の利用側別上限は上流で追加設計・試験が必要。既存テストのリンクを渡すことと、汎用化後の全consumer検証完了を区別する。

## 関連する起票済み事項

- [#432 入力保持とpane切替前guard](https://github.com/tyaro/banto/issues/432): formsとdock lifecycle。#436の非同期primitiveと連携する。
- [#433 gestureの所有者・取消](https://github.com/tyaro/banto/issues/433): 移動／resize／divider。#435のキーscopeと整合させる。
- [#434 layout検証・到達性](https://github.com/tyaro/banto/issues/434): #437はその永続化consumerを支援し、幾何検証は重複させない。
- [#427 メニューの可用高・内部scroll](https://github.com/tyaro/banto/issues/427): **Closed**。[PR #430](https://github.com/tyaro/banto/pull/430)が2026-10-21 00:46（日本時間）にmergeされた。新規Issueは重ねない。SCADAの固定依存更新と暫定adapter撤去は未実施。[局所対応の仕様](../design/editor/designer-menu-viewport.md)と`e2e/menu-viewport.spec.ts`を、上流接続時の受入に使う。今回、修正後BantoをSCADAへ接続しての動作検証はしていない。

パネルの[10ケース再現fixture](banto-dock-fixture/README.md)も引き続き利用できる。今回はIssue・文書の引渡しのみで、アプリ・依存・Project形式は変更していない。検証は出典ファイルとリンク、Issue本文の確認・整形であり、上記の全体テストを再実行した記録ではない。
