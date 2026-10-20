# BantoとSCADAのパネル基盤比較

2026-10-21（日本時間）。状態: **比較評価・統合方針の提案**。採用決定・依存更新・アプリ移行は行っていない。今回の比較はパネルの浮動・分割・タブ・保存であり、画面遷移用の`LauncherBar`とは別の対象。

## 結論

**最終的な共通基盤は、Bantoのレイアウトモデル・ツリー演算を土台にすることを推奨する。SCADA側の入力保持・操作取消・作図との排他を共通基盤の受入条件にし、必要な汎用部分をBantoへ統合する。現在の`DockHost`への単純な置換は推奨しない。**

Bantoは、SCADAがまだ持たない分割木・タブグループ・ドロップ領域・ガイド・配置全体のJSON化を持つ。一方、SCADAは同じフォームDOMを保ち、不正な数値文字列・未適用入力・IMEを壊さずに配置する仕組みと、実際の操作取消・保存失敗の保護を持つ。両者の強い部分は異なる。

今回の実験では、Bantoの浮動内移動はフォームを保持したが、浮動からドックへの変更・閉じて再表示・IDでkeyしたタブ内容の切替でフォームが再生成された。SCADAの実`createDraftGuard`を使うと、未適用文字列が初期値へ戻り、dirty登録も消えた。この差を解消してから段階移行する。

## 1. 比較対象と根拠

| 対象               | 固定した版・範囲                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| SCADA              | `e56078ebb70b14b2ca7c8db998493abb31186ac5`。左右浮動、固定幅／下部高さ、入力保護、保存と表示切替                                            |
| Banto              | main `591294bea61c7dcbd0b41102dae57c3bdf0602b8`。`@banto/dock-svelte`の公開APIと実装                                                        |
| ソース取得         | `0287da4352f77e6dec69b7f5f10143e785c88a77`のアーカイブを隔離した実験ディレクトリへ展開。上記mainとの差分にdock-svelteの変更がないことを確認 |
| 既存固定版との関係 | SCADAが使うBanto `1ffe507…`から比較対象まで、dock-svelteの差分はpackage.jsonの版のみ。基盤は今回新たに追加されたものではない                |

主な上流根拠:

