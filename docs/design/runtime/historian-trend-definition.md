# Historian H4c: 永続Trend定義と画面からの履歴表示

2026-11-02（日本時間）。**Astra主設計の採用契約。H4c1とH4c2の独立契約・Project 0.36.0保存・静的参照shapeはローカル実装・受入済み。context v2・保存presetからの履歴取得は未実装。** H4b2まではProject 0.35.0の通常Appから明示検索できる。[現在のworkspace](historian-history-workspace.md)、[配送と描画](historian-history-presentation.md)、[P5](historian-trend-contract.md)を前提とする。

## 採用する最初の利用経路

Projectに保存したTrendを画面へ配置し、表示プレビューで「履歴を開く」を選ぶと、既存の履歴workspaceへペン・期間・モード・予算を読み込む。利用者が終了UTCを入力して「取得」を押した時だけ検索する。画面を表示しただけでは検索しない。

初回のTrend shapeは履歴ダイアログへの入口であり、画面内に常時更新するグラフではない。SVG上にはタイトルと「履歴を開く」を描き、サンプル波形・ゼロ・過去の別要求の値を描かない。実際のraw点・minmax包絡は共通TrendViewで表示する。複数配置から同じ一つのworkspaceへ入る方式を選び、配置ごとにcontroller／HistoryReaderを増やさない。

この区切りは、保存できる参照と実接続先で解決できる参照を分離しながら、作図→保存→再読込→履歴表示を完成させる。inline複数chart、周期更新、最新時刻の自動選択、liveとの接続、長期検索は今回の実装工程に含めない。transport／認証／実source adapter、SDK、Banto、Historian DB/H1形式は変更しない。実Hub／S7／実DB／設定／資格情報へ接続しない。

## 現行実装からの制約

- [Project型・検証](../../../apps/banto-scada/src/lib/project.ts)は共有[JSON Schema](../../../crates/scada-model/schema/project.schema.json)と追加意味検査を使う。nativeの[scada-model](../../../crates/scada-model/src/lib.rs)も同じProjectを検証する。現行shapeにTrendはない。
- [Renderer](../../../apps/banto-scada/src/lib/Renderer.svelte)は配置・選択・変形を扱い、[ObjectPainting](../../../apps/banto-scada/src/lib/ObjectPainting.svelte)はSVG描画を共有する。[ScreenView](../../../apps/banto-scada/src/lib/ScreenView.svelte)はpointer-eventsを無効にした一段の埋込表示である。埋込から新たなqueryを起こす設計に変えない。
- [HistoryWorkspace](../../../apps/banto-scada/src/lib/history/HistoryWorkspace.svelte)はApp寿命の一つのcontrollerを持つ。closeしても未終了Promiseの物理枠を保持する。現在のHistoryContext v1にはHistorian namespaceがなく、contextIdは一覧snapshotの識別だけである。
- 現在のTrendViewは系列を選んでsegment別に描く。複数単位の重ね描きや任意軸はない。[ChronoGazer調査](../../reviews/chronogazer-historian-reuse.md)の等間隔x／中点線の制約に合わせて意味を削らず、必要な共通表示をSCADA側で追加して後日還元する。

## H4c1: 独立した保存契約

最初の実装PRはProjectをまだ変更せず、次の独立JSONをRust／TSで同一に検証する純粋契約とする。

```ts
interface TrendDefinitions {
  version: 1;
  kind: "trendDefinitions";
  definitions: TrendDefinition[];
}
interface TrendDefinition {
  id: string;
  name: string;
  historianNamespace: string;
  pens: TrendPen[];
  windowMs: number;
  mode: "raw" | "minmax";
  maxPointsPerSeries: number;
}
interface TrendPen {
  id: string;
  seriesId: string;
  label?: string;
  color: string;
}
```

共有Schemaの配置は `crates/scada-model/schema/trend-definition.schema.json`、共通fixtureは `examples/trend-definition-cases.json` とする。既存H1 IDの許可文字・長さを共用し、正規表現のRust／JS差で末尾改行を受け付けない。新しいSDK／DB依存をmodelへ追加しない。TSはowned JSONを検証し、nativeは同じSchemaと意味検査を通す。後続Project schemaからdefinitionの同じ定義を参照し、別仕様を複製しない。

