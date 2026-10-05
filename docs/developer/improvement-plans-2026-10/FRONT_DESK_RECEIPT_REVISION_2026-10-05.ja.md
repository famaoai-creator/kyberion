---
title: '診断用受付控えの表示形式フィードバックと不変な新版生成'
tags: [front-desk, conversation, artifacts, revision, approval, verification]
last_updated: 2026-10-05
status: active
---

# 受付控えの表示形式フィードバック → 新版生成

## 対象

この実装は #933 の public 入力限定の診断用受付控えに対し、JSON の compact / readable 表示形式を変更する最初の縦断導線です。文章・資料の内容修正、Pads の編集・連携、任意のフィードバックによるプロンプト生成、一般 mission の再実行は対象外です。既定の execution mapping は空のままで、運用環境への設定や承認は追加しません。

## 操作と API

Concierge の検証済み受付控えメッセージから表示形式の変更を選び、形式を指定して新版作成を要求します。既存の認証済み message API に artifactRevision（requestId、revision、sha256、format）を送ります。Presence の会話 API も同じ構造化入力を検証します。Presence の画面には新しい操作を追加しません。

対象はサーバー側の会話領域に保存された request / version / SHA-256 です。Chronos の artifact_id を持つと偽装せず、クライアントからのファイル path、principal、tier や承認済みフラグを受け入れません。履歴の版情報は選択用の不活性なデータであり、承認ではありません。

## 改訂の流れ

1. サーバーの viewer scope と現在の mapping の下で、完了済み親版の出力を再検証する。
2. 同じ会話ロック内で親版に対する子要求を一つだけ予約する。親要求・結果は変更しない。
3. 親 request ID / revision / digest と選択形式を、新しい request digest と WorkItem に束縛する。
4. 既存の durable intake / dot execution 経路で、新しい scoped human approval を求める。旧版の承認を流用しない。
5. 実行前と公開直前に現在の権限・mapping・親版の検証状態を再確認する。
6. 新しい request ID と revision の別パスに出力し、期待する完全なバイト列と digest を検証する。既存パスに異なる内容がある場合は上書きしない。
7. 元の会話の履歴・状態更新で検証済み新版を返す。push 通知は追加しない。

## 回復と制限

- 同じ request ID と完全に同じ入力の再送は、既存受付を返し、新しい実行を作らない。
- 同じ親版への別の同時要求、古い版、digest 不一致、未知・未検証の結果は拒否する。
- 子要求が予約された親版からは分岐を作らない。却下後も既存の予約は履歴に残し、勝手に再生成しない。
- 実行結果が不明な場合は隔離を維持する。報告の欠落・履歴の再取得は再実行の理由にならない。
- 改訂を含む会話は transcript v4 として保存する。旧 v3 writer は解釈できない版を拒否し、親子関係を消して書き戻せない。
- 改訂は既存の最大 64 要求枠を一件ずつ使う。旧版は同じ領域に残る。
- これはアプリケーションの版ごとの上書き防止であり、OS 管理者によるファイル変更を防ぐ WORM ストレージではない。変更されたバイト列は再検証で検出する。

## 既存モデルとの関係

Chronos の request-changes は mission review re-entry と連携しますが、版レコード作成は同じ物理 path を継承します。この診断パイプラインの改訂ではその関数を呼ばず、既存の会話受付・承認・実行・報告モデルを再利用します。汎用の成果物レビューや再生成が完成したとは扱いません。
