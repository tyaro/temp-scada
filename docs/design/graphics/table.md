# 表（table 図形）

作成: 2026-11-13（日本時間）。状態: **実装済み（フロー図 段階1-F の第1段: 固定の文字のセル、第2段の 2a: 画面の表のセルのタグ結合、2b: Symbol 内の表のセルの slot 結合）**。計画は[目標のフロー図と現状の差分](../editor/flow-diagram-gap-2026-11-12.md#53-段階1-bf)の F。

## 目的

工程表（工程・開始・完了）、設定値・PV の表、メッセージの枠のような、行と列の罫線と見出しを持つ表を、矩形と Text を並べずに1つの配置で描く。

## 保存の形

配置の `shape` に `type: "table"` を加えた。画面にも共有Symbolの定義にも置ける。配置は幅・高さを持ち、回転できる。

| 項目         | 型                         | 意味                                                                                                |
| ------------ | -------------------------- | --------------------------------------------------------------------------------------------------- |
| `columns`    | 数の配列（1〜32）          | 列幅の比。配置の幅をこの比で分ける。各値は 0 より大きく 1000 以下。                                 |
| `rows`       | 数の配列（1〜100）         | 行の高さの比。配置の高さをこの比で分ける。                                                          |
| `cells`      | セルの行列                 | `rows` の数 × `columns` の数。形が合わない表は拒否する（schema では書けないので Rust・TS で検査）。 |
| `style`      | 文字書式                   | `fontSize`・`fontWeight`・`align`。表のすべてのセルに効く（Text の `wrap` は持たない）。            |
| `border`     | `{ color, width }`（任意） | 外枠と内側の罫線。ないときは線を引かない。太さは 0 より大きく 32 以下。                             |
| `background` | 色（任意）                 | 塗りのないセルの地。ないときは透明。                                                                |

セルは `{ text, fill?, color?, binding?, slotBinding?, stateColors?, format? }`。

- `text` は 256 文字以内で、改行・タブを含まない（入力をタブ区切りにするため）。空のセルは文字を描かない。
- `fill` はセルの塗り、`color` はセルの文字色。ないときは塗らない／配置の `fill`（文字色）を使う。
- `binding` はセルが読むタグ（`{ externalName }`、Text と同じ `$defs.tagBinding`）。画面の表だけに置ける。Symbol 定義の中の表のセルの `binding` は、Text と同じく「Symbol 定義内の直接タグ割り当てには対応していません」で拒否する（Rust・TS）。
- `slotBinding` はセルが読む slot（`{ slotName }`、Text・液位と同じ `$defs.slotBinding`）。Symbol 定義の中の表だけに置け、その定義の宣言済みの読取 slot（`readSlots`）を参照する。画面の表のセルの `slotBinding` は「表のセルのslotは共有定義内の表だけに設定できます」、未宣言の slot は「Symbolの読取slot宣言が見つかりません」で拒否する（Rust・TS の `validateSymbolSlots`）。`binding` と同時には持てない（schema の `not` と `validateTableShape`）。
- `stateColors` は状態の色に従う指定（`{ unknownColor }`、Text と同じ `$defs.stateTextColors`）。`slotBinding` のあるセルだけ（schema の `dependentRequired`）、かつ bool か state の slot のセルだけ（Rust・TS）。
- `format` は[数値の書式](numeric-format.md)（`$defs.numericFormat`: `decimals` 0〜6、`unit` 16 文字以内）。`binding` か `slotBinding` のあるセルだけに置ける（Rust と `validateTableShape` の検査）。
- 比で持つので、配置の大きさを変えても列・行の割合は保たれる。
- 文字を含むので、Text と同じく反転（`flipX`／`flipY`）できない（schema・`canFlip` で拒否）。反転した Symbol 配置の中の表は、Text と同じく `readableChild` で鏡映を打ち消し、位置だけ鏡映して読める向きで描く。
- schemaVersion は 0.37.0 を据え置いた。旧形式の読込・移行はない。

## 表示の規則

`table.ts` の `tableCellBoxes`（セルの位置）を `TablePrimitive.svelte` が描く。

- 描く順: 地 → 各セルの塗りと文字 → 内側の罫線 → 外枠。罫線は線の太さの半分だけ内側に引き、配置の枠からはみ出さない。
- 文字は1行で、セルの縦の中央に置く。左揃え・右揃えはセルの端から 4px 内側。セルからはみ出す文字はセルの範囲で切り取る（省略記号は付けない）。
- 色の不透明度（`colorAlpha`）は文字にだけ効き、塗り・罫線には効かない。配置全体の不透明度（`opacity`）は全体に効く。
- 単色の Symbol 配置（`colorMode: "monochrome"`）の中では、文字と罫線を配置の色にし、セルの塗りと地は定義の色のまま残す（塗りまで単色にすると文字が読めなくなるため）。
- タグを結合したセルは、`text` の代わりに `presentNumeric(読取, format)` の文字を出す。品質（未接続・未解決・値が不正・更新停止・不良・模擬の `SIM ·`）は Text の数値表示と同じで、値がないときは保存した `text` に戻らず `-- · 理由` を出す（単位は付けない）。`text` は保存に残るが表示しない（Inspector で結合を外すと戻る）。セルの塗り・文字色・罫線の規則は固定の文字のセルと同じ。
- 結合したセルは `data-table-cell-tag`（外部名）と `data-table-cell-state`（`presentNumeric` の state）を持ち、`<title>` に「外部名 · 状態の名前」を出す。
- slot に結合したセル（Symbol 定義の中の表）は、slot に結合した Text と同じ規則で出す（`table-cell-slot.ts` の純関数 `tableCellSlotView`）。読取は `resolveSymbolSlot`。機器種別の slot に状態の定義（state、または `boolDisplay` のある bool）があり、状態が既知（または Good でも状態にできない）なら `slotStateText` の状態の文字、それ以外は `formatSlotText(読取, format)`。`ObjectPainting` が Symbol 配置ごとに slot 名から読取と機器種別の slot を返す関数を作り、`Primitive` を経て `TablePrimitive` に渡す。
- 文字色は、`stateColors` のあるセルなら Text の状態の色と同じ規則（`state-color.ts` の `slotStateColor`: 既知で色あり→その色、既知で色なし→通常の色、不明→`unknownColor`）。状態の色は単色の Symbol 配置の色より優先する（`状態の色 ?? 配置の単色 ?? セルの color ?? 配置の fill`）。`stateColors` のないセルは従来どおり。
- slot に結合したセルは `data-table-cell-slot`（slot 名）と `data-table-cell-state`（読取の state、定義された状態が不明ならその理由）を持ち、`<title>` に「slot 名 · 状態の名前」を出す。
- 描画の要素は `data-table`（`data-table-rows`・`data-table-columns`）、セルは `data-table-cell="行:列"`（0 始まり）、罫線は `data-table-grid`・`data-table-frame` を持つ。

## 編集

- 追加: 部品パネル（オブジェクトの分類）・お気に入り・右クリックの挿入・メニューの「表を追加」。既定は 240×90、3 行 × 3 列（1 行目に「項目」「SV」「PV」）、罫線 `#94a3b8` 太さ 1、地なし。文字色は Text と同じ既定色。
- Inspector の欄（「変更を適用」か Ctrl／⌘＋Enter で確定）:
  - 「セルの文字」: タブ区切り、行は改行。表計算ソフトの範囲をそのまま貼り付けられる（末尾の改行は無視）。列の数は最も長い行に合わせ、足りないセルは空にする。欄の中では Tab がタブを入れ、Shift＋Tab で前の欄へ移る。
  - 「列幅の比」「行の高さの比」: カンマか空白で区切る。空欄はすべて 1。数が足りなければ 1 で補い、多ければ後ろを捨てる（行・列を減らしたとき）。指数表記（`1e-7`）も読む。
  - 「セルの塗り」「セルの文字色」: 文字と同じ並びのタブ区切りで `#rrggbb` を書く。空のセルは色なし。表より行・列が多い色の表は拒否する。色は位置で対応するので、行・列を入れ替えたら色の表も直す。
  - 「セルのタグ」（画面の表だけ。Symbol 定義の編集中は代わりに「セルのslot」を出す）: 同じ並びのタブ区切りで外部名を書く。空のセルは固定の文字。外部名は前後の空白も含めてそのまま保つ（空白だけのセルは結合なし）。タブ・改行を含む外部名は欄で往復できないので、表のセルの `binding` に限り schema（`$defs.tableCellBinding`）と `validateTableShape` で拒否する。表より大きい表は拒否する。
  - 「セルの書式」（画面の表と Symbol 定義の表）: 各セルを `小数桁;単位` で書く（例: `1;℃`・`2;`・`;kPa`）。最初の `;` で分け、左を前後の空白を除いて空なら小数桁なし、そうでなければ 0〜6 の整数（それ以外は拒否）。右を前後の空白を除いて空なら単位なし、そうでなければ単位（単位の中の `;` はそのまま）。`;` を含まない空でないセルは拒否する。空のセルは書式なし。タグのないセル（Symbol 定義では slot のないセル）に書式があれば拒否する。
  - 「セルのslot」（Symbol 定義の編集中だけ）: 同じ並びのタブ区切りで slot 名を書く。空のセルは固定の文字。前後の空白は除く。宣言済みの読取 slot でない名前は拒否する。
  - 「セルの取得不能の色」（同上）: 同じ並びのタブ区切りで `#rrggbb` を書く。色を書いたセルは状態の色に従い（`stateColors`）、取得不能のときその色になる。bool・state 以外の slot のセルや slot のないセルに書けば拒否する。
  - 文字サイズ・文字の太さ・文字揃え、罫線（引く／なし）と色・太さ、地（透明／色で塗る）と色。
- 編集コマンドは `update` の `table`（`type` 以外の全項目を置き換える。`border`・`background` を省くと消す。セルの `binding`・`slotBinding`・`stateColors`・`format` も cells に含めて置き換える）。

## タグ結合の参照

- Rust `Project::text_bindings` は、画面の Text・液位の結合に加えて、表の結合したセル（行優先の順）を返す。同じ表から同じ `object_id` で複数返すことがある。読取要求（`scada-runtime`）はこれを外部名ごとにまとめる。
- TS `shapeTagBindings`（`shape-bindings.ts`）は図形が読むタグの配列（Text・液位は 0 か 1 件、表は結合したセル全部）。参照一覧（同じ表で同じタグを読むセルは配置ごとに 1 件）、読取の要求名、タグ名の一括置換（一致するセルをすべて置き換える）、レイヤーの検索、Symbol 定義への貼り付けの拒否（タグ付きの Text・液位・表）がこれを使う。
- TS `shapeSlotNames`（同）は Symbol 定義の中の図形が読む slot の配列（Text・液位は 0 か 1 件、表は slot に結合したセル全部）。slot の使用箇所（`symbolSlotUsages`。使用中の slot の改名・型変更・削除の拒否と slot 宣言の一覧）、slot の状態一覧（`slot-status-summary.ts`）、描画がこれを使う。slot に結合したセルを持つ表の単体のコピー・切り取りは、slot 表示単体と同じく拒否する。

## 検証

- 共通の契約: `examples/table-cases.json`（Rust `shared_table_contract`、TS `table.test.ts`）。行・列とセルの形の不一致、比の範囲、セルの文字のタブ・改行・長さ、色の形式、未知の項目、`wrap`、反転、タグのないセルの書式、Symbol 定義内のセルのタグ、空の外部名、範囲外の小数桁、画面の表のセルの slot、`binding` と `slotBinding` の同時、未宣言の slot、number の slot のセルの `stateColors`、slot のないセルの `stateColors`・書式、不正な slot 名・取得不能の色を拒否する。Rust `text_bindings_include_bound_table_cells` が表のセルの結合を確かめる。
- 入力の変換・位置・編集コマンド・フォーム、セルのタグ・書式の入力、`shapeTagBindings`・参照一覧・一括置換・Symbol への貼り付けの拒否、セルの slot・取得不能の色の入力と拒否、`shapeSlotNames`・`symbolSlotUsages`・slot の状態一覧・使用中の slot の削除の拒否・コピーの拒否: `table.test.ts`。セルの表示の解決（既知の状態の文字と色・不明の色・数値の書式）: `table-cell-slot.test.ts`。
- ブラウザ: `e2e/table.spec.ts`（明暗の両テーマでセルの位置・塗り・文字色・罫線、Inspector のタブ入力と色の表の拒否・保存、部品パネルからの追加と反転の無効、結合したセルの書式付きの値・未解決・更新停止、Inspector でのセルのタグ・書式の入力と拒否、Symbol 内の表のセルの slot の状態の文字・色・書式付きの数値・取得不能）。

## 後続・未対応

- Symbol 定義の中の表のセルを状態色の配色元（`stateColor` の追従元）にすることはできない（配色元は Text だけ）。
- Inspector のセルの slot の候補からの選択は持たない。slot 名を直接書く。
- セルのタグの候補からの選択（Text のタグ選択の Modal）は持たない。外部名を直接書く。
- セルの結合（複数の行・列にまたがるセル）、セルごとの文字揃え・文字サイズ、複数行の文字、キャンバス上でのセルの直接編集は持たない。
- Tauri 実機での表示は未確認。
