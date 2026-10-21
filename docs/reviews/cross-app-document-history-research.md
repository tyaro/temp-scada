# 保存・参照検証・編集履歴の横断調査

2026-10-21。状態: **静的調査済み。Industrialの横断設計Issue [#762](https://github.com/tyaro/banto-industrial/issues/762)を起票。実装・Bantoへの個別提案・consumer移行は未着手**。

## 結論

Project保存形式・参照整合性・command／Undo／Redo・履歴資産索引を、すべてSCADA専用として対象外にするのは広すぎる。**アプリ固有のモデルと、再利用できる処理・受入契約を分ける**。

最初の候補は取込前検証・差分計画と、ローカル下書きの編集履歴。ただし、3製品共通のProject形式や実行副作用まで含むUndo engineを作る根拠はない。履歴資産索引は技術的に抽出できるが、現在確認できた画像資産のconsumerはSCADAだけである。

## 対象と調査範囲

- SCADA: `be70305`（直近のアプリ変更は`01d5df0`）。
- Industrial: `46c283d88723f788e4646333f65b6ed78e2a3e9d`。ユーザー呼称「ChronoGather」に対応すると考えられる記録計は、同repoでは **ChronoGazer**、`apps/chronogazer`という名前。別製品を指す場合は追加調査が必要。
- Banto: `ac571ebffa76db61e28230a7138223f069eee067`。IndustrialのBanto Rust依存はv6.7.0。mainの公開APIとconsumer固定版の採用状況は分ける。
- 上記commitのソース・コメント・試験コードを確認した。アプリ実行、実機／DB操作、上流テストの再実行はしていない。語句検索で見つからないことだけを「存在しない」の証明にしない。

## 実装比較

| 観点     | SCADA                                                           | Banto-hub                                                          | ChronoGazer                                                                                  |
| -------- | --------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| 保存単位 | Project JSON、画像付きは独自profileのZIP                        | DB上の構成と、秘密を除外した構成JSON package v2                    | SQLiteの設定・表示group。DB backup／次回起動時restore                                        |
| 参照     | UUIDの画面・Symbol・画像・接続などを候補Project全体で検証       | 接続／group／tagの複合名でpackage検証し、取込先IDへ再解決          | 表示groupのpen→tag存在確認、使用中tagの削除拒否                                              |
| 編集履歴 | JSON snapshotのpast／future、上限50、復元時検証、revisionは前進 | tag削除の取消は送信前の遅延実行。適用済み設定は別のruntime反映経路 | group編集は下書き→明示保存、expectedRevision競合検出。調査した画面に複数段Undoは見当たらない |
| 資産保持 | 現在＋past＋futureの画像hash、export pin、URL寿命               | 調査した構成packageには画像原本やUndo資産集合なし                  | 調査したgroup・backup経路には画像原本やUndo資産集合なし                                      |

### SCADAの根拠

- [履歴本体](https://github.com/tyaro/temp-scada/blob/be70305/apps/banto-scada/src/lib/history.ts)と[履歴試験](https://github.com/tyaro/temp-scada/blob/be70305/apps/banto-scada/src/lib/history.test.ts)。無効／同値commandは履歴を増やさず、新規編集でRedoを破棄。別Projectの復元を拒否する。
- [履歴資産索引](https://github.com/tyaro/temp-scada/blob/be70305/apps/banto-scada/src/lib/history-assets.ts)と[7ケースの試験](https://github.com/tyaro/temp-scada/blob/be70305/apps/banto-scada/src/lib/history-assets.test.ts)。現在保持するsnapshotだけを索引し、抽出失敗時は回収・索引更新をしない。検証cacheではない。
- [Project package](https://github.com/tyaro/temp-scada/blob/be70305/apps/banto-scada/src/lib/project-package.ts)と[ファイルcontroller](https://github.com/tyaro/temp-scada/blob/be70305/apps/banto-scada/src/lib/designer/controllers/project-files.svelte.ts)。ZIP entry／展開予算／hash照合、export中のpinを提供。保存はBlobダウンロード開始であり、OSの一時file＋renameによる原子的保存や保存先への永続化確認は実装していない。

### Banto-hubの根拠

- [configPackage.ts](https://github.com/tyaro/banto-industrial/blob/46c283d88723f788e4646333f65b6ed78e2a3e9d/apps/banto-hub/src/lib/banto/configPackage.ts)：schemaVersion／product確認、秘密情報の除外、接続・group・tagの一意性と参照検証、`planByKey`／`planByName`。[回帰試験](https://github.com/tyaro/banto-industrial/blob/46c283d88723f788e4646333f65b6ed78e2a3e9d/apps/banto-hub/src/lib/banto/configPackage.test.ts)に版拒否・複合名・秘密除外のケースがある。
- [configPackageAdmin.ts](https://github.com/tyaro/banto-industrial/blob/46c283d88723f788e4646333f65b6ed78e2a3e9d/apps/banto-hub/src/lib/banto/configPackageAdmin.ts)：inspectとapplyを分離し、DB接続をbridgeより先に取込み、名前を現環境IDへ付け直す。複数CRUDを順に呼ぶため、取込全体の原子的transaction／rollbackとは扱わない。収集開始が競合した場合の中断を[試験](https://github.com/tyaro/banto-industrial/blob/46c283d88723f788e4646333f65b6ed78e2a3e9d/apps/banto-hub/src/lib/banto/configPackageAdmin.test.ts)で扱う。
- [DeferredDeleteCore](https://github.com/tyaro/banto-industrial/blob/46c283d88723f788e4646333f65b6ed78e2a3e9d/apps/banto-hub/src/lib/banto/deferredDeleteCore.ts)：tagを削除して再作成するとIDと過去の収集履歴の対応が失われるため、取消可能な間は削除を送信しない。`undo()`は遅延中の取消であり、送信済み削除の復元ではない。[試験](https://github.com/tyaro/banto-industrial/blob/46c283d88723f788e4646333f65b6ed78e2a3e9d/apps/banto-hub/src/lib/banto/deferredDelete.test.ts)も還元候補。
- [catalog commitとruntime適用](https://github.com/tyaro/banto-industrial/blob/46c283d88723f788e4646333f65b6ed78e2a3e9d/apps/banto-hub/core/src/rest/crud.rs)：DB commit後に実行構成への適用が失敗する状態を区別し、再適用を案内する。この境界をローカルUndoで巻き戻せると仮定しない。

### ChronoGazerと既存共通基盤の根拠

- [group下書き](<https://github.com/tyaro/banto-industrial/blob/46c283d88723f788e4646333f65b6ed78e2a3e9d/apps/chronogazer/src/routes/(app)/groups/groupsPageLogic.ts>)と[編集画面](<https://github.com/tyaro/banto-industrial/blob/46c283d88723f788e4646333f65b6ed78e2a3e9d/apps/chronogazer/src/routes/(app)/groups/+page.svelte>)：未選択tagを含む下書きと保存payloadを分離、未保存入力保護、expectedRevision付き保存。ローカルUndoを足す余地はあるが、現行の保存成功・競合処理を置き換えるものではない。
- [display_groups.rs](https://github.com/tyaro/banto-industrial/blob/46c283d88723f788e4646333f65b6ed78e2a3e9d/apps/chronogazer/core/src/display_groups.rs)：唯一のserver検証関数で形・tag存在を確認。作成／更新は`BEGIN IMMEDIATE`と楽観ロック、使用中tagの確認と削除も同じtransactionで行う。ブラウザの事前検証だけには移さない。
- [settings.rs](https://github.com/tyaro/banto-industrial/blob/46c283d88723f788e4646333f65b6ed78e2a3e9d/apps/chronogazer/core/src/settings.rs)は既存`banto_admin_services::settings`を再公開する型付きconsumer。[lib.rs](https://github.com/tyaro/banto-industrial/blob/46c283d88723f788e4646333f65b6ed78e2a3e9d/apps/chronogazer/core/src/lib.rs)もBantoのbackupを再公開し、[backupsAdmin.ts](https://github.com/tyaro/banto-industrial/blob/46c283d88723f788e4646333f65b6ed78e2a3e9d/apps/chronogazer/src/lib/banto/backupsAdmin.ts)がTauri／RESTを使い分ける。[DB復元往復試験](https://github.com/tyaro/banto-industrial/blob/46c283d88723f788e4646333f65b6ed78e2a3e9d/apps/chronogazer/core/src/db.rs)もある。新しい共通backup実装をSCADAから重ねる必要はない。
- Bantoの[BackupService](https://github.com/tyaro/banto/blob/ac571ebffa76db61e28230a7138223f069eee067/crates/banto-admin-services/src/backup.rs)は`VACUUM INTO`、DB fileごとのbackup、integrityと基礎table確認、次回起動時restoreを提供。SCADAのProject参照検証や、製品固有の全schema互換性を保証する機能ではない。
- Industrialの[banto-collect config](https://github.com/tyaro/banto-industrial/blob/46c283d88723f788e4646333f65b6ed78e2a3e9d/crates/banto-collect/src/config.rs)は既に複数consumerの共有領域。厳格な構成検証と除外付き起動を区別しており、PLC／Hub固有の制約をBantoの汎用UIへ押し込まない。ChronoGazerの[collect/history](https://github.com/tyaro/banto-industrial/blob/46c283d88723f788e4646333f65b6ed78e2a3e9d/apps/chronogazer/core/src/collect/history.rs)は時系列測定値の読出しであり、編集Undo履歴ではない。

## 共通化の候補と境界

| 候補                 | 再利用する契約                                                                           | 残す責務／前提                                                                                   | 工数・優先度の判断                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| 取込前検証と差分計画 | parse→形検証→参照検証→既存との比較→明示適用という手順、key別create／update計画、診断位置 | parser、identity key、秘密除外、現環境の参照解決、適用順、DB transactionはconsumer               | 最初に照合。HubとSCADAに具体例あり。小さな純関数・recipeからなら比較的限定的        |
| ローカル編集履歴     | owner別past／future、成功のみ記録、no-op、Redo破棄、上限、候補復元の失敗時保持           | snapshot codec、候補検証、revision、Undo対象はconsumer。server保存後の履歴継続／破棄も明示       | 中。SCADAとChronoGazerのgroup下書きで最小fixtureを作る。ChronoGazerへの採用は別判断 |
| 参照診断             | consumerが列挙したnode／edgeから未解決参照と使用先を報告、診断の共通shape                | 許される参照型、複合scope、循環の意味、DB内の確認と削除の原子性                                  | 中〜高。TSとRustの2実装維持を避け、まず診断契約・共通試験データを検討               |
| 履歴資産の保持集合   | 現在＋past＋future＋処理中pin、上限から外れた索引の破棄、抽出失敗時に回収しない          | asset抽出callback、snapshot identity、Storeのlease／pin。収集データ保持・DB backupには流用しない | 中。第2の資産consumerが未確認なのでSCADA試験の還元を先行                            |
| 保存container        | entry予算・hash・重複／不正path拒否などの小さい検査部品                                  | SCADA profile、Hubの秘密除外方針、ChronoGazerのDB形式                                            | 共通Project形式は高コスト。3製品の保存単位が異なり一括統一を推奨しない              |
| 原子的file保存       | 一時file・検証・置換・失敗時旧版保持のhost契約                                           | OS／filesystem／sync保証、browserとの能力差、起動時復旧                                          | 将来。現SCADAから渡せる完成実装ではない。既存backupとの差を先に設計                 |
| 遅延実行の取消       | 猶予中だけ取消可能、実行開始後は取消成功を返さない、flush順序と再入                      | ID・UI通知・認可・API結果処理                                                                    | 別候補。HubからBantoへ還元できる。snapshot Undoと統合しない                         |

「command」は、純粋な編集候補を作る処理と、保存・送信・収集開始などの実行操作を区別する。後者を汎用Undoの逆commandで取り消せると約束しない。UIのcommand registry／shortcutの共通化（#435）とも役割が異なる。

## 配置の案

- **Banto**: domainを知らないTSの編集履歴、差分計画、診断shape、browser資産契約、必要なら独立Rust保存primitive。新package名やAPIは今回確定しない。
- **Industrial共通crate**: tag／接続の構成検証・ID再解決・runtime反映。既存`banto-tags`／`banto-collect`を優先する。
- **各アプリ**: 保存schema、domain参照、commandの妥当性、revision・認可・競合・実行副作用。

BantoからSCADA／Industrialへ逆依存を作らず、上流consumerに適合するかを示す最小fixtureで契約を渡す。SCADAのJSON snapshot方式・50履歴を共通仕様に固定しない。差分Undo・永続Undo・自動mergeは今回の共通化に含めない。

## おすすめの進め方

1. **小さい横断fixtureを先に作る**。Hubの複合名の取込計画、SCADAの候補Project検証を例に、共通化して減る処理とadapterの量を比較する。
2. **編集履歴はローカル下書きまで**。SCADAとChronoGazer group下書きを例に、検証失敗時不変、no-op、Redo破棄、owner切替、保存／競合後の扱いを検証する。運用DBを直接Undoしない。
3. **画像資産のテストを既存#438へ接続**。履歴索引はasset抽出と保持集合の試験を渡し、追加consumerが現れるまで新しい大規模基盤にしない。
4. 最小fixtureと上流既存APIの不足が確定してから、Issueを「編集履歴」「取込・診断」「遅延取消」に分ける。保存containerの一括統一Issueは先に作らない。

調査後、ユーザー確認に基づきIndustrialの親Issue [#762](https://github.com/tyaro/banto-industrial/issues/762)へ配置方針・段階・固定source／試験資産を引き渡した。Bantoへの個別Issue／PR、アプリコードの変更・依存更新は未実施。[還元候補一覧](banto-contribution-candidates.md)の「SCADAに残す」はdomain契約を意味するよう修正する。
