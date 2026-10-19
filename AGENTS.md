# temp-scada の作業指針

このクラウドタスクは既に隔離されています。既存の `/workspace/temp-scada` を使い、ユーザーが求めない限り Git worktree を作成しないでください。

最初に README.md と docs/development-plan.md を読み、現在の実装と上流設計の構想を区別してください。docs/upstream/industrial は出典付きの参照スナップショットです。ここを編集せず、差分は docs/development-plan.md に記録します。

保守性・AIコーディング向けの構造整理には [リファクタリング実行計画](docs/maintenance-refactoring-plan.md) を使います。開始時の実装状況を確認し、R0から順に、責務・不変条件・関連テスト・完了条件を各区切りで記録してください。文書の作成はリファクタ完了を意味しません。

industrial へ戻せるよう apps/banto-scada と crates/scada-* の配置を維持します。Hub / 共通ライブラリを複製せず、必要になったとき固定コミット依存で利用します。PLC への直接接続は作りません。

クラウドのシェルでは scripts/cloud-env.sh を source してから README の検証コマンドを使います。新しい機能は対応する契約テストとブラウザ検証で確認し、Markdown / TS / Svelte / JSON は pnpm exec prettier --write <変更ファイル>、Rust は cargo fmt --all で整形してください。

アプリ基盤は Banto v6.7.0 の公開パッケージを使います。独自の認証・テーマ・汎用 UI を重複実装する前に既存 API を確認してください。運用時の認証方針は docs/access-policy.md を参照。ems-apps の画面・コード・アセットは取り込みません。検証が通った機能の区切りで、日本語の Conventional Commits 形式でコミットしてセーブします。

認証は industrial 側で修正中のため実装・接続を延期します（2026-10-18 ユーザー指示）。ローカル編集はログイン不要のままにし、工程図・設備シンボルの編集を優先してください。認証を再開するときは上流の最新契約を確認します。

2026-10-18 の開発方針: 画面配置は UX 設計の方向で進め、サイド / 下部パネルのフローティング・ドッキングは機能が揃ってから検討します。領域ごとの責務分離は先に行い、ドッキング基盤を先行実装しません。リリース前の Project ファイルは後方互換性を保証しません。必要な破壊的モデル変更を優先し、旧形式の読込・移行実装を必須にしないでください。変更後の現行形式について Rust / TypeScript / サンプル / 検証を揃えることは維持します。

2026-10-18 同日後続の UI 改訂は `docs/designer-ui-revision.md` に採用候補として整理しています。UI 改修時は同文書と既存 UX 設計を読み、明るい専用 shell・左3タブ・可動パネル・タグ選択・メニューバーの提案と、現行アプリで実装済みの機能を区別してください。Banto 基盤は維持しますが、Designer の見た目を標準管理画面へ固定しません。今回の文書更新はアプリの実装・採用完了を示しません。

2026-10-18 同日後続のユーザー確認により、`docs/scada-integrated-design.md` を今後の設計・実装の基準設計書として採用しました。UI 改訂提案と既存 UX 設計は詳細操作・設計根拠として併読し、実装済み・未実装・未決事項と提供段階を区別してください。S9b（scada-server core + host 1）は Core v1 の server 基盤で、その上に v1.1 の Alarm / 常時 Event・Action / History・Trend を追加します。
