---
title: README
tags: [improvement-plan, 2026-10]
last_updated: 2026-11-09
status: active
---

# コードベース改善計画 2026-10

10月に起案・更新した計画の索引です。ドキュメント構成の正本は[ドキュメント索引](../../documentation-source-map.json)、全体の現況索引は[2026-08 索引](../improvement-plans-2026-08/README.ja.md)です。計画ごとの実装状況は各文書の `status` を正本とします。この索引は `concept-registry` ゲートが「月のフォルダの全計画を参照していること」を検査します。

## 権限・スコープ・承認の統一

- [Scope Governance 統合計画 (SC-01〜09)](./SCOPE_GOVERNANCE_UNIFICATION_PLAN_2026-10-03.ja.md) — active
- [事前許可(同意・承認・egress・OS 許可)の統一 (PG-01〜09)](./PERMISSION_GRANT_UNIFICATION_PLAN_2026-10-19.ja.md) — partial
- [人間承認の信頼性 改善計画 (HA-01〜08)](./HUMAN_APPROVAL_TRUST_PLAN_2026-10-05.ja.md) — partial
- [AI Use Charter — 情報処理境界と自律実行の統合](./AI_USE_CHARTER_PLAN_2026-10-20.ja.md) — active
- [自律実行・委任・承認の整合性レビュー](./AUTONOMY_DELEGATION_REVIEW_2026-10-20.ja.md) — active
- [組織の自律実行・拡張境界の改善](./SCOPED_AUTONOMOUS_LOOP_REVIEW_2026-10-26.ja.md) — active

## 組織ループと顧客との調整

- [Resident dot 自律組織ループ計画 (DL-01〜11)](./DOT_ORG_LOOP_PLAN_2026-10-04.ja.md) — active
- [ask から dots と組織ミッションへの実行経路検証](./ASK_DOT_ORGANIZATION_LOOP_PROBE_2026-10-20.ja.md) — partial
- [顧客との調整事項ヒアリングと決定の計画 (CD-01〜13)](./CUSTOMER_DECISION_HEARING_PLAN_2026-10-24.ja.md) — active

## フロントデスクとサーフェス

- [Front desk 依頼キューと実行結果の反映計画 (FQ-01〜08)](./FRONT_DESK_INTAKE_QUEUE_PLAN_2026-10-05.ja.md) — active
- [Front desk 診断用受付成果物の durable execution 縦切り](./FRONT_DESK_DIAGNOSTIC_EXECUTION_2026-10-05.ja.md) — active
- [診断用受付控えの表示形式フィードバックと不変な新版生成](./FRONT_DESK_RECEIPT_REVISION_2026-10-05.ja.md) — active
- [サーフェスの初回セットアップ](./SURFACE_FIRST_RUN_SETUP_PLAN_2026-10-09.ja.md) — completed
- [Conversation Engine 改良計画](./CONVERSATION_ENGINE_PLAN_2026-10-04.ja.md) — completed

## 整合性・重複・開発フロー

- [Coherence 監査 改善計画](./COHERENCE_AUDIT_PLAN_2026-10-01.ja.md) — active
- [重複概念の切り出し計画 (CX-01〜08)](./CONCEPT_CONSOLIDATION_PLAN_2026-10-21.ja.md) — partial(コード側の重複。文書・用語側は [concept-registry](../../../knowledge/product/governance/concept-registry-workflow.md))
- [全体調査 — 足りないもの・邪魔になった仕組み](./SYSTEM_GAP_AND_LEGACY_SURVEY_2026-10-31.ja.md) — active
- [開発サイクル流量改善計画](./DEV_CYCLE_FLOW_PLAN_2026-10-19.ja.md) — active
- [Pipeline 動作確認インベントリ](./PIPELINE_VERIFICATION_INVENTORY_2026-10-17.ja.md) — active
- [Orphan decisions 2026-10-01](./ORPHAN_DECISIONS_2026-10-01.md) — active

## 依存更新の証跡

- [web-push (concierge PWA)](./LOCKFILE_REVIEW_2026-10-01-web-push.md)
- [依存更新と mammoth 削除 (2026-10-03)](./LOCKFILE_REVIEW_2026-10-03-dependency-upgrades.md)
- [GitHub security alerts (2026-10-10)](./LOCKFILE_REVIEW_2026-10-10-github-security-alerts.md)
- [@simplewebauthn (HA-07)](./LOCKFILE_REVIEW_2026-10-10-simplewebauthn.md)
- [hyperframes 0.8.105 → 0.8.147](./LOCKFILE_REVIEW_2026-10-13-hyperframes-0.8.147.ja.md)
