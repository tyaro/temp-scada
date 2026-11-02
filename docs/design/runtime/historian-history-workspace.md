# Historian H4b2: 通常Appの履歴トレンド入口と明示検索workspace

2026-11-02（日本時間）。状態: **Astra 主設計の採用契約。下記のローカル実装・受入済み**。[H4b1配送と表示](historian-history-presentation.md)、[H4a HistoryHost](historian-history-host.md)、[P5責務境界](historian-trend-contract.md)を前提とする。

## 今回ユーザーに提供するもの

通常Appの「表示→履歴トレンド」からBanto Modalを開き、明示したUTC範囲・Historian系列・raw／minmax・点数予算で検索できる入口を追加する。edit／previewのどちらでも、既存のmodal／操作確認と競合しない時に使える。menuを隠した場合の既存代替入口にも同じactionを使う。

既定のAppはHistory service未接続であり、入口を無効化して隠すのではなく、ダイアログに未接続を表示する。demo系列、架空DB、Hub catalogからの自動ID対応は追加しない。検証時は通常Appにinprocess serviceを注入し、fixture専用画面だけで完了としない。

Project保存形式、Trend shape／widget配置、recording plan配布、実transport／認証／HTTP、liveとのmergeは対象外。通常mainは実接続を作らず、SDK／Project／Banto versionと依存を維持する。試験はlocal fixtureのみで、実Hub／S7／DB／設定／資格情報へ接続しない。

## optional HistoryService

AppにoptionalなhistoryService propを追加する。既存readSource／catalogSourceとは別であり、UI読取購読やHub tag catalogをHistory系列として流用しない。

```ts
interface HistoryService {
  source: HistorySource;
  context: unknown;
}
interface HistoryContext {
  version: 1;
  kind: "historyContext";
  contextId: string;
  projectId: string;
  projectRevision: number;
  series: { seriesId: string; label: string }[];
}
```

これはinprocessの選択用snapshotであり、完成したHistory Catalog API／認証token／記録計画ではない。callerがHistorianのopaque seriesIdを明示的に対応付ける。externalName、SDK StableTagId、tag_key、Project equipment IDをseriesIdへ自動変換しない。

contextIdとseriesIdはH1と同じASCII ID制約（1..64、先頭英数字、許可文字は英数字と`.` `_` `:` `-`）を使う。seriesは最大256件、seriesId一意、labelは最大512 codepointsの空でない文字列。series0件は有効な空一覧である。projectId／projectRevisionは現在Project manifestと完全一致を要求し、revisionは非負safe整数とする。未知fieldと不正primitiveを拒否する。

context全体は1MiB以下のJSON、depth／node等はH4b1 ownHistoryJsonの有限予算を共有する。getter／cycle／custom prototypeを評価・保持せず、owned snapshotを検証してfreezeする。source関数自体はJSONへserializeしない。contextやsourceを更新するcallerは新しいHistoryService objectを渡す。渡したobjectを後からmutationして所有済み選択一覧を変える契約にはしない。

一覧のlabelは選択用表示だけである。unit／source／型／過去名称はquery応答のsegment metadataを権威とし、一覧に重複した値を作らない。seriesIdは非表示の名前推測値ではなく必要なら補足表示でき、同名labelの複数系列も別選択として区別する。

## workspace寿命と応答退役

App内に一つのhistory workspace ownerを置き、H4b1 controllerをModalの外で保持する。Modalを閉じるたびにcontrollerを作り直さない。下位sourceがAbortを無視した場合も、旧Promise settleまでactive枠を保持し、新要求との物理並列増殖を防ぐためである。

ownerは現在Project object、workspaceGeneration、historyService identity、検証済みcontextを捕捉する。projectId／revisionの一致だけでは、同ID／revisionの別ファイル置換を見分けられないため、このlocal寿命判定を併用する。現在との一致を受理時・表示時・取得時に確認し、Svelte effectが次に走るまで旧結果を一瞬再利用しない。

次の場合に選択・表示結果・論理requestをclearし、activeへAbortを要求する。

- dialog close。
- Projectファイル／sample／newへの置換、または編集によりProject objectが変わった時。
- service objectの差替え、未接続への変更、context不正／Project不一致。
- 検索formの系列／UTC範囲／mode／点数を変更した時。

form変更でsource.queryを自動発行しない。旧formの結果を新しいformの結果として表示しない。Projectが変わった場合はdialogを閉じるか、表示を即clearして再確認状態にし、旧選択を新Projectへ持ち越さない。

H4b1のcancelは完了済み結果にNoOpである。clear用途ではcancelだけに頼らず、setSource(undefined)で旧token／結果を退役させ、必要に応じて現在sourceを再bindする。これでもactive slotは旧Promise settleまで残る。共用controllerへ同じ退役処理を持つ明示resetを追加する方法も許容するが、controller再生成で資源終了を偽装しない。

App全体のunmountではdisposeする。下位Promiseのsettleがcleanup完了を意味するHistorySource契約は変えない。App破棄で実queryのhard停止を保証したとはしない。

## ダイアログの操作

Banto Modalの既存open／onclose、focus制御、既存theme tokenを使用する。読み取り機能なのでProjectのdirty state、Undo履歴、作図選択、保存データを変更しない。検索formはdialog内の一時状態で、localStorageやProjectへ保存しない。

ダイアログには以下を持つ。

- 接続状態とcontext不一致／不正／空一覧の説明。
- 提供されたseries一覧の検索とcheckbox選択。選択数0は取得不可、最大8。
- 開始UTC／終了UTCの明示入力。
- raw／minmaxのmode選択。
- maxPointsPerSeriesの整数入力。
- 「取得」「取消」「閉じる」。取得中もform更新による最新pendingへの差替えはH4b1上限内で可能。
- 既存TrendViewと、1時間／系列数／点数予算に関する簡潔な説明。

