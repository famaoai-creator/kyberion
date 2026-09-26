---
title: メモリとナレッジのコンテキスト・アダプタモデル
tags: [memory, knowledge, context, adapter, promotion, tiering]
last_updated: 2026-09-26
---

# メモリとナレッジのコンテキスト・アダプタモデル

メモリとナレッジは同じデータとして扱わない。メモリは作業中の揮発的な状態、ナレッジは承認と provenance を持つ長期参照資産である。

```text
capture → normalize → scope/tier 判定 → store → recall
→ promotion proposal → approval → publish → verify → archive/forget
```

`KnowledgeContext` は保存先を持たず、目的、tier、tenant、provenance、retention、`training_use` を表す。保存先や同期先は `KnowledgeAdapter` の capability として登録する。actuator や workflow は adapter 名で分岐せず、`capture`、`recall`、`proposePromotion`、`publish`、`archive`、`forget` の capability を呼び出す。

既存の `working-memory-actuator` は揮発メモリ、`memory-promotion-queue` は昇格候補、`KnowledgeProvider` は scoped read、Cowork bridge は外部同期を担当する。これらを一度に置き換えず、共通 context と adapter seam に段階的に接続する。

personal / confidential から public への昇格には、provenance、redaction、承認を要求する。`training_use` の既定値は `local_only` とし、外部送信を許す場合だけ明示的に上げる。
