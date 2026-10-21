---
title: Dot の委任枠と満杯時の待機運用
tags: [dot, operations, capacity, governance]
last_updated: 2026-10-22
kind: runbook
scope: repository
authority: reference
---

# Dot の委任枠

`max_concurrent_delegations` は各 Dot が保持できる未完了作業と承認待ちの合計である。
Dot の個数、同じ Dot の wake の重複、LLM の同時リクエスト数とは別の設定である。
charter に値がなければ `KYBERION_DOT_MAX_CONCURRENT_DELEGATIONS` を使い、未設定の既定値は **100**。
環境変数の範囲は整数 1〜256。不正値は警告を出して 100 に戻る。
新しいスターターテンプレートはこの既定値を継承する。既存 charter の明示値は変更しない。

```bash
export KYBERION_DOT_MAX_CONCURRENT_DELEGATIONS=100
pnpm kyberion dot status <dot_id> --json
```

常駐プロセスの環境変数は起動時に渡す。設定変更後は通常の運用手順で supervisor を再起動する。
`delegation_capacity` の cap / open / free と、`waiting_on_operator` の request_id を確認する。
承認待ちだけで枠が埋まった場合、人間が元の依頼を判断する。新しい依頼を重複発行しない。

## 既存 Dot の枠を変更する

稼働中の charter を手編集しない。停止は新しい wake を止める操作であり、実行中の外部操作を取り消さない。
変更は draft / paused に限り、プレビューと明示的な適用を分ける。

```bash
pnpm kyberion dot pause <dot_id>
pnpm kyberion dot capacity <dot_id> --limit 100 --json
pnpm kyberion dot capacity <dot_id> --limit 100 --apply --json
pnpm kyberion dot activate <dot_id>
```

インストールの既定値を使う場合は `--limit 100` の代わりに `--inherit` を使う。
適用は charter の編集ロック内で再検証し、変更をライフサイクル監査へ記録する。
操作権限・スコープ・予算・承認条件は変更しない。retired の復活には使えない。

## 満杯時の動作

権限・作業形態が有効でも枠が満杯の提案は `waiting_capacity` として保持する。
これは致命的エラーや承認拒否ではなく、Dot 自体を停止しない。
新たな WorkItem・承認依頼・実行予約・外部操作は作らない。

枠が空くと次の通常 housekeeping が元の提案を再評価する。元の action_ref と提案・スコープ・役割を固定し、
現在の全ての権限・予算・承認ゲートを通す。同じ操作を再送しても二重実行しない。
満杯の間は再試行ループを回さず、同じ待機をエラーとして追記しない。
前面の認証済み要求は元の durable outbox が現在の対応付けと要求を再検証して再開する。
汎用 housekeeping はこの要求の認証を借用しない。

`waiting_for_capacity` と digest に待機を表示する。実際の provider 障害・権限拒否・予算超過は
別の診断として確認する。並行枠を増やすことは、これらの制限の解除ではない。
