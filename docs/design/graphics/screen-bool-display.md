# 画面直下の bool 表示と配管の状態色

作成: 2026-11-14（日本時間）。状態: **A6-1 実装済み、A6-2・A6-3 は未実装**。計画は[目標のフロー図と現状の差分](../editor/flow-diagram-gap-2026-11-12.md)の段階1の残り（A6「画面上の直接結合」と E「画面上の配管の状態色」）。

## 目的

機器（Symbol と機器種別）を介さずに、画面に直接置いた文字と配管を bit タグで「運転／停止」の文字と色に変える。多値（ワード）の表示は従来どおり機器を介すことを基本にし、画面直下は bool の文字と色だけに絞る（gap 文書 A6）。

## 現状

- 画面直下の Text・表のセル・液位のタグ結合は、Rust の読取（`scada-runtime` の `project_index`）がすべて数値型として読む。タグ一覧の型が `bit` のタグは「型が違う」になり、Text は「値が不正」と出す。
- 状態の文字と色（A3a・A3b）と、図形・配管の状態色の追従（`stateColor`）は、共有 Symbol の定義の中だけで使える。

## 区切り

### A6-1 画面直下で bit タグを読む

- 画面直下の結合の読取で、タグ一覧の型が `bit` のタグは bool として読む。数値型のタグは従来どおり。そのほかの型は従来どおり「型が違う」。
- wire の `NumericReading` の `resolved` に任意の `boolValue`（bit のタグで値が Good のときだけ。`numericValue` は `null`）を加える。
- Text と表のセルは、Good の bool を `true`／`false` と出す（slot の bool で `boolDisplay` がないときと同じ文字）。数値の書式は使わない。SIM の前置・品質の表示は数値と同じ。
- 液位は bool を数値として扱わない（「値が不正」と同じ欠測の表示）。
- Project の形は変えない。

### A6-2 画面直下の Text の bool 表示

画面直下の Text に任意の `boolDisplay` を加える。

```json
{
  "binding": { "externalName": "conn.group.pump1_run" },
  "boolDisplay": {
    "true": { "text": "運転", "color": "#16a34a" },
    "false": { "text": "停止", "color": "#64748b" },
    "unknownColor": "#d97706"
  }
}
```

- `true`／`false` の形は機器種別の bool slot の `boolDisplay` と同じ（文字は空でもよい、色は `#RRGGBB`）。`unknownColor` は取得不能の色。
- `binding` が要る。`format` とは同時に持てない。共有 Symbol の定義の中の Text（slot は機器種別の定義に従う）と、ほかの図形には持たせない。
- 評価は A2 の `evaluateSlotState` を bool の slot として使う。Good の bit タグは定義の文字と色。それ以外（未接続・未解決・Bad・Stale・数値型のタグ）は、読取の文字（理由）と `unknownColor`。直前の色や false の色を代用しない。SIM は前置する。
- Inspector の「bool の表示」で、使う／使わない、true／false の文字と色、取得不能の色を編集し、適用で 1 履歴にする。タグを外すと指定も同じ履歴で外す。

### A6-3 画面直下の図形・配管の状態色

- 画面直下の矩形・楕円（有効な単色塗り）・Polyline の `stateColor: { textId }` が、同じ画面の直下にある `boolDisplay` を持つ Text を指せるようにする。
- 色の規則・参照の保護（追従先が残る配色元の削除・指定の解除を拒否）・複製時の参照の振り直し・単体 clipboard の拒否は、[共有Symbolの図形・配管の状態色追従](../equipment/state-color-following.md)と同じにする。

## 対象外

- 画面直下の多値（ワード）の表示、ワードのビットの取出し。機器を介して使う。
- 画面直下の表のセルを配色元にすること。
- 液位の色を状態で変えること。
