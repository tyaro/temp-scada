# 画像の貼り付けと原本を含む図形clipboard

2026-10-20（日本時間）。Astraの読取専用レビューを反映。[拡張検討の画像clipboard](scada-graphics-runtime-extension-design.md#3-背景画像imageclipboard)を段階化する。Projectモデルは0.17.0を共用する。

## 第1段階：OS画像の貼り付け

画面のキャンバス／レイヤーでCtrl／Command＋Vを押すと、クリップボードから受け取った単一の静止PNG／JPEGをImageとして配置する。既存の内容・寸法・decode検査、8MiB／8192px／16MP制限、AssetStore、初期枠計算、Undoと画像同梱保存を共用する。成功時に配置を選択し、連続配置を終了する。同じ原本の繰返し貼付は資産を共有する。

優先順位はSCADA図形断片→単一画像→従来のテキスト経由。SCADA形式を名乗るデータが壊れている場合はエラーにし、付随する画像へ暗黙に切り替えない。通常の説明文・HTMLが画像に付随しても、キャンバスでは画像を選べる。HTMLやURLから画像を取得しない。複数画像・未対応形式は最初の1枚だけを採用せず、全体を拒否する。

native pasteでは、イベント中に文字列とFileを同期的に確保する。未適用入力の確認・decodeが終わってから元のDataTransferを読み直さない。開始時のProject世代・所有先・可視範囲・画面寸法を固定する。画面やモードを離れた時点で依頼を失効させ、戻っても再開しない。decode後に発生した未適用入力も確定前に保護する。

入力欄・contenteditable・メニュー・Modal・表示プレビューでは通常pasteを奪わない。Symbol定義では画像だけを理由付き拒否し、基本図形の既存貼付は維持する。背景画像への貼付ではなく、通常のImage配置として扱う。

メニュー「貼り付け」は、ユーザーが実行した時だけAsync Clipboardの`read()`を呼ぶ。1つのClipboardItem内のPNG／JPEGは代替形式として扱い、PNGを優先する。画像を読み取れない／権限を拒否された場合は、キャンバスでのCtrl／Command＋Vまたは「画像を配置」を案内する。`read()`がない環境では従来の`readText()`による図形貼付を維持する。バックグラウンドでclipboardを監視しない。

保持する「原本」はOS clipboardから渡されたバイト列。OSやコピー元によってJPEGがPNGへ変換される場合、コピー元ファイルとのバイト同一性は保証しない。受け取ったPNGの透過と画像バイトは、再圧縮せず保存する。

## 第2段階：図形と画像原本の同時コピー（未実装）

画像を含まない図形は現行のversion 1・text/plain・4MiB上限を維持する。画像を含む場合は別versionの専用payloadを用意し、選択した配置・依存Symbol・必要assetのmetadataと原本を運ぶ。背景や未選択画像を含めず、同じhashの原本は1回だけ持つ。

暫定案はtext/plain JSON＋base64。原本合計16MiB、encoded payload32MiB、画像単体8MiBとし、文字数／UTF-8量・base64形式と展開量をdecode前に検査する。全原本のhash・metadata・decode・参照を一時Storeで照合してから、混在選択全体をUndo1回で貼り付ける。容量不足・欠損・Symbol定義への画像混入は全体を拒否する。受け入れ先の同じhashは共有し、別の資産ID衝突は新IDへ対応付ける。

copyイベントへ`Blob.arrayBuffer()`をawaitした後で`setData()`しない。画像を含むコピーはAsync Clipboardへユーザー操作中にPromise付きClipboardItemを渡す等の対応経路を採る。対応外・書込拒否は明示する。切取は書込成功後に世代・revision・選択を再確認し、変わっていればコピーだけ成功として削除しない。

## 受入

OS貼付は両テーマの実Ctrl＋V、透過、受渡しバイトの保存、原本共有、Undo／Redo、SCADA文字列と画像の同時提供、壊れたSCADA、複数・不正画像、JPEG、メニューの権限拒否、入力欄／共有定義／preview、draft取消／続行、画面やモードの往復と遅延処理を確認する。

第2段階では別Project／別ブラウザ、共有asset・ID衝突、混在図形の原子的Undo、容量不足、書込失敗時の切取保持、処理中の変更／取消、同じセッションのライブSymbol共有も確認する。実装状況は[開発計画](development-plan.md#image-paste-progress)へ記録する。