- [公開API・純粋演算](https://github.com/tyaro/banto/blob/591294bea61c7dcbd0b41102dae57c3bdf0602b8/packages/dock-svelte/src/index.ts)、[保存型](https://github.com/tyaro/banto/blob/591294bea61c7dcbd0b41102dae57c3bdf0602b8/packages/dock-svelte/src/types.ts)、[DockState](https://github.com/tyaro/banto/blob/591294bea61c7dcbd0b41102dae57c3bdf0602b8/packages/dock-svelte/src/state.svelte.ts)。
- [DockHost](https://github.com/tyaro/banto/blob/591294bea61c7dcbd0b41102dae57c3bdf0602b8/packages/dock-svelte/src/DockHost.svelte)、[DockedTree](https://github.com/tyaro/banto/blob/591294bea61c7dcbd0b41102dae57c3bdf0602b8/packages/dock-svelte/src/DockedTree.svelte)、[DockWindow](https://github.com/tyaro/banto/blob/591294bea61c7dcbd0b41102dae57c3bdf0602b8/packages/dock-svelte/src/DockWindow.svelte)。
- [共通ドラッグ](https://github.com/tyaro/banto/blob/591294bea61c7dcbd0b41102dae57c3bdf0602b8/packages/dock-svelte/src/core/drag.svelte.ts)、[ツリー演算](https://github.com/tyaro/banto/blob/591294bea61c7dcbd0b41102dae57c3bdf0602b8/packages/dock-svelte/src/core/tree.ts)、[幾何](https://github.com/tyaro/banto/blob/591294bea61c7dcbd0b41102dae57c3bdf0602b8/packages/dock-svelte/src/core/geometry.ts)。

SCADAの根拠は[浮動操作controller](../../apps/banto-scada/src/lib/designer/controllers/floating-panel.svelte.ts)、[配置計算](../../apps/banto-scada/src/lib/designer/floating-panel-layout.ts)、[DOM依存のdraft管理](../../apps/banto-scada/src/lib/designer/drafts.svelte.ts)、[既存設計](../sidebar-floating-design.md)を参照する。

## 2. 機能と責務の比較

「アプリ責務」はBantoの不具合を意味しない。汎用レイアウト基盤と、SCADAの作成ツールとしての保護を区別する。

| 観点                   | Banto dock-svelte                                                                        | 現在のSCADA                                                           | 統合時の判断                                     |
| ---------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------ |
| 配置モデル             | 任意ID、Panel／Split／Tabsの再帰木＋浮動配列                                             | `sidebar`／`inspector`の固定／浮動。下部は高さ変更まで                | **Bantoを土台にする**                            |
| 分割・タブ・ドッキング | 上下左右の分割、中央へのタブ追加、ガイドとドロップ判定                                   | 未実装。左3タブは一つの固定DOMコンテナ                                | Bantoの演算を再実装しない                        |
| 浮動サイズ変更         | 8方向。マウス操作の自由度が高い                                                          | 右下ハンドル。固定時の左右／下部divider                               | 8方向はBantoの利点                               |
| 移動中の表示           | 5pxの開始閾値、ghost／guide、release時に配置確定                                         | 内容ごと動く。Esc等で前の希望位置へ戻す                               | UXの選択。優劣と断定せず統一する                 |
| 未適用入力とDOM        | 同じ浮動ノードの移動は保持。ドック／浮動の変更、close、非選択タブの保持APIはない         | 同じaside／form／inputを維持。非表示でもunmountしない                 | **単純置換を止める最重要条件**                   |
| キーボード             | 移動・サイズ変更はpointerのみ。タブ・dividerもSCADA相当の操作は未実装                    | Enter／Space開始、矢印、Shift、確定／取消、Tabで移動                  | SCADAの操作契約を共通化する                      |
| 取消とgesture          | ドック移動はEscでcancel。resize／dividerは逐次stateを変更し、同等のrollbackがない        | Esc、pointercancel、capture喪失、blur、実window寸法変更、上位層で取消 | 共通transactionとcleanupを追加                   |
| pointer所有者          | ドック移動controllerは一つ。resize／divider／開始閾値追跡は別経路                        | 左右の移動／resizeの所有者を一つに管理                                | 全gestureの排他とpointerId照合を統合             |
| 前面化                 | 浮動配列の順序で描画。pointerdownで前面へ                                                | DOM順を変えずz順位を切替。pointerdown／focusin、常設メニューから復帰  | キーボードfocus・上位層の契約を維持              |
| 小さい画面             | min160×120、移動時は48pxの部分可視を許す。既存窓のhost縮小への自動補正は実験で確認できず | min280×240、表示用だけ全枠をclamp。狭幅は一時固定へ退避               | パネル別最小寸法・responsiveはアプリ方針         |
| 配置保存               | layout v2のserialize／hydrate。v1読込あり。open・順序・active tabも含む                  | 個別slot。明示保存のみ。書込成功後に保存済みsnapshot更新              | Bantoモデルを使い、SCADAの保存transactionを維持  |
| 保存値の検証           | 構造の型検査とsplit比率の正規化。既知IDの選別は利用側の責務                              | version、ID、キー、有限値、寸法範囲を検査                             | ID重複・有限値等の共有検証とアプリregistryを追加 |
| 標準配置               | `reset()`は全定義を浮動へ戻す                                                            | 左右固定を標準にする                                                  | アプリの標準layoutを別途定義すればよい           |
| 中央キャンバス         | 全panelに共通のtitlebar・close・drag。公開型にclosable／movable等の能力指定はない        | 中央の図面は閉じられず、作図・pan・DnDを専用管理                      | 中央領域を保護する能力指定／描画境界が必要       |
| レイヤー連携           | package間importなし。独立しているが共通Menu／Modalとの明示的な上位層判定はない           | Bantoのlayering helperと作図操作の取消を接続                          | アプリ状態を渡せる小さな公開hookを検討           |
| OS別窓                 | `onPopOut`で利用側へ通知。OS窓自体は利用側実装                                           | 未実装                                                                | 今回の統合判定から外す                           |

Bantoの「保存」はフォームのdraft保存や永続ストレージへの書込成功を意味しない。close後も保存されるのは窓の矩形等であり、フォーム内容のkeep-aliveとは別である。

## 3. 実験で確認した差

上流ソースを変更せず、独立したVite／Chromiumの最小画面へDockHostを配置した。panel snippetは安定IDでkeyし、SCADAの実`createDraftGuard`を付けた未制御inputを描く。SCADA全体の移植試験ではなく、**現在のフォームをそのまま載せると何が起きるか**を見る試験である。生データは[評価記録JSON](banto-dock-evaluation-2026-10-21.json)。

| 実験                          | 観測結果                                | 意味                                             |
| ----------------------------- | --------------------------------------- | ------------------------------------------------ |
| 浮動の位置変更                | DOM同一、入力保持、dirty=1              | Bantoの全操作で入力が失われるわけではない        |
| 浮動Aをドッキング             | DOMが別、`unsaved`→`committed`、dirty=0 | 旧フォームのdestroyでguard登録も消える           |
| close→open                    | DOMが別、未適用本文が初期値へ、dirty=0  | SCADAの「隠して再表示」と契約が違う              |
| B→C→Bのタブ切替               | BのDOM再生成、未適用本文消失、dirty=0   | inactive paneの内容保持が必要                    |
| resize中にEsc                 | 幅320→390の変更が残る                   | ドック移動のcancelをresize全体へ適用できていない |
| resize中にblurを注入          | blur前340→後390。以後の移動を処理       | blurによる操作終了・取消が不足                   |
| 背面窓のinputへfocus          | focusは移るが浮動順はA,Dのまま          | focusinによる前面化が不足                        |
| drag中に別pointerIdのupを注入 | ghostが消え、X40→41へ確定               | 移動controllerが無関係のreleaseを区別していない  |
| hostを1000pxから400pxへ縮小   | Dの左端452px、host右端413pxで完全にclip | 保存位置を残した表示用補正が必要                 |
| `hydrate`へ不正配置を渡す     | 重複ID、非有限X、幅-1、高さ0を受理      | 保存値の検証を強化する必要がある                 |

タブ試験はIDでkeyした代表的なpanel描画である。keyを外せば全て解決するという意味ではなく、異なるパネルでDOM／ローカル状態を誤って共用させない設計が必要。実OSのIME入力・Windows実機・性能・全consumerの回帰は今回未検証。blurと別pointerIdは合成イベントを使い、handlerの境界を明示的に検証した。

検証範囲:

- Bantoの既存geometry／tree／state／dropzones: **146件成功**。jsdomのDockHost component試験2件はこの実行に含めていない。
- 独立したブラウザ実験: **10ケース**。全ケースでpage errorなし。合格基準を満たしたという意味ではなく、上表の実際の挙動を記録した。
- SCADAの既存配置／所有者単体: **8件成功**。代表ブラウザ: **7件成功**（両テーマの同じDOM・左右draft、capture／blur／resize取消、通知前resize、重なりと前面化）。SCADAの全テストの再実行ではない。
- 保存型やAPIを比べた評価であり、性能優劣や全体移行の工数を計測したものではない。

## 4. 三つの土台案

相対コストは実装範囲による見積で、日数や完了時期の約束ではない。

| 案                                              | 初期のコスト                                         | 完成までのコスト・リスク                                                 | 評価                                                 |
| ----------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------- |
| A. 現在のDockHostへそのまま置換                 | 小〜中。見た目の分割・タブは早く得られる             | **大**。フォーム消失・IME・close／tab切替・gesture取消等を後追い修正する | 最終導入としては非推奨。使い捨ての確認画面だけに限定 |
| B. SCADAに分割木・タブ・snapを独自追加          | **大**。モデル・演算・renderer・hit test・保存を追加 | **大**。Bantoとの二重保守と再統合時の調整が残る                          | 最終的に合わせる方針には不利                         |
| C. Bantoのモデル／演算を土台にSCADA要件を共通化 | 中〜大。先にlifecycle・gesture・公開hook等を整える   | 同じengineを利用でき、長期の重複が最も少ない。既存consumerの回帰が必須   | **推奨**                                             |

Cの途中で「Bantoのpublic model／演算だけ利用し、SCADAのrendererを維持する」試作は可能。ただしrendererを永久に二系統保つと統合の利益が薄くなる。試作の出口条件を先に置き、完成形として固定しない。

## 5. 入力保護もBantoの共通機能にする

**未適用入力の保持・dirty管理・確定／取消・変更前の確認は、Banto側へ集約する。SCADAに汎用入力保護を持ち続けることを完成形にしない。** ただし、すべてをdock-svelteへ入れるのではなく、既存のフォーム機構とパネルの生存期間を連携させる。

### 既存の`@banto/forms`を拡張する

Bantoには既に[FormStore](https://github.com/tyaro/banto/blob/591294bea61c7dcbd0b41102dae57c3bdf0602b8/packages/forms/src/store.svelte.ts)と[guardUnsavedChanges](https://github.com/tyaro/banto/blob/591294bea61c7dcbd0b41102dae57c3bdf0602b8/packages/forms/src/unsavedChanges.svelte.ts)がある。値・dirty・touched・検証エラー・保存成功後の`markClean()`、画面遷移／再読込時の確認、複数guardで確認を一度にする仕組み、保存後の遅延した自動画面遷移を抑える状態を提供する。これを再利用・拡張することを第一候補とする。

ただし既存guardはソースでも **「Confirm, don't restore」** と明記し、draftの復元を提供しない。`beforeNavigate`への接続はドック／タブ操作の確認を自動では扱わない。FormStoreをpaneより長く生存させることはできるが、現在のSCADAのDOM依存フォームをそのまま載せて未適用入力が残るという意味ではない。上のブラウザ実験はSCADA guardの試験であり、`@banto/forms`の回帰試験ではない。

追加する共通契約の候補は、DOMと独立した生の入力文字列・baseline・検証状態の保持、フィールド確定／取消、複数フォームの適用／破棄／キャンセルの調停、カスタムフォームから接続できるadapterである。数値として未完成・不正な入力も失わないことを要件にする。既存19ファイルをすべてschema-drivenなBantoFormへ書き換えることを前提にしない。draftのディスク永続化は別機能であり、今回の入力保護には必須としない。

| 所有する場所                                              | 集約する責務                                                                                                                          | アプリから渡すもの                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Bantoのフォーム共通機構（`@banto/forms`の拡張を第一候補） | 入力文字列・baseline・dirty・検証状態の保持、確定／取消、変更前確認、非同期処理の古い結果を拒否する共通の仕組み、IME／focusの保護契約 | 対象の安定ID・世代、業務上のvalidator、適用／破棄callback、確認文言   |
| `@banto/dock-svelte`                                      | 分割・タブ・配置木、drop演算、幾何検証、gestureの確定／取消、pointer／keyboardとcleanup、paneの生存期間、構造変更前のhook             | 共通フォームguardとの接続、操作可否、パネルの能力・最小寸法・標準配置 |
| SCADA                                                     | Project／画面／機器／選択の意味、対象ID・世代の決定、業務上の検証、コマンド適用・Undo、作図／部品／レイヤーDnDとの排他                | Bantoの公開APIを使い、SCADA固有の処理をcallbackとして提供             |
| SCADAのUI設定adapter                                      | 明示保存・保存失敗時の保持、名前付き配置の製品UI、Projectとは別の設定所有、狭幅退避とcanvas中心保持                                   | Bantoのlayout serialize／hydrateとUI設定ストレージを接続              |

IME変換中のDOM破棄は、文字列を復元するだけでは補えない。DOM維持または変換終了まで構造変更を保留する仕組みをBanto側で扱い、SCADAは対象や画面モードに応じた方針を渡す。フォームの中身やProjectのUndoまでdock-svelteへ入れない。

追加APIの名称・形式とパッケージ境界は提案であり、上流で採用済みではない。共通化は既存SCADA機能の単純な移動ではなく、既存Banto formsとの重複整理と、他のconsumerでも使える契約への抽出を含む。

## 6. 移行前の必須条件と進め方

1. **lifecycle方針を決める。** 持続したpanel hostを使ってDOMを保つ方式か、Banto forms側で保持する外部draft＋再mount方式かを独立試作する。Bantoで内容を再mountするなら、未適用文字列だけでなくbaseline・検証状態・対象世代・選択／scroll／focusも保持する必要がある。`drafts.track`を使うファイルは現時点で19個あり、Inspector一枚の交換では終わらない。
2. **IMEを独立した条件にする。** draftを外部化しても、進行中のOSの変換セッションはDOM再生成で復元できると仮定しない。DOM維持、または変換中の構造変更を保留する契約を選ぶ。通常blurで有効な数値を確定する既存挙動も維持する。
3. **gestureと復帰の共有境界を補う。** resize／dividerも開始前snapshotと確定／取消を持ち、pointerId・primary pointer・上位層・blur／cancel／teardown／native resizeを扱う。共通基盤から作図操作を直接参照せず、hookで排他にする。
4. **中央領域と保存値を保護する。** 必須／閉じられる／移動できるpaneを区別し、既知ID・重複・有限値・範囲・タブとsplitを検証する。アプリ標準配置は固定とし、縮小時に保存希望を上書きしない。
5. **SCADAの実フォームで受入。** 左右に同時draft、不正数値、Text改行、IME、タグ選択、タブ切替、hide／restore、close、dock／undock、保存失敗、狭幅／プレビュー、Menu／Modal、canvasの手動倍率・中心、部品／レイヤーDnDを両テーマで確認する。先に必要なBanto変更を共有基盤へ入れ、公開APIから消費する。
6. **一枚ずつ段階移行する。** draftの少ない下部参照一覧等で実証してから、左作業パネル・Inspector・3タブの個別分離へ広げる。下部でも検索・使用先選択・高さ・close／restoreは検証し、無状態と仮定しない。各段階で戻せるようにする。

保存先はProject外のUI設定なので、現在の個別slotを全体layoutへ統合することは、Project0.32.0の破壊的変更を必須にしない。新しいUI設定versionと明示的な標準復帰を用意すればよく、旧Project互換性の議論と混ぜない。

## 7. 判断のための次の最小区切り

**製品画面を置き換える前に、「Bantoのレイアウト木＋SCADAの一枚の実フォーム」でdock／undock／tab／hideを行い、同じDOMまたは外部draftの契約を証明する。** 先に`@banto/forms`の拡張とdock-svelteのlifecycle連携を共通仕様として整理し、入力保護・操作取消・検証の差を上流issue候補へまとめる。評価後のユーザー指示により、下記の上流Issueを起票した。依存更新・アプリ移行は行っていない。

この受入を満たせるならCを採用する。満たせない場合は現在のSCADAの固定／浮動を維持し、公開APIの整備を待つ。分割・タブが見えることだけをもって移行完了にはしない。

## 8. 上流への引渡し（2026-10-21）

- [Banto #432: formsの入力保持とpane切替前guard](https://github.com/tyaro/banto/issues/432)。既存#214の再起票ではなく、ルーターを通らない切替・draft保持の拡張。
- [Banto #433: gestureの所有者と取消](https://github.com/tyaro/banto/issues/433)。resize／dividerのtransaction、pointer照合、keyboard／focusを共通化。
- [Banto #434: layout復元検証とhost縮小](https://github.com/tyaro/banto/issues/434)。幾何・重複IDと、保存希望を残した到達性を改善。

[再現fixtureと実行手順](banto-dock-fixture/README.md)を保存した。別のBanto checkoutを指定し、元評価と修正後を比較できる。保存したrunnerで10ケースを再実行し、元の観測JSONとの完全一致とpage errorなしを確認した。これは観測fixtureであり、上流実装時に期待値をassertする受入テストへ移す。SCADAのcontroller・単体・ブラウザ試験への固定コミットリンクも各Issueに添付した。

起票前main `55971fba048d4b7d5cfa97af9d0307fc81d989a6`までの追加差分はtheme／LauncherBar関連で、dock-svelte／formsの変更がないことを確認した。上流からSCADAへ依存を作らず、Banto自身のテストへ汎用契約を抽出する。起票は採用・修正完了を示さない。
