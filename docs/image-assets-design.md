# 画像資産と背景画像の最小保存基盤

2026-10-20。Astraの現行コード・上流設計レビューを反映した実装方針。[拡張検討](scada-graphics-runtime-extension-design.md)の§3を具体化する。AssetStoreの基礎だけを先行実装し、Project接続・package・背景画像UIは未実装。正式package全体・Design Domain・復旧・配布が完成したという意味ではない。

## 最初の区切り

不変AssetStore、持ち運べる最小profileのpackage入出力、背景画像1枚の取込／差替え／解除を順に作る。背景画像を通常選択・clipboardへ混ぜない。Image配置・OS画像clipboard・画像ライブラリは後続。

ProjectへはUUID v7のasset ID、原バイト列SHA-256、MIME、バイト数、表示寸法、名称だけを保存する。画面のbackgroundImageがasset IDを参照し、contain／中央を既定にする。背景色の上・全配置の下に表示し、fitと不透明度を画面設定から編集する。画面寸法を画像に合わせて勝手に変更しない。

最初は現在使用中の資産だけを宣言し、最後の参照を外したときは宣言も同じ編集で外す。Undoには旧宣言が残る。未使用画像を保管するライブラリの仕様を先取りしない。同じhashの再取込は既存宣言を再利用する。

## 原本と履歴

バイト列はProject外のAssetStoreへ原本Blobとして持ち、hashで共有する。Blob URLは描画キャッシュだけで、保存しない。呼出側へ可変の原本Uint8Arrayを公開しない。

現在Project・Undo／Redoのpast/future・置換確認中の候補・進行中の書出しが必要とするhashを保持する。画面から未使用になっただけで解放せず、保持対象全てを確認してからGCする。ProjectをJSON複製する度に画像を複製しない。

取込は検査・hash・decode・一時保管後に、対象世代・所有画面・未適用入力を再検証し、資産宣言＋背景設定を1回のUndoで確定する。失敗・取消ではProject・履歴を変えない。

## 静止画像と暫定上限

PNG／JPEGを内容で確認し、原本は再圧縮しない。PNGのαを保持し、APNGは初回対象外。JPEGはEXIF方向を含む表示寸法を統一する。signatureとヘッダー寸法だけで成功にせず、実decodeも確認する。

初期上限は1画像8MiB、1辺8192px、16MP、Project合計64MiB・128資産、履歴込みStore256MiB。package80MiB、metadata JSON各1MiBとし、圧縮前サイズだけでなく実展開量にも上限を設ける。これらは代表画像と図面で評価して調整する暫定値。画像decodeを無制限に並列実行しない。

## 最小package profile

`.bantoscada` ZIPに、profile／versionを明示した `manifest.json`、画面・Symbol・資産宣言の `project.json`、`assets/<sha256>.<ext>`、`checksums.json` を含める。manifestを二重の正として保存せず、adapterで分離・再構成する。checksumは自分自身を除く全内容ファイルに対して作る。

画面別のファイル分割・directory adapter・全体contentHash・更新競合・Design Domain・復旧・配布・署名は後続。上流の正式packageとの差分を記録し、最小profileを正式仕様全体と説明しない。

ZIPは小さな依存を遅延読込し、重複entry・絶対パス・親移動・バックスラッシュ・暗号化・未対応圧縮・欠損／余分な資産・hash不一致を拒否する。全entryを無制限の同期一括展開へ渡さない。

## JSONと非同期I/O

資産なしProjectは従来JSON保存を継続する。資産ありでは通常保存・Ctrl／Command＋S・置換確認内の書出しを同じpackage経路へ切り替える。資産参照を持つ単体JSONは、理由を示して拒否する。同じセッションに偶然画像があるから開ける、という挙動にしない。

読込はProjectと全資産を検証した候補を作ってから置換確認へ進み、採用時にProject・Store・履歴・世代をまとめて交換する。取消は現在のStoreへ影響しない。

非同期保存開始時のProject snapshotと必要バイトを固定する。完了後のbaselineは書き出したsnapshotに対応させ、途中の編集を保存済みに見せない。Project差替え後は新Projectのbaselineを更新しない。

Image配置の追加時は、依存バイトを含む専用clipboardと容量制限を実装するか、画像を含むコピー／切取を理由付きで拒否する。参照だけコピーして別Projectで欠損させたり、画像を黙って除外したりしない。

## 検証

別ブラウザ環境へのpackage往復、同一原本の共有、解除とUndo／Redo、履歴破棄後のGC、壊れたZIP／hash／画像、容量超過、候補取消、画像処理中の画面・Project切替、書出し中の編集を確認する。Rust／TypeScript／schemaで資産宣言と参照の共通fixtureを持ち、ZIP adapterの対応範囲と区別する。

## AssetStore基礎の実装（2026-10-20）

`image-assets.ts`でPNG／JPEGのヘッダー・寸法・実decode、原本SHA-256、不変Blobの共有、宣言との一致、URLキャッシュ、保持対象と非同期処理のpin／解放を実装した。PNGのアニメーション・チャンク切れ・終端異常を拒否し、JPEGの方向による寸法交換を許容する。取込先Storeの破棄後は遅延完了を登録しない。

この段階ではProject・履歴からの保持集合算出、通常保存のpackage化、画面への描画は接続していない。任意の画像をアプリへ開ける機能の完成ではない。次の工程で宣言・背景参照・I/O・非同期対象保護を一体として接続する。
