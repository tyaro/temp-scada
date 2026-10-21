# bool slotの状態判定と動的配色への接続

状態: **型付き表示結果とboolの純粋な状態判定を実装。図形への配色・保存・編集UIは次工程**。2026-10-20。[統合設計](../scada-integrated-design.md)に従い、[読取DTOの受入](read-slot-presentation.md)の後段を整える。Projectは0.25.0、Rust／wire schema／固定SDKは変更しない。

## 今回実装した境界

`SlotPresentation`はGoodの場合だけ`value: { type: "bool", value: boolean } | { type: "number", value: number }`を持つ。Goodにはprovenanceも必須とし、値なしGoodを汎用の欠測factoryから作れない型にする。非Goodは値を持たない。sessionから返すvalueとprovenanceはコピーであり、呼出元の変更が受理済みframeへ伝播しない。

`lib/slot-presentation.ts`の`boolSlotState(display)`は、解決済み表示結果だけを入力として次を返す。Project・機器・session・Hubを読み直さず、世代や割付の照合を複製しない。

| 入力                                 | bool状態  | 理由／Quality                       |
| ------------------------------------ | --------- | ----------------------------------- |
| Good bool true                       | `true`    | Good                                |
| Good bool false                      | `false`   | Good                                |
| Good number（0／1を含む）            | `unknown` | 理由はtypeMismatch、元QualityはGood |
| 未関連付け／slot不足／型不一致       | `unknown` | 個々の理由を保持                    |
| 未採用／未割付／未接続／未解決／不正 | `unknown` | 個々の理由を保持                    |
| Bad／Stale                           | `unknown` | 元Qualityと由来を保持、値なし       |

表示文字の`true`や`SIM`を解析しない。boolへ数値・文字列を変換せず、falseを欠測にしない。内部の誤ったGood値もunknownへ倒すが、公開wireの不正入力検証を置き換えるものではない。trueを運転・正常、falseを停止・故障と決めつけない。意味付けは後続の作成設定が所有する。

SIMは真偽と独立した由来である。simulation／derived_simulation、またはall_simulation modeなら、true・false・unknownのいずれにも`SIM ·`を付ける。Bad／Staleでも維持する。切断・世代失効・不正payloadによる表示は、既存sessionの処理によって旧値と旧由来が消える。

有効なDTOが返すinvalidの`reason`も保持する。現在のTextは、読み上げ・tooltip・`data-tag-reason`へ理由コードを表示し、復帰時に消す。たとえばdisabledなら本文は`-- · 値が不正`、詳細には`disabled`を付ける。文字列をHTMLとして挿入しない。表示理由の日本語説明一覧は後続。

`boolSlotState()`は次工程用の純粋なAPIで、通常Designerの配色にはまだ接続していない。今回の見た目の変更はinvalidの詳細説明のみ。既存の静的色とText本文は維持する。通常Designerは実Host未接続のまま。

## 次工程の実装順と受入条件

1. **保存宣言と参照管理**: まず共有Symbol内の子図形について、boolのslot名とtrue／false／unknownの配色を保存する。具体的なfield・対象図形・塗りと線の適用範囲をTS／Rustの共通schemaで確定する。宣言変更・削除の使用判定をText以外にも拡張し、hidden／locked参照も保護する。clipboard単体搬出の依存検査とUndoも同じ区切りで対応する。
2. **描画**: `resolveSymbolSlot()`→`boolSlotState()`→配色の順に接続する。unknownをfalse色や静的な正常色へ戻さない。定義編集・thumbnailには機器contextがないためunknownとする。メイン・埋込・小窓・minimapで同じ規則を使う。
3. **編集UIと実画面**: bool宣言からの選択、状態別色・意味の設定、未知時の表示を設ける。共有定義色／配置の単色モードとの優先関係を明示する。色だけに依存せず状態・取得不能理由・SIMを読み取れる表示を用意し、両テーマの実画面で確認する。
4. **Host／Faceplate**: 実catalog・SDKの前提を満たした後、同じ型付き結果を使う。取得接続・認証・操作要求を配色判定へ混ぜない。

初回から多条件式・複数slotの優先順位・数値範囲・任意アニメーションを一緒に実装しない。初回のbool表示の契約を固めた後、統合設計の共通式評価に接続する。新しい式言語やPLC直接接続は作らない。

既存のgradient／pattern／αや単色モードと動的色の組合せには、上書き対象を曖昧にしない設計が必要。初回は対象を限定して実装できるが、保存済み設定を黙って無視する実装にはしない。unknownを識別できない設定・描画は受入不可とする。

## 検証

`slot-presentation.test.ts`は、表示文字と真偽が矛盾していても型付き値だけを使うこと、false／true、数値の0／1・負数・小数、全取得不能状態、6種のsourceと2種のmode、Bad／StaleのSIMと由来コピー、不正な内部値を確認する。

`read-slot-session.test.ts`はRust共通fixtureの型付き値・invalid理由・非Goodで値がないこと、返却値変更によるframe汚染の防止、旧frameと不正入力のunknown化も確認する。`e2e/read-slot-session.spec.ts`は、同じmountのメイン・埋込・小窓でinvalid理由が表示され、Good復帰時に理由が消え、他slotが影響を受けないことを両テーマで確認する。

Astraの静的レビューを実施。製品コードの必須修正なし。追加E2Eの余分な引数を修正し、両テーマの関連2件が成功した。最終検証結果は[実装状況](../../project/implementation-status.md)へ記録する。

後続の0.26.0で[bool Textの状態別文字色](../graphics/bool-text-colors.md)へ接続した。色だけのランプを先行させず、状態・理由・SIMを文字で維持する初回範囲とした。矩形・楕円・配管の動的配色は引き続き後続。
