# 型付き読取結果の受入とSymbol表示

状態: **表示用DTOの受入・世代管理とGood／Quality／由来表示を実装、実Host未接続**。2026-10-20、Projectは0.25.0のまま。[共有Symbolの読取slot](symbol-read-slots.md)の次工程。[統合設計](scada-integrated-design.md)と[Rust読取adapter](typed-read-slots-design.md)の境界をつなぐ。

## 提供範囲

Rustの`ReadSlotView`を受け取る純粋なTS側sessionと、受理結果からTextを描画する経路を追加した。接続・認証・再試行・catalog取得・Stale判定を実装したものではない。通常のDesignerには取得元がないため、割付済みslotは引き続き未接続になる。現在の動作確認はRust共通fixtureとブラウザ内のテスト入力で行う。実設備の値を表示できる状態ではない。

Project・保存schema・現行サンプル形式・固定SDK revは変更しない。値・Quality・provenance・ローカル世代・frameはProjectやUndo、clipboardへ入れない。共有定義が機器固有の外部名を持たないことも維持する。

## Sessionと再描画

`createReadSlotSession(project)`は呼出元のProjectを同一性確認用に保持し、検証済みコピーから採用read slotのplanを作る。Project ID／revisionが同じ別ファイルも同一視しない。

- `generation`はローカルのopaque token。JSON側から指定・復元しない。
- `receive(token, payload)`は同期的に全件検証し、`{ accepted, frame }`を返す。旧tokenは現在値を壊さず無視し、現在のframeを返す。現在tokenの不正入力は割付済み読取結果をinvalidへ置換し、直前の値を保持しない。
- `reset(project)`は新tokenと未接続frameを返す。Projectや購読元を置き換える際に使う。新Projectの検証に失敗すれば例外となり、元のsessionを維持する。失敗したProjectへ画面だけを切り替えない。
- `equipmentReadContext(currentProject, frame)`で描画用contextを作る。Projectのobject identity・ID／revision、最新token／publicationを照合し、失効frame・別Projectでは未接続を返す。

将来のHostは受信・resetの返すframeを必ずreactiveな状態へ格納し、currentProjectとframeからcontext propを作り直す。resolverの内部状態だけを変えて再描画を期待しない。受信は一つの更新列として順に渡す。同一token内の非同期処理の並べ替えを検出するsequenceや、Hostのネットワーク／task管理は今回提供しない。購読元の置き換えはresetで世代を分ける。SDKの接続状態が非Liveになった通知では値を消し、同じ更新列から再度Liveになる場合も新しい有効結果が必要。

frameは不透明で不変。planは所有コピー、受理行も所有コピーとし、受理後のpayload変更や返却provenanceの変更で次の表示が変わらないようにする。旧frameとのmergeはしない。

## 検証する内容

`crates/scada-runtime/schema/read-slot-view.schema.json`はProjectと独立した表示DTOの共通schema。AJVで構造・既知enum・必須項目・余分な値を検証した後、次を照合する。

| 対象         | 受入条件                                                                                |
| ------------ | --------------------------------------------------------------------------------------- |
| Project      | 現sessionのID／revisionと一致                                                           |
| slot結果     | 全採用slotについてちょうど1行。構造化した機器ID／slot名で照合し、追加・不足・重複を拒否 |
| 割付         | 行のexpectedType・externalNameが現在planと一致                                          |
| 未割付       | unassigned、provenanceなし                                                              |
| 非Live       | metadataReady=false、割付済みはdisconnected、値・provenanceなし                         |
| resolved     | LiveかつmetadataReady=true、provenanceあり                                              |
| Good         | 期待するbool／numberと一致し、numberは有限。falseと0を欠測にしない                      |
| Bad／Stale   | value=null。直前値や保持payloadを表示しない                                             |
| その他の状態 | provenanceなし。Liveの割付済みをunassigned／disconnectedへ丸めない                      |
| metadata     | resolved行間でcatalogRevision／runId／collectionModeが一致                              |

catalogRevision／runId／sourceTimestampMsはJS safe integer範囲に限定し、範囲外を拒否する。Rustのu64／i64全域をJSON numberで正確に扱えるという契約にはしない。測定値自体は有限f64を保ち、再丸め・再スケーリングを行わない。

sourceは`real/simulation/computed/derived_simulation/internal/db`、modeは`configured/all_simulation`を保持する。`configured`を実値専用と解釈せず、正常なsimulationを拒否しない。catalog・sourceの元照合はRustが行い、TSでHubの型解決を複製しない。未知source／modeは受入拒否。

## 表示と由来

保存側の宣言 → 機器関連付け → slot存在・型 → 採用 → 割付の確認を優先し、受信失敗で未採用・未割付をinvalidへ変更しない。一つの不成立TextでSymbol全体を消さない。

Goodのboolは`true/false`、numberは数値を表示する。操作・正常／異常の意味付けや動的色には変換しない。Bad／Stale・未解決・不正・切断では値の代わりに状態を表示する。

simulation／derived_simulation由来、またはall_simulation modeの表示は`SIM ·`を付ける。Bad／Staleでも由来を保持する。source・mode・catalog revision・run ID・source timestampはTextのtooltip／アクセシブル名とdata属性にも残す。切断・reset・不正入力でprovenance属性も消す。将来の式評価用データとは分離し、値を落とす表示DTOを式の唯一の入力にはしない。

## 検証

`examples/read-slot-view-cases.json`の16ケースをRustの実投影からserializeし、JSON schemaと一致確認する。TSは同じ結果をsessionへ受け入れ、表示文字とprovenanceを確認する。false／0・負数・Stale／Bad・未解決・metadata欠落・切断・6種のsource・simulationを含む。Rustの0.0とJSONの0は数値として正規化して比較する。

TSの追加検証は不正DTO、plan・型・外部名、重複／不足、metadata世代、safe integer、受理後の変更、旧token・旧frame、同ID／revisionの別Projectを対象とする。ブラウザは同じmountを保ち、メイン・埋込画面・読取小窓に対してGood→Quality劣化／切断／不正入力／resetを切り替える。新しいframeをpropへ反映し、文字とprovenanceが更新・消去されることを確認する。

最終ローカル検証は型0エラー／0警告、TS800件、Rust46件、Clippy・Rust fmt、本番build・全体Prettierが成功。既存ブラウザ25件と追加2件を確認し、追加テストは依存を再生成した状態でも両テーマ通過した。初回の開発サーバー再読込はAJVのimport表記を既存の`.js`付きへ揃えて解消し、リトライ・timeout・assertionの緩和はしていない。Astraの静的レビューで必須修正指摘なし。全体CIはPush後に確認する。

## 後続

実HostのSDK更新・対応catalogの受信、購読generationとframeのreactiveな配布は後続。SDKの前提は[industrial #682](https://github.com/tyaro/banto-industrial/issues/682)。正式Runtime・実Tag Browser・設備Faceplate・動的配色・認証は完成扱いしない。宣言の自由編集・改名／削除も独立した後続工程。
