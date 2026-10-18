# temp-scada の作業指針

このクラウドタスクは既に隔離されています。既存の `/workspace/temp-scada` を使い、ユーザーが求めない限り Git worktree を作成しないでください。

最初に README.md と docs/development-plan.md を読み、現在の実装と上流設計の構想を区別してください。docs/upstream/industrial は出典付きの参照スナップショットです。ここを編集せず、差分は docs/development-plan.md に記録します。

industrial へ戻せるよう apps/banto-scada と crates/scada-* の配置を維持します。Hub / 共通ライブラリを複製せず、必要になったとき固定コミット依存で利用します。PLC への直接接続は作りません。

クラウドのシェルでは scripts/cloud-env.sh を source してから README の検証コマンドを使います。新しい機能は対応する契約テストとブラウザ検証で確認し、Markdown / TS / Svelte / JSON は pnpm exec prettier --write <変更ファイル>、Rust は cargo fmt --all で整形してください。