| 項目                                     | 決定                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| definitions                              | 0..128件、idは全体で一意                                                                   |
| id／pen.id／seriesId／historianNamespace | H1 IDと同じ1..64 ASCII制約                                                                 |
| name／任意label                          | 1..512 Unicode codepoints、空白だけを拒否                                                  |
| pens                                     | 1..8件、配列順が表示順、pen.idとseriesIdは定義内でそれぞれ一意                             |
| color                                    | `#`＋6桁hexの不透明sRGB。大文字小文字は受理して保持。CSS任意文字列／透明度／gradientは不可 |
| windowMs                                 | 整数1..3,600,000ms                                                                         |
| maxPointsPerSeries                       | 整数1..2000、pens.lengthとの積が8000以下                                                   |
| JSON                                     | 独立文書1MiB以下、未知fieldを拒否、H4b1と同じdepth32／node250,000上限、finite値のみ        |

definition.idの一意性poolはそのProjectのtrends配列（独立契約ではdefinitions配列）だけとする。既存object／asset／screen等のUUID poolとの交差重複は拒否しない。pen.idは所属definition内だけで一意とする。trendIdはこの専用poolを参照し、他種の同名IDを解決候補にしない。

name／labelの「空白だけ」は両言語で同一の明示集合を使う。集合はU+0009..U+000D、U+0020、U+0085、U+00A0、U+1680、U+2000..U+200A、U+2028、U+2029、U+202F、U+205F、U+3000、U+FEFFとする。全codepointがこの集合に属する文字列を拒否し、JS trim／Rust trimの結果へ依存しない。受理した文字列の前後空白は保存時に除去しない。すべてのJSON文字列で孤立surrogate（U+D800..U+DFFFの非対）を禁止し、正しいsurrogate pairは1 Unicode codepointとして数える。H4c1の共通fixtureにFEFF／0085だけ、両者と可視文字の混在、512個の補助平面文字、孤立high／low surrogateを含める。nativeでJSON decode時に拒否する場合とTSで意味検査時に拒否する場合は内部段階が異なってよいが、公開契約の受理／不受理を一致させる。

定義内で同じseriesを二つのペンにしない。一つのseriesを別Trendから参照すること、同じlabel／色を使うことは許す。ペン削除・並べ替え後も残るpen.idは維持する。外部名や配列indexからseriesIdを生成しない。

独立文書の1MiBは、有効な値のnumberを整数JSON表記へ正規化したcompact UTF-8 JSONのbyte数とする。`1.0`／`1e0`は`1`、`-0`は`0`としてサイズを数える。受理したValue自体は書き換えない。これは構造化入力の値予算であり、元wireの空白・escape・数字の綴りを含む入力byte数を測るAPIではない。無効payloadの内部拒否段階の一致は要求せず、最終の受理／不受理を言語間で揃える。

定義は描画と要求の設定だけである。記録周期／保持日数／SIM記録方針／収集source／credential／DB pathを含めない。Trendの作成・削除・非表示・window変更では記録計画も保持設定も変わらない。

## namespaceと解決

永続参照のキーは `(historianNamespace, seriesId)` である。namespaceはdeployment／callerが割り当てる不透明な履歴データ集合の識別で、Hub名・URL・SDK ID・contextId・Project IDではない。別namespaceの同じseriesIdは別物であり、ラベルが一致しても解決しない。

これはcallerの宣言を照合する契約である。実DB identityの検証、認証、namespaceの世界的一意性を実装済みとはしない。別環境やDB再作成で系列継続性が保証できなければ、新namespaceを割り当てる。古いnamespaceの再利用により系列が同一であると製品が保証したことにしない。正式adapterは将来この宣言を実接続先へ結び付ける責任を持つ。

H4c3でHistoryContext **v2** を追加する。v1のfieldsに必須 `historianNamespace` を加え、versionを2とする。sourceは同じHistoryService内に一つだけとし、このnamespaceのseriesIdsを解決する責任を持つ。1サービスが複数namespaceを暗黙routingしない。

- v1はH4b2の手動検索用として引き続き受理する。保存presetには使用せず「この接続は保存Trendの系列対応を提供していません」と説明する。
- v2でもProject ID／revision、service identityとcontextの予算・所有規則はv1と同じ。contextIdをnamespaceへ読み替えない。
- presetのnamespaceとv2が一致し、全pen.seriesIdが一覧に存在する時だけ取得できる。欠けたペンだけ黙って落として検索しない。
- 一覧にはあるがHistory応答がunknownSeriesの場合、既存部分結果をそのまま表示する。namespace一致はrecorded／retained／availableの証明ではない。
- 不一致・未接続でもProjectは正当な保存物である。読込を拒否せず未解決理由とopaque参照を示す。別環境への対応付けは明示的な定義編集であり、自動推測やnamespaceの書換えはしない。

接続情報はProjectへ保存しない。Projectを編集してrevisionが進んだらcallerが更新contextを供給するまで既存の不一致gateを維持する。定義を追加したからといってworkspaceがcontextのprojectRevisionを勝手に追従させない。

