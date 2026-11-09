---
title: README
tags: [improvement-plan, 2026-11]
last_updated: 2026-11-10
status: active
---

# コードベース改善計画 2026-11

11月に起案・更新した計画の索引です。ドキュメント構成の正本は[ドキュメント索引](../../documentation-source-map.json)、全体の現況索引は[2026-08 索引](../improvement-plans-2026-08/README.ja.md)です。計画ごとの実装状況は各文書の `status` を正本とします。この索引は `concept-registry` ゲートが「月のフォルダの全計画を参照していること」を検査します。

## 情報資産とスコープ

- [情報資産のスコープモデル（管理・開示・加工）の設計](./INFORMATION_ASSET_SCOPE_MODEL_DESIGN_2026-11-05.ja.md) — planned
- [保存先カタログと許可証による権限判定（tier-guard の再設計）](./STORE_CATALOG_GRANT_GUARD_DESIGN_2026-11-05.ja.md) — planned
- [情報資産カタログ・収集・dots intake 統合実装計画](./INFORMATION_ASSET_INTAKE_IMPLEMENTATION_PLAN_2026-11-02.ja.md) — active

## 概念モデル v2 の移行

決定記録は [Concept Model v2](../../../knowledge/product/architecture/decisions/2026-11-10-concept-model-v2.md) です。依存関係の順に並べています。

1. [スコープ・ID・権限（Grant）の統合計画](./SCOPE_IDENTITY_GRANT_CONSOLIDATION_PLAN_2026-11-10.ja.md) — planned
2. [WorkItem（Issue と子ステップ）と Lease の統合計画](./WORKITEM_ISSUE_LEASE_CONSOLIDATION_PLAN_2026-11-10.ja.md) — planned
3. [意図の解決器の一本化計画](./INTENT_RESOLVER_UNIFICATION_PLAN_2026-11-10.ja.md) — planned
4. [記憶のループを閉じる計画](./MEMORY_LOOP_CLOSURE_PLAN_2026-11-10.ja.md) — planned

## 外部ホスト連携

- [VCS host API seam の設計 (gh CLI 依存の抽象化)](./VCS_HOST_API_SEAM_DESIGN_2026-11-04.ja.md) — completed
