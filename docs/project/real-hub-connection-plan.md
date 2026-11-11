# SCADAの実Hub・S7接続計画

作成: 2026-11-05、更新: 2026-11-11（日本時間）。状態: **採用・C0〜C5完了、C6未完了**。[実機接続記録](real-hub-c0.md)と[C5受入記録](real-hub-c5-acceptance.md)を参照。以下の初期前提と工程表は計画策定時の記録である。

## 目的と前提

ユーザーの2026-11-05の申告により、S7 SOAKの連続試験は完了している。SOAK終了待ちを今後の工程の前提から外し、通常アプリで実Hub経由のS7現在値を読取表示することを最初の到達点とする。その後、記録管理・実SQLite保存・履歴検索を接続する。

SOAK完了は上流認証の修正完了やSCADAの接続試験成功を意味しない。認証の利用可能な契約と接続対象はC0で確認する。本計画の作成は、実環境への接続・設定変更・サービス再起動の実施ではない。

現状はProject 0.37.0、DB7、固定SDK `33410f6d25d36559c5ce81375e243eb6f3e85038`、Banto 6.9.0。Rustの読取・catalog・記録・検索部品と通常Appの注入境界はあるが、製品hostと実配送は未完成。記録用の元call配送台帳（prep2d2a）はPR #88でworkへ統合済み（`a23ae4c`）。純粋TS台帳の実装・モック検証までで、実transportやnative接続は未実装。Observationのprep2d2b以降はC4に置き、最初の読取接続の前提にしない。

## 次の着手点

C0でWindowsの既存Hubと認証契約を確定し、C1のTauri host、C2のモック製品経路、C3の実PLC Q/R系現在値を受け入れた。C3では実値`0`／`false`、品質・由来、通常画面と機器小窓、タグ選択、切断・再接続、Project再読込、アプリ再起動を確認した。その後、C4の記録clientとnative bridge、C5の実データの記録・履歴受入も完了した（2026-11-11）。次はC6で、実機側の故障・再起動と連続運用をここの受入条件に残す。

## 実施順と完了条件

| 工程                               | 内容                                                                                                                                                                                                                                                            | 完了条件・成果物                                                                                                                                                                                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C0 接続条件と実行方式の確定        | SOAK後の上流・SDK・Banto認証の現行契約を読み取り確認。対象OS、Hub/API版、既存サービスの有無、接続先、読取対象タグ、資格情報の供給方式を確定する。採用済みのserver core＋埋込host 1に沿い、shellとIPCを決定する。Tauriは候補として既存資産・配布要件を照合する。 | 依存版差分、接続構成、権限、設定保存・秘密情報の管理、起動・終了の責任を設計書に記録。SDK更新が必要なら互換性と回帰を確認した版を固定する。実装見積り・PR分割を確定する。                                                                                           |
| C1 最小hostと読取接続の実装        | UIと独立したRust側ownerにSDK、ReadHost、CatalogHostを保持。接続設定をProject外へ置き、認可済みの配送経路を用意する。通常起動から既存ReadSource／CatalogSourceへ接続し、接続・切断・接続先切替を提供する。                                                       | 通常entrypointでモックHubの数値Text・機器number/bool・タグ選択が動く。資格情報がProject・ブラウザstorage・DTO・ログへ漏れない。要求0件、host起動失敗・終了、既存サービスとの二重owner防止を検証する。                                                               |
| C2 読取経路の通し検証              | 実製品と同じhost／IPCでモックHubから通常UIまで試験する。Project置換、旧通知、Bad／Stale、Unbound、Unauthorized、切断・再接続を確認する。                                                                                                                        | 切断・権限喪失・Project置換時に旧値を消し、新しい購読開始に対応する通知だけを表示する。catalog失敗時にサンプルへ置換しない。対象OSで起動・終了と再起動を含めて成功する。                                                                                            |
| C3 実Hub経由の初回読取受入         | C0で確定した対象Hubと既存S7タグに接続する。数値・bool、0・false、Quality、タグ選択、通常画面と機器小窓を照合する。                                                                                                                                              | Hubの観測値と画面表示が一致し、SIMと実機由来を区別できる。SCADA側の切断・再接続、Project再読込、アプリ再起動を受け入れる。実機側の故障・再起動を伴う試験は対象設備の条件を別途確定してから行う。ここを「初回実機読取接続完了」とする。                              |
| C4 記録clientとnative bridgeの完成 | d2a／d2b台帳とlocal-v2正常返信配送に続き、独立coordinator-v2で元返信・結果知識・個別transport attemptを分ける。GUI非依存のnative registry adapterを実ownerへ接続し、principal／epoch、実clockとlease、元返信、取消・再照会と物理完了を対応付ける。              | モックHub＋一時DBで、返信喪失・切断・late reply・世代交代・容量不足・複数caller競合を通し検証。受付不明から二重applyせず、結果表示だけで物理枠を解放しない。製品の初回設定に必要なmapping登録・initialIdle開始・fresh SDK解決・明示resumeの範囲も定めて実装する。   |
| C5 実データの記録・履歴受入        | 実Hubを専用SDK ownerで読み、専用の検証用SQLiteへ単一groupで記録する。HistoryHostを既存履歴画面・保存Trendへ接続する。DB identityとnamespace／系列対応を検証する。                                                                                               | UIを閉じてもhost processが生きている間は記録が継続する。停止・join・明示再開、raw／minmax、欠測・Quality・SIM、再起動後の状態照会を確認する。検証済みの保持容量に収まる実時間試験を行い、時刻・件数・欠測・DB増分を記録する。仮想時間試験だけで実時間受入としない。 |
| C6 連続運用とリリース判断          | 対象タグ数・周期・運転時間から保存量と台帳上限を評価し、実媒体・時計異常・容量不足・復旧・保持を検証する。監視再開、運用時ユーザー管理と操作認可、配布・更新・停止手順を揃える。                                                                                | 運用目標時間内の容量と障害時の挙動を実測し、起動・終了・復旧手順を記録する。必要なGC／世代退役・自動保持・サービスhostを要件に応じて追加する。合格した構成・運転時間に限って運用可能と判断する。                                                                    |