## 時間・モード・表示

保存するwindowMsは検索幅であり、保持durationではない。終了UTCは利用者が毎回明示する。`toMs`をH4b2のcanonical UTC入力から解釈し、`fromMs = toMs - windowMs` をsafe整数として検査する。計算後の開始時刻も四桁年canonical UTC表現に往復できることを要求する。safe範囲外、Date範囲外、四桁年の範囲外、期間不正なら取得不可とし、clamp／負期間の反転／local timezone補正をしない。epoch以前の負timestamp自体は有効なUTC年で表現できれば許す。

定義を開いた直後は終了UTC空欄で未取得。開始UTCは計算結果として示し、取得時には完成したH1 query全文を検証する。requestIdは実行ごとに新しくし、保存しない。ペンの配列順をquery.seriesIdsへ使う。

preset中の色・別名・期間・mode・予算は保存定義から読む。終了UTC以外の定義設定を変える操作は編集UIへ分離する。任意検索に切り替える場合はpresetを明示解除し、結果をclearする。取得結果を維持したまま別定義の色や凡例を後付けしない。

単位・型・source・過去名は応答segmentが権威である。初回はsegment別の自動軸、boolは0/1離散、rawは点のみ、minmaxは独立包絡とする。unit override、換算式、固定y範囲、左右複数軸、別単位を同じ軸へ重ねる設定は保存しない。複数penでも初回は既存TrendViewの系列選択を維持する。

H4c3でTrendViewへ検証済みのpen presentation（seriesId、任意label、color）を渡す入口を追加する。色は点／包絡／系列の印に使い、Quality・欠測の意味を色だけで表さない。凡例はaliasと元series／segment情報を区別して示す。同じseriesの複数segmentに同じpen色を使ってもlaneは統合しない。新しい応答のseriesIdにない色をindexで割り当てない。既存手動検索は従来のtheme色で動作する。

## H4c2: Projectと配置

Projectへoptional `trends: TrendDefinition[]` を追加し、省略は空一覧と解釈する。配列要素はH4c1の共通契約を使用する。新しいlayout shapeは `{ type: "trend", trendId: string }` とし、既存のid／x／y／width／height／rotation／opacity／order／folder／visible／lockedを利用する。独自のネットワーク設定やpen複製をshapeへ持たせない。

この変更時にschemaVersion／minRuntimeVersionを **0.36.0** へ更新する。design-onlyとH4c1では0.35.0を維持する。H4c2ではnative／TS／共通schema／examples／書出し／既存legacy変換の出力versionを同じPRで揃える。0.35.0からの自動migrationは今回追加せず、非対応versionとして明示拒否する。既存legacy入口の対応範囲を黙って拡張しない。

全trendIdは同Projectの定義へ解決できなければProject不正とする。一方、外部Historianへの解決はProject validatorに要求しない。未使用定義は許可する。定義の参照を残した削除は拒否し、配置削除は定義を自動GCしない。定義編集は共有参照先全配置へ反映する。別設定を作る操作では新しいdefinition.idとpen.idを採番するが、namespace／seriesIdはコピーした参照を保持する。

初回はScreenだけに配置し、Symbol定義へのTrend配置をTS／native意味検査と編集commandの両方で禁止する。機器slotやSymbolの繰返しから系列を組み立てる契約は未導入である。Symbolへ変換・貼付する時にTrendだけを黙って落とさず、その操作を拒否する。

H4c2の段階では定義名と静的カードを見て配置・編集・保存できるが、カードから検索や履歴グラフ表示はできない。カードには「履歴表示は準備中」と示し、開くactionをまだ有効にしない。この未実装状態を「履歴未接続」と呼ばない。H4c3でactionを有効化した後に初めて、未接続／namespace不一致／系列未解決を実際のservice状態に従って区別する。H4b2の手動履歴検索は各段階で引き続き利用できる。

描画は共通SVGの静的カードとする。主画面の表示プレビュー／独立Popupでだけ明示actionをAppのworkspaceへ配送する。editでは通常の選択・resize・移動を優先し、Inspectorの「履歴を開く」で同じ入口を使えるようにする。埋込ScreenView、ミニマップ、SVG出力／印刷用描画は静的カードのみで、pointer-eventsや取得ownerを追加しない。独立Popupと埋込画面は別の表示役割として検査する。回転／clip／opacityは既存layoutと同じで、foreignObjectへHTMLグラフを埋めない。

## コピー・Undoと編集の原子性

