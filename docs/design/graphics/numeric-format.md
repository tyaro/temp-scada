# 数値の書式（小数桁・単位）

作成: 2026-11-12（日本時間）。状態: **実装済み（フロー図 段階1-B）**。計画は[目標のフロー図と現状の差分](../editor/flow-diagram-gap-2026-11-12.md#53-段階1-bf)の B。

## 目的

参照画面の数値表示（Hz、mm、m3/h、kPa、℃、pH など）を、桁をそろえ、単位を付けて出す。値の取り方（読取・品質・SIM の判定）は変えない。

## 保存の形

Text の `format`（任意）。schema は `$defs.numericFormat`。

| 項目       | 型                 | 意味                                                                             |
| ---------- | ------------------ | -------------------------------------------------------------------------------- |
| `decimals` | 整数 0〜6（任意）  | 小数の桁数。ないときは値をそのまま（`String(value)`）出す。                      |
| `unit`     | 文字 1〜16（任意） | 単位。数値の後ろに空白を挟んで付ける。前後の空白と制御文字・行区切りは使えない。 |

- `format` は空にできない（どちらか1つは要る）。解除は `format` ごと消す。
- タグを結合した Text（`binding`）か、slot を結合した共有Symbol内の Text（`slotBinding`）だけが持てる。静的な Text・機器情報の Text は持てない（schema の `if`／`then`）。
- タグ・slot の結合を外すと、編集コマンドが `format` も一緒に消す（同じ Undo）。
- 単位は Project に文字で保存する。タグ一覧の単位とは同期しない（タグ一覧の単位は編集の初期値に使うだけ）。
- schemaVersion は 0.37.0 を据え置いた。旧形式の読込・移行はない。

## 表示の規則

- 書式を使うのは、Good で有限の数値だけ。`tag-presentation.ts` の `formatNumber`。
  - 小数桁は `toFixed` で丸める（保存された2進の値で丸めるので、`12.345` は `12.34` になる）。
  - 丸めて 0 になった負の値は符号を外す（`-0.04` を1桁で `0.0`）。
- 単位は Good の数値にだけ付ける。未接続・未解決・値が不正・更新停止・不良は従来の `-- · 理由` のままで、単位を付けない（欠測を値に見せない）。
- SIM の値は `SIM · ` を前に付ける（従来どおり）。
- slot の Text: number の slot の Good の値だけに書式を使う（`formatSlotText`）。bool・state の slot の文字と状態の定義の文字には効かない。

## 編集

Inspector の「数値の書式」フォーム（`designer/NumericFormat.svelte`、コマンドは `designer/forms/numeric-format.ts`）。

- 表示する条件: タグを結合した画面の Text、または number の slot に結合した共有Symbol内の Text（すでに書式を持つ slot の Text も、解除のために出す）。
- 小数桁は「そのまま」と 0〜6 から選ぶ。単位は前後の空白を除いて保存する。
- 両方を空（そのまま・単位なし）で適用すると書式を解除する。
- 書式がなく、結合したタグがタグ一覧に単位を持つときは、その単位を単位欄の初期値として入れ、その旨を表示する。適用するまでは表示に付かない。

## 検証

- 共通の契約: `examples/numeric-format-cases.json`（Rust `shared_numeric_format_contract`、TS `numeric-format.test.ts`）。
- 書式・フォーム・編集コマンド: `numeric-format.test.ts`。
- ブラウザ: `e2e/numeric-format.spec.ts`（モックの読取で、タグの Text と number slot の Text の表示、Inspector での適用・Undo・解除とタグ一覧の単位の初期値）。

## 後続・未対応

- 千の位の区切り、指数表記、工学値の範囲（スケーリング）は持たない。
- 表（段階1-F）が同じ書式を使う予定。液位（段階1-C）は書式を持たず、書式付きの Text を重ねる。
- Tauri 実機・実Hub での表示は未確認。
