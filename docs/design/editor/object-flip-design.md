# 配置の反転（左右・上下）

文書の位置付け: **採用済み設計・導入時の実装記録（2026-11-13）。** フロー図 段階1-D の前半。現在の対応範囲と保存契約は[実装状況](../../project/implementation-status.md)を正とする。[配置の回転](object-rotation-design.md)の契約に倣う。部品の追加は別の PR とする。

## 保存と対象

配置の共通属性に任意の `flipX`・`flipY`（boolean）を加える。`true` のときだけ保存し、`false` に戻したらキーを消す。schema は `false` も受理するが、TypeScript の生成・編集経路は書かない。schemaVersion は 0.37.0 のまま。旧形式の移行は作らない。

対象は矩形・楕円・Polyline・Symbol・Image・液位。共有定義の内部図形も同じ規則で個別に反転できる。**Text とトレンドは反転できない。** Text は `flipX`／`flipY` が `true` なら schema（Rust・TypeScript の共通検査）で拒否する。トレンドと画面埋込は属性自体を持たない。

## 変換

local 座標で pivot（回転と同じ `rotationPivot`）を中心に鏡映してから回転する。

world = translate(x, y) · rotate(r, pivot) · mirror(pivot)

SVG では `rotate(r px py) matrix(sx 0 0 sy ex ey)`（反転した軸は `s = -1`、`e = 2 × pivot`）を `translate` の内側に付ける。反転なし・回転 0 の出力（transform 文字列を含む）は変えない。変換は `rotation.ts` に集め、描画・Editor・表示プレビュー・埋込 View・ミニマップ・部品のプレビュー／サムネイル・選択外形・クリック領域・接続点・リサイズ・頂点移動・リサイズカーソルが同じ関数（`objectToWorld`／`worldToObject`／`rotationTransform`／`objectTransform`／`placementVector`／`rotatedBounds`）を使う。Rust の配管端点の照合（`connections.rs` の `world()`）も同じ順序で鏡映する。

反転した Symbol の中の Text は読める向きを保つ。位置は親とともに鏡映し、文字は Text の本体枠の中心で親と同じ軸だけ逆に鏡映して戻す（`readableChild`）。Symbol 定義は Symbol を入れ子にしないので親 1 段で足りる。

## 操作

- **左右反転／上下反転**（ツールバーの「回転・反転」区切り・編集メニュー・右クリック。複数選択の右クリックでは整列の前に出す）: **画面上**の反転。左右は `flipX` を、上下は `flipY` を切り替え、角度を `normalizeRotation(-rotation)` にする（M = R(r)·F に対し H·R(r)·F = R(-r)·H·F）。pivot が中心なので配置は動かない。単一選択と複数選択（各配置の自身の中心）に使え、1 回の操作が 1 つの履歴になる（コマンド `flip`）。Text・トレンド・画面埋込・ロック中の配置を含む選択、グループの選択中は無効。hidden は回転と同じく明示操作で変更できる。
- **プロパティの「左右反転」「上下反転」**: 保存する配置の軸の反転を直接切り替える（角度は変えない）。数値プロパティと同じく保存属性の編集で、回転した配置では画面上の向きとずれる。未適用の入力がある間は効かない（draft guard）。
- 配管の接続は既存の追従で端点が付いてくる。

## 受入

- 共通ケース `examples/flip-cases.json`: 種別ごとの受理／拒否（Text・トレンドの拒否、`false` の受理、型違い）と、反転・回転した Symbol の接続点の world 座標。Rust（`flip_shares_the_browser_contract`、`flipped_anchor_world_matches_typescript`）と TypeScript（`flip.test.ts`）の両方が読む。
- `examples/connection-cases.json`: 反転した接続先／配管で、古い端点の拒否と鏡映後の端点の受理。
- `flip.test.ts`: transform 文字列、往復、リサイズの対辺固定、頂点移動の未操作頂点固定、カーソル、コマンド（角度の符号反転・中心不変・複数選択の 1 履歴・Undo・拒否・キーの削除・配管の追従）。
- `e2e/flip.spec.ts`: 矩形・Symbol の描画 transform、反転後の選択枠、Symbol 内 Text が読める向き（編集と表示プレビュー）、プロパティの切替、Undo。