同Project内の配置複製は新object.idを採番し、trendIdは共有参照として保持する。ここで同Projectとは現在の編集owner内での操作であり、外部clipboardに書かれたprojectId／revision一致だけでは判定しない。画面複製・幾何group化でも参照を変えない。定義作成と最初の配置追加、定義複製と参照付替えは一つの編集transaction／Undo単位にする。途中だけを保存可能にせず、失敗したcommandでは旧ProjectとUndoを維持する。

H4c2ではTrendを含むsystem clipboardのcopy／cut／pasteを、同じ編集ownerからの操作を含めて一律に明示拒否する。直選択だけでなく、埋込参照の依存screen内にTrendがある場合も操作全体を拒否する。cutはコピー成功前に配置を削除せず、pasteは資産取込やProject変更の前に拒否する。同Project内のCtrl+D／配列複製／画面複製はclipboardを経由しない編集commandとして許し、trendIdを維持する。既存clipboardのorigin／projectId一致だけで許可しない。これらは外部payloadにも載るため、現ownerで発行したことの証明にはならない。

外部clipboard／他Projectからの貼付は、定義原本付き搬送と衝突remapを実装するまでTrendを含む操作全体を明示拒否する。同じtrendIdがたまたま宛先にあることを同一定義の証拠にしない。既存clipboardに原本を追加する時は、持ち込んだ全定義の検証→ID衝突の新ID割当→配置参照付替えを原子的に行う。この高度なimportは初回H4c2の完了条件にせず、拒否の回帰を必須とする。Project全体の保存／読込は定義を含めて往復できる。

editorのdefault作成時に架空seriesを作らない。最初の定義は利用者の明示namespace／seriesId入力、またはv2 contextからの選択でのみ完成できる。未完成draftはProjectへ入れず、確定時に共通validatorを通す。

## 要求の有限性と寿命

配置数は既存Project／expanded placement予算に含める。配置の見える数によってqueryを増やさない。Appに一つのworkspace/controllerを保持し、常にactive Promise最大1、pending最新1、H1 query最大8系列／8000点／1時間のままとする。すべてのPopupからもこのownerへ委譲する。新しいModalや画面ごとにcontrollerを作って旧query資源を忘れない。

presetを開くcommandはProject object／workspaceGeneration／definition.id／開いた回ごとのtokenを持ち、現在Projectから定義を再取得して検証する。同じdefinitionを再度開いても新しいopen tokenで前の結果と入力をclearする。保存定義だけを捕捉した旧callbackで検索しない。

close、別preset、手動検索への切替、Project編集／差替え、service差替え、終了UTC変更、元Popup終了では論理要求を退役し旧結果を即隠す。元画面を離れた場合もその画面起点presetを閉じる。Abortを無視するsourceのPromiseはsettleまでactive枠に残す。取得画面が閉じてもrecorderには停止を要求しない。元配置の削除・定義編集・UndoでProject objectが変われば、編集前の要求結果を新配置へ流用しない。

source v1/v2、namespace、選択context、定義snapshotとquery全体の一致を配送と描画に使う。追加のnamespaceはHistory H1のfieldへ混入させず、サービスownerの境界として保持する。履歴応答自身にnamespaceがないため、異なる接続先の応答をtokenだけでなくservice/owner境界で拒否する。

## 実装PRの順序と受入

| 区切り                   | 完了対象                                                                   | 受入                                                                                                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 設計（PR #38）           | この採用契約と工程表                                                       | 現行実装との区別、未接続／意味／寿命／version境界をレビュー                                                                                                                              |
| H4c1（ローカル受入済み） | 独立TrendDefinitions schema、native／TS純粋validator、共通fixtures         | 0/128定義、8pen、重複ID/series、同series別namespace、文字数、色、1h/8000点、unsafe値、未知field、JSON上限、Rust/TS一致。Project0.35.0へまだ組み込まない                                  |
| H4c2（ローカル受入済み） | Project0.36.0、参照shape、原子的編集、SVGカード、保存／Undo／同Project複製 | 全言語parse/roundtrip、欠落参照・Symbol配置・外部clipboard拒否、未接続でも正当な保存、画像/接続線/埋込/Popup/回転/選択の既存回帰。カードは「履歴表示は準備中」と表示して検索を発行しない |
| H4c3                     | context v2、namespace照合、定義preset→既存workspace、色と凡例、画面action  | 通常Appで保存定義からraw/minmaxを明示取得。v1手動維持、別namespace同ID拒否、部分未解決拒否、unknownSeries応答、UTC算術端、service/定義/画面/Popup寿命、複数配置でもactive1、両theme      |