依存関係は `C0 → C1 → C2 → C3 → C4 → C5 → C6` を基本とする。C4の純粋な設計・台帳実装は独立に進められるが、C3の完了を妨げる前提にはしない。読取transportへ記録用wire全体の完成を要求しない。

## 各工程の実装上の判断

- 認証はSCADA独自方式を新設せず、上流の利用可能なAPIを採用する。SOAK完了だけで認証延期が解除されたとは扱わず、C0で現行契約を確認して再開可否を確定する。初回読取に必要な認証と、運用時の管理者・ユーザー管理を分けて設計する。
- アプリshellはC0で選定する。採用済みのcore／host境界を維持し、追加の警報・Actionエンジンを初回読取接続の前提にしない。既存サービスへの接続失敗で別coreを自動起動しない。
- SDKが所有する接続・再接続・Quality判定をSCADAへ複製しない。SCADAはProject／接続先／画面deliveryの寿命と旧通知拒否を管理する。
- 現receiverのsnapshot64件／8MiB、call8MiBなどは有限停止するモデルであり、長時間運転の実績ではない。C4で検証時間と資源上限を定め、C6までに継続利用可能な容量・退役方式を閉じる。上限だけを根拠なく引き上げない。
- host process終了後も記録を継続する要件は、埋込hostだけでは満たせない。Windowsサービス等の追加hostは、その運用要件が必要な時点で別工程として設計する。

## PRの区切りと検証

計画採用時の文書変更に続き、C0〜C3を段階ごとのPRと[実機接続記録](real-hub-c0.md)で受け入れた。今回のC3最終確認ではQ/R系の実値`0`／`false`と製品表示を追加照合した。運用時のユーザー管理・認証、記録配送と長時間運転は完了扱いしない。

C4はd2a、d2b、local-v2、[coordinator-v2](../design/runtime/historian-recording-coordinator-v2.md)のtest-only root（PR #100〜#104）と、GUI非依存の[native registry adapter](../design/runtime/historian-recording-native-registry-adapter.md)の段階配送（PR #105〜#118）まで統合済み。残りはadapter内のObservation・cancel・失効・shutdownと一貫受入、認証・host gate、製品transportの境界で分割する（[開発計画](development-plan.md#次の実装順)）。着手時に進行中の実装・マージ状況を確認し、完了済みの作業を重複実装しない。C5のHistory配送も記録操作bridgeとは別の責務で検証する。C5の製品host（C5-1〜C5-5b）は実装済みで、Windows実機の受入は[C5-6受入手順](real-hub-c5-acceptance.md)で行う。

コード変更に応じてRustのfmt／Clippy／workspace test、TSの型検査／unit／build、通常entrypointを通るブラウザ試験、全体整形を実施する。各PRでpush／PR CIを確認する。実機検証は対象・構成版・時刻・結果・未確認事項を記録し、秘密情報は保存しない。マージ後は統合済み枝・生成物・一時ファイルを復元可能性を確認して整理する。

## 初回接続までに含めない機能

PLC書込み機能、警報ACK、常時Action、複数group記録、常時inlineグラフ、Windowsサービス化、上流への共通部品還元は、それぞれの受入を持つ後続工程とする。C3ではユーザー許可による限定書込みと元値復旧を別途確認したが、製品の書込み機能や運用可能性の受入ではない。

## 根拠

- [現在の開発計画](development-plan.md)
- [実装状況](implementation-status.md)
- [P3bの配送・接続条件](../design/runtime/transport-boundary.md)
- [アクセス方針](../design/runtime/access-policy.md)
- [core／hostと記録wire](../design/runtime/historian-recording-wire-host.md)
- [表示・client接続境界](../design/runtime/historian-recording-wire-client-boundary.md)
- [元call配送台帳](../design/runtime/historian-recording-wire-delivery-ledger.md)
