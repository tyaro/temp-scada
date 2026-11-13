# 画面切替ボタン（navButton）

作成: 2026-11-13（日本時間）。状態: **実装済み（フロー図 段階2-A）**。計画は[目標のフロー図と現状の差分](../editor/flow-diagram-gap-2026-11-12.md#543-pr-の区切り)の 2-A。

## 目的

ヘッダーのボタン列のように、押すと別の画面へ移るボタンを画面に置く。書込み・外部 Action は持たない（[統合設計](../scada-integrated-design.md) §8 の Navigate の最小形）。

## 保存の形

画面の `objects` に置ける独立の配置 `$defs.navButtonInstance`（`shape.type: "navButton"`）を加えた。screenView・トレンドと同じく画面の直下にだけ置け、Symbol 定義の中には置けない（schema の oneOf に無い）。

| 項目                              | 型             | 意味                                                                                                |
| --------------------------------- | -------------- | --------------------------------------------------------------------------------------------------- |
| `target`                          | 行き先（任意） | `{ kind: "screen", screenId }`・`{ kind: "back" }`・`{ kind: "forward" }`。無いときは行き先未設定。 |
| `label`                           | 文字列         | ボタンの文字。1行・200文字以内。空でもよい。                                                        |
| `fontSize`                        | 数値           | 文字サイズ（0 より大きく 512 以下）。                                                               |
| `fill`・`textColor`               | 色             | 通常の塗りと文字色。                                                                                |
| `currentFill`・`currentTextColor` | 色（任意）     | 行き先が表示中の画面のときの塗りと文字色。無いときは通常の色。                                      |

- 配置の共通項目（`id`・`order`・`x`・`y`・`width`・`height`・`rotation`・`name`・`locked`・`visible`・`folderId`・`opacity`）は screenView と同じ。配置直下の `fill`・`colorAlpha`、反転（`flipX`・`flipY`）は持たない（文字を含むので表と同じく反転しない）。
- 検査（Rust `validate_nav_buttons`、TS `parseProject`）: `kind: "screen"` の行き先の画面が存在すること。自身の画面を行き先にしてよい（強調の対象になる）。非表示のボタンも検査する。
- 枠の画面（ヘッダー・フッター）を行き先から除く検査は 2-C で加える。
- schemaVersion は 0.37.0 を据え置いた。旧形式の読込・移行はない。

## 表示と操作

`nav-button.ts` の純関数（`navButtonIsCurrent`・`navButtonColors`・`navButtonDestination`・`navButtonDisabled`）が決め、`NavButtonPainting.svelte` が角丸の矩形と中央寄せの文字を描く。

- 行き先が表示中の画面（`Renderer` の画面）のとき、現在の画面の色で描く（`data-nav-current`）。編集中も同じ。埋込画面の中のボタンは通常の色で描き、押せない（埋込は `pointer-events="none"`）。
- 編集中は押しても移動しない（選択だけ）。
- 表示プレビューでは、行き先が画面のボタンが `role="button"` になり、クリック・Enter・Space でその画面へ移る。Designer の画面タブも追従する（`Renderer` の `onnavigate`→`CanvasWorkspace`→`App` の `openScreen`。機器の読取詳細の入口 `onopenequipment` と同じ形）。
- 戻る・進む・行き先未設定は、プレビューでは押せず薄く描く（`data-nav-disabled`）。戻る・進むの履歴は 2-C の運転表示で扱う。

## 編集

- 追加: 部品パネル（「画面切替ボタンを追加」）・右クリックの挿入・メニューの「画面切替ボタンを追加」。Symbol 定義の編集中は出さないか無効にする。既定は 140×40、文字「画面切替」、16、塗り `#334155`・文字 `#f8fafc`、現在の画面のとき `#0ea5e9`・`#0f172a`、行き先未設定。
- Inspector: 行き先（未設定・各画面・戻る・進む）、文字、文字サイズ、塗り、文字色、「現在の画面のとき」（色を変える／通常の色のまま）と現在の塗り・文字色。「色を変える」は 2 色をまとめて保存し、「通常の色のまま」は 2 色とも外す。「行き先の画面を開く」で行き先の画面タブへ移る。
- 編集コマンドは `update` の `navButton`（`type` を除く shape 全体。無い `target`・現在の色は外す）。レイヤーの表示名は「画面切替 · 描画順」、検索はボタンの文字でも当たる。

## 貼付け・画面の削除

- コピー: 行き先の画面が clipboard に入らない（コピー元の画面でも埋込の依存画面でもない）ボタンは、clipboard の Project では行き先を外し、envelope の `navTargets`（配置ID→画面ID）に控える。clipboard の Project も検査を通すため。
- 貼付け: `navTargets` を戻したうえで、行き先の画面が貼付け先の Project にある（または同時に取り込んだ埋込の依存画面）ときだけ残し、無いときは `target` を外して「行き先未設定」のボタンにする。戻る・進むはそのまま。
- Symbol 定義への貼付けは拒否する。
- 画面の削除: 埋込表示と同じく、ほかの画面のボタンの行き先になっている画面は削除できず、使用中のボタンを示す（削除する画面自身の上のボタンは妨げない）。
- 画面の複製: ボタンはそのまま複製され、行き先は元の画面のまま（自身を指すボタンも元の画面を指す）。

## 検証

- 共通の契約: `examples/nav-button-cases.json`（Rust `shared_nav_button_contract`、TS `nav-button.test.ts`）。
- 純関数・編集コマンド・フォーム・画面の削除・clipboard: `nav-button.test.ts`。
- ブラウザ: `e2e/nav-button.spec.ts`（プレビューで押して移る・Enter で戻る・現在の画面の強調・戻るの無効、編集中は選択だけで移らない・Inspector で行き先と文字を変える、部品パネルからの追加）。

## 後続・未対応

- 戻る・進むの履歴、ヘッダー・フッターの枠と枠の画面を行き先から除く検査は 2-C。
- 設備 context・開き方（別窓）・戻り先、押したときの権限・確認は持たない。
- Tauri 実機での表示は未確認。