H4c2で「Trend表示完成」とはしない。H4c3で保存定義からの履歴表示までが完成し、画面内常時グラフは別工程である。inline化を再開する時は、同時可視instance数、全体points/bytes、要求fairness、取消中資源、hidden/embedded/Popupの需要集約を先に決める。今回の単一workspace予算を無条件に各shapeへ複製しない。

次の上流接続工程は、namespaceを実Historianへ結び付けるadapterと製品transport／認証の再開条件を満たした後である。保存Trendを導入しても製品接続・常時収集・長期検索・認証が完成したとはしない。

## H4c1の実装と受入（2026-11-02）

[共通Schema](../../../crates/scada-model/schema/trend-definition.schema.json)にH1 canonical resourceへの外部参照を置き、Rust／TSとも同梱resourceをローカル登録する。nativeは未登録resourceの取得を拒否し、TSは同期compileでネットワークloaderを持たない。H1のID正規表現を複製せず、modelへの新しいSDK／DB依存も追加していない。

Rustの`scada_model::trend_definitions::validate_trend_definitions(&Value)`は構造化値を有限走査・Schema・意味検査へ通し、`TrendDefinitions::from_value`は検証した値を所有する。`as_value`は共有参照だけを返す。TSの`validateTrendDefinitions`は受理bool、`parseTrendDefinitions`は所有・凍結したsnapshotを返す。名前・色の表記・ペン順は保存し、余白除去やID生成・系列解決を行わない。TSは既存`ownHistoryJson`を使い、不正scalarの検査を新validator内に限定した。

[共通fixture](../../../examples/trend-definition-cases.json)85件でRust／TS／browserの受理結果が一致した。大きい定義は小さいrecipeから展開し、1MiBちょうど／1byte超過、nativeのfloat表記でも同じ境界、128定義・8pen、重複・別namespace、ID末尾改行、FEFF／0085、512補助平面文字、孤立surrogateの境界を含む。raw JSON文字列fixtureによりnativeのdecode拒否とTSのscalar拒否を比較する。

Rust workspace388件（新規4単体）、TS全体1,578件（新規96件）、型検査0error／0warning、build、Clippy `-D warnings`／rustfmt、関連Chromium16件（新規2件）が成功。browserはremote schema取得なし・所有／凍結・Project0.35で未導入trendsを拒否することも確認した。Astra最終レビューに必須修正はない。全体CIはPRで確認する。

H4c1は独立した表示定義契約だけで、Project 0.35.0・App／main・DB format 5・H1・SDK／Banto依存は維持する。新APIの受理はnamespaceやseriesの実在・記録・権限の証明ではない。元inputの確保済みメモリやProxy trapのhard実行予算も保証しない。次のH4c2ではProject側へTrend／H1 resourceを登録し、Schema参照だけで完了とせず、`trends`を同じ独立文書wrapperで意味検査・1MiB予算へ通す。参照存在・Symbol禁止はProject全体の追加検査とする。

## H4c2の実装と受入（2026-11-02）

Project 0.36.0のtrends／参照shape、同じH4c1 resourceと意味検査・wrapper予算、native／TS参照整合性を実装した。通常AppでBanto Modalの定義管理、save-trend原子的編集、参照切替・独立コピー・未使用削除を提供する。全SVG投影へreadonly metadataだけを渡し、静的カードにquery／source／controllerを持たせない。system clipboardはTrend依存を含む全操作を拒否し、Ctrl+D／配列／画面複製を使う。

管理ModalはProject ownerと世代・画面を捕捉し、入替後のcallbackを受理しない。definition.name／pen.label／色の表記と順序を維持する。InspectorはtrendIdのmodel baselineを登録し、配置直後の未変更formがdirtyにならない。未保存draftでのEscapeと背後shortcutを遮断する。

共通Project18ケース・新規TS26件／native1件・関連Chromium47件（通常Appの新規6件）で、原子保存と失敗時不変、一括Undo／Redo、旧版拒否、参照整合／Symbol禁止、予算、共有更新／独立化、clipboard、所有者変更、全SVG表示先・両テーマを確認した。Rust全389件、TS全1,604件、型検査／build／Clippy／rustfmt成功。Astra最終レビューに必須修正はない。モード変更で既存Popupを閉じる振る舞いは維持し、再openで新定義名を反映する。全体CIはPRで確認する。

0.35.0自動移行は追加していない。通常mainの実接続、H1・DB format 5・SDK／Banto固定依存は維持する。H4c3でnamespace付きcontext v2と保存presetを接続し、単一workspaceとactive一枠の寿命を維持する。保存と配置の受入は、実データ集合や系列の解決・記録・認証の保証ではない。