offline／invalid contextでは検索を発行せず、系列をサンプルで埋めない。contextが有効でも空一覧なら「検索できる履歴系列が提供されていません」と説明する。default未接続を読み取りerrorと混同しない。

初期UTC入力は空欄とする。信頼できるserver clockをまだ受け取っていないため、勝手に「最新1時間」を検索しない。mode=raw、点数=100などの表示操作の初期値は採用できるが、保持期間や記録周期の製品defaultではない。初期系列を黙って全選択して自動取得しない。

## UTCとH1 queryの生成

入力はUTCであることが明示されたISO形式を使う。例は `2026-11-02T00:00:00.000Z`。timezoneを付けないdatetime-localや端末local timezoneの自動解釈を採用しない。表示placeholderと説明にZ／UTCを示す。

四桁年の年月日時分秒・必要なら3桁millisecondという限定文法を検証し、Date変換後のUTC表現とのround tripで存在しない日付、24時、繰上げを拒否する。単にDate.parseが有限だから受理、とはしない。to>from、to−from<=3_600_000msの半開[from,to)とする。

選択IDは検証済みcontext一覧のsubsetだけを受け付ける。query内では安定した一覧順を使う等、順序を明示的に固定する。maxPointsPerSeriesは1..2000の整数、選択数×点数<=8000。8系列で2000点の要求を黙って送らず、form上で予算不整合を示す。上限を越えた要求を勝手に期間短縮／点数切捨てで別要求へ変えない。

requestIdはdialog／workspace内の要求を区別できるH1許可文字のopaque IDとして生成する。秘密情報・外部名を埋め込まない。H4b1のrequest token／source identity照合も維持するため、H1 requestIdだけに寿命判定を依存しない。

取得直前にH1 parseでquery全文を検証し、既存controllerへloadする。formの独自validatorは操作上の説明とUTC変換を担い、History queryの意味検査を置き換えない。入力不正時はsourceを呼ばず、具体的に直すべき項目を表示する。

## 表示とエラー

H4b1のraw点、minmax範囲、bool離散、segment別lane、coverage別帯をそのまま使う。現在の選択一覧と応答が違う名前／unitを持っていても、過去metadataを最新一覧で上書きしない。unknownSeriesは一覧snapshotが古い等の可能性を示すが、勝手に新しいIDを推測して再検索しない。

partial／unavailable／invalid response／source error／cancelled／waitingを区別する。tooManyPointsなら期間短縮またはminmax選択を案内するが、自動mode変更しない。rawエラー本文、endpoint、DB path、資格情報は表示しない。

取得済み結果に対する遅延取消はH4b1どおりNoOp。閉じる・form変更・context変更は別の明示clear操作であり、過去グラフを消す。結果がまだ無ければ「未取得」と表示し、値ゼロや空履歴を描かない。

## 受入

- 通常Appの表示menuから履歴ダイアログを開け、既定未接続でも入口が見つかる。検索が発生せず、demo系列や偽の記録結果が出ない。
- テストentryでAppへHistoryServiceだけを注入し、通常menu／Modal／formからcaller割当seriesIdを検索してTrendViewへ表示する。fixture専用mountを使わない。
- contextの不正ID、未知field、重複series、過大一覧／label／body、accessor、Project不一致を拒否し、元context mutationで選択一覧が変わらない。
- UTC日付不正、local timezone表記、逆区間／1時間超、系列未選択／9系列、点数非整数／予算超過を送信前に拒否する。0件一覧は正常なempty状態として説明する。
- raw／minmax切替、部分結果、unknownSeries、tooManyPoints案内、取消、再取得を通常App内で確認する。
- close→reopen、同ID／revisionのProject置換、編集、service差替え、form変更後に遅れた旧応答が表示されない。
- Abort無視sourceのactive一件を保持し、dialogを何度開閉しても並列readが増えない。旧Promise終了後に最新pendingだけが実行される。
- 通常のProject書出し、dirty／Undo、作図選択に影響せず、通常mainが実transportやSDKを開始しない。
- light／darkとkeyboard focus／closeを確認し、未接続説明と取得ボタンの有効条件が一致する。

この工程で通常Appの明示History検索入口を完成対象とする。実Historian catalogの取得API、service接続の配布、製品権限、正式transport、Trend shapeの永続設定、liveとのhandoffは後続に残す。

## 実装・受入結果（2026-11-02）

通常Appのoptional HistoryServiceと共通menu action、永続ownerのHistoryWorkspace、純粋workspace-modelを追加した。H1 schemaそのものは変更せずID定義とquery validatorを共有する。初期UTCは空、modeはraw・点数100、取得は明示操作だけとした。Banto Modalのfocus trap／close／復帰先を使い、履歴表示中は背後のeditor shortcutを遮断する。

TS全体1,482件（新規39件）、型検査0error／0warning、build、関連Chromium32件（新規8件）が成功した。通常Appの未接続入口、両テーマ、検索とform編集によるclear、context所有／不正／Project不一致／空、旧source／旧Project、close-reopen中のactive一枠、取消、Project保存不変を確認した。Astra最終read-onlyレビューに必須修正はない。全体CIはPRで確認する。

これはinprocess呼出しと明示検索の受入であり、通常mainにserviceを自動作成せず、browserから実HistoryHost／SQLiteへの接続はまだない。元contextの確保済みメモリやProxy trapのhard実行予算を保証するものでもない。後続の永続Trend定義では、opaque系列参照を保存することと実接続先で解決できることを分けて設計する。
