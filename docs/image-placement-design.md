# 画面へ配置するImageの最初の範囲

2026-10-20、Astraの読取専用レビューを反映。**Project 0.17.0で最小範囲を実装済み**。[画像資産と背景](image-assets-design.md)を再利用し、原本を複製しない。

## 配置と見え方

画面直置きの静止PNG／JPEGだけを対象にする。初期入口はファイルメニュー「画像を配置」。Symbol内部はUI・編集コマンド・JSON・Rustの全てで禁止する。原本名・表示寸法をInspectorで確認し、配置名は原本名から独立して変更できる。

初期配置は元画像を拡大せず、画面内で見えている範囲の80%以内へ比率を保持して縮小し、その中心へ置く。見える範囲と画面が重ならない場合は画面中心を使い、配置が見えるようにする。非同期処理の開始時に所有画面と配置範囲を固定し、後から別の画面へ配置しない。

Image枠のfitはcontainを既定とする。枠の幅／高さを変えても画像を歪ませず、余白を含む枠を選択領域とする。回転中心・整列・描画外形も枠基準。cover／stretchを追加する場合は意味を明示する。

「元比率へ戻す」は枠の幅を基準に高さを変更し、枠の中心と回転角を保持する。元の画素サイズへ戻す操作とは区別する。位置・回転・サイズ・配置opacity・順序・lock／visible・複製・Undoへ接続する。ImageではRGB・色α・Symbol配色を出さず、原本と配置opacityを使う。

## 原本と参照

背景＋複数Imageが同じasset IDを共有できるようにする。Project検証、未使用宣言の除去、保存、削除、画面複製の参照集計を全てImageへ拡張する。最後の現在参照を外してもUndo／Redoの原本を維持する。Imageを含むProjectは画像同梱packageで保存し、原本・参照・設定を別環境へ復元する。

## 初期の対象外と明示拒否

Imageを含むRGB一括編集は、非画像だけを部分適用せず全体を理由付きで拒否する。Imageを含むcopy／cut／pasteは、依存原本を運べるclipboardを実装するまで理由付きで拒否し、clipboard書込み・削除の前に判定する。背景付きProjectでも、画像以外の配置だけなら従来clipboardを使えるようにする。

画像の差替え、OS画像clipboard、トリミング、Symbol内Image、外部URL、SVG、アニメーションは別工程。この最小範囲を画像clipboardまで完成した状態として説明しない。

## 受入

背景＋複数Imageの共有→順番に削除→Undo、移動／回転／枠resize、contain余白の選択、元比率復帰の中心保持、原本名と配置名の独立、lock／hidden、両テーマ・表示プレビュー・ミニマップ、別環境へのpackage往復を確認する。画像混在の色・clipboard拒否が部分変更しないこと、取込中に共有定義や別画面へ切り替えて戻っても依頼が復活しないことを確認する。

## 保存契約と現行実装

画面のLayoutObjectに`shape: { type: "image", assetId, fit: "contain" }`を追加した。幅・高さ・回転・opacity・name・folderId・lock／visible・orderは既存の配置属性を使う。共通基底の`fill`は予約値として保存するが画像には使わず、Imageの`colorAlpha`はschemaで拒否する。Symbol定義内のImageもschemaから拒否し、編集コマンドにも同じ保護を置く。

現在参照の収集を背景とImageで共通化し、Rustの検証も揃えた。画像同梱ZIPのprofile名は`banto-scada.image-project` version 1へ更新した。0.16.0と旧背景profileは自動移行しない。リリース前の互換性は保証しない方針を維持する。

実装・検証記録は[開発計画](development-plan.md#image-placement-progress)を参照。OS画像clipboardは[第1段階](image-clipboard-design.md)で追加した。依存原本付きコピー／貼付・画像差替え・cover／stretch・トリミングは後続。
