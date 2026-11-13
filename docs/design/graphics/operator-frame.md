# 運転表示の枠（operatorFrame）

作成: 2026-11-14（日本時間）。状態: **実装済み（フロー図 段階2-C。前半＝モデルと設定、後半＝運転表示 `OperatorView`）**。計画は[目標のフロー図と現状の差分](../editor/flow-diagram-gap-2026-11-12.md#543-pr-の区切り)の 2-C。

## 目的

運転表示で、主画面の上下に固定するヘッダー画面・フッター画面と、最初に開く開始画面を Project に持たせる。

## 保存の形

Project 直下の任意の `operatorFrame`。

| 項目             | 型             | 意味                                   |
| ---------------- | -------------- | -------------------------------------- |
| `startScreenId`  | 画面id（任意） | 運転表示で最初に開く画面。             |
| `headerScreenId` | 画面id（任意） | 主画面の上に固定する画面（ヘッダー）。 |
| `footerScreenId` | 画面id（任意） | 主画面の下に固定する画面（フッター）。 |

- 中身がすべて空なら `operatorFrame` ごと保存しない（schema は `minProperties: 1`、編集コマンドが空欄を落とす）。
- schemaVersion は 0.37.0 を据え置いた。旧形式の読込・移行はない。

## 検査（Rust `validate_operator_frame`、TS `parseProject`／`validateOperatorFrame`）

- 指定した画面が存在する。
- 開始・ヘッダー・フッターは互いに別の画面。
- ヘッダー・フッターの画面を画面切替ボタン（navButton）の行き先にできない。開始画面は行き先にしてよい。

## 編集

- サイドバー（編集モードの左パネル「プロジェクト」）の「プロジェクト設定」にある「運転表示の設定」で、3つの画面を「なし」＋画面一覧から選び、「運転表示の設定を適用」で適用する。画面設定とは別のフォーム。
- 適用は1つの編集コマンド `set-operator-frame`（元に戻せる）。違反はエラーで示し、Project は変わらない。
- 枠で使っている画面は削除できず、「運転表示の開始画面／ヘッダー画面／フッター画面です」と示す。画面の id は改名で変わらないので追従は不要。複製した画面は枠に入らない。
- 画面切替ボタンの Inspector の行き先の候補から、ヘッダー・フッターの画面を除く。貼付けで行き先がヘッダー・フッターの画面になる場合は行き先を外す。

## 運転表示（OperatorView）

Designer のプレビューと分けた表示確認の一形態。枠（ヘッダー・フッター）と主画面だけを出し、画面切替ボタンで画面を移る。正式な Runtime（起動時の mode と Host の境界、[統合設計](../scada-integrated-design.md)§10）でも権限の切替でもない。書込み・外部 Action はない。

- 入口: 表示プレビューのツールバーの「運転表示」。Designer の UI の上に全面で重ね、裏の UI は `inert` にする（Tab で裏へ移らない。Designer のキー操作・コピー・貼付けも止める）。上端の帯に現在の画面名、全画面の切替（既存の `PreviewFullscreen`・`preview-fullscreen.ts` を流用。全画面にするかは利用者が選ぶ）、「運転表示を終了（Esc）」を置く。Esc か終了ボタンで戻り、入口のボタンへフォーカスを戻す。全画面中の Esc はブラウザが全画面の終了に使うので、運転表示を閉じるにはもう一度 Esc を押す。編集モードへの切替・Project の差し替えでも閉じる。
- 開始画面: `startScreenId`。無ければ入口を押したときの Designer の画面。それがヘッダー・フッターの画面なら、枠に使っていない最初の画面（`operatorStartScreen`）。枠に使っていない画面がなければ運転表示を開かず、理由を示す。
- 履歴: 運転表示が自前の「現在の画面」と履歴を持つ（`operator/operator-history.ts`。最大50。新しい画面へ移ると進む側を捨て、上限を超えたら古い方から落とす。現在と同じ画面へは積まない）。Designer の `screenId`・選択・画面タブは変えない。
- 配置（`operator/operator-layout.ts` の `operatorLayout`）: ヘッダー・フッターは screenView として埋め込まず、主画面の上下に別の `Renderer` で描く（枠の中の画面切替ボタンを押せる）。幅が違うときはヘッダー・フッターを主画面の幅に合わせて拡大縮小し（縦横比は保つ）、上・主画面・下を縦に並べた全体を窓に収める（contain、中央寄せ）。主画面が変わると枠の高さも変わる。
- 画面切替ボタン: 主画面・ヘッダー・フッターのどれでも、行き先が画面なら履歴に積んで移り、戻る・進むは履歴で移る（動けないときは薄く描き押せない）。現在の画面の強調は 3 つとも運転表示の現在の画面に対して効く（`Renderer` の `currentScreenId`・`navHistory`、`nav-button.ts` の `navButtonAction`）。
- 実データ・模擬・欠測の扱いと、機器を押したときの読取詳細の小窓は、プレビューと同じもの（App の読取の文脈と `PreviewPopups`）を使う。トレンドの履歴の窓は開かない（後続）。
- 表示する画面が Project から無くなったときは「表示する画面が見つかりません」と示す。

部品は `apps/banto-scada/src/lib/operator/OperatorView.svelte`。工程図サンプル（`examples/process.project.json`）に、ヘッダー（画面切替ボタン「循環設備」「戻る」「進む」と時計）・フッター（説明の文字）と `operatorFrame` の例を入れた。

## 試験

`operator-frame.test.ts`、`examples/operator-frame-cases.json`（Rust・TS 共通の契約）、`e2e/operator-frame.spec.ts`。運転表示は `operator/operator-view.test.ts`（履歴・配置・開始画面）、`nav-button.test.ts`（履歴つきの戻る・進む）、`e2e/operator-view.spec.ts`（入口・枠の配置・ヘッダーのボタンで移る・戻る・進む・Designer の画面タブが変わらない・Esc と終了ボタン）。
