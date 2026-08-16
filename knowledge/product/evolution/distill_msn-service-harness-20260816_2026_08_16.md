---
title: '自己記述・計画・検証を備えたService Harness契約'
category: Evolution
tags: ['code-change', 'service-actuator', 'TypeScript', 'contract-testing', 'service-harness']
importance: 5
source_mission: MSN-SERVICE-HARNESS-20260816
author: Kyberion Wisdom Distiller
last_updated: 2026-08-16
---

# 自己記述・計画・検証を備えたService Harness契約

## Summary

Service actuatorへ型付きoperation契約とdescribe、plan、receipt、verificationのライフサイクルを導入し、既存presetおよびoperation registryへ接続した。Focused tests、typecheck、lint、package/actuator builds、catalog/op-registry検証は通過したが、ミッションは意図ドリフトにより再整合中である。

## Key Learnings

- 外部CLIの概念は特定の実行プロバイダーへ結合せず、型付きpreset schemaと共通harness lifecycleとして抽象化すると既存actuatorへ安全に統合できる。
- describeとplanを実行前、receiptとverificationを実行後の標準契約にすると、operationの自己記述性、事前確認、監査可能性を一つの境界で扱える。
- 全体contract checkが既存fixtureで失敗しても、focused contract testsとtypecheck・lint・段階的buildを組み合わせれば、新規変更と既存不整合を切り分けられる。

## Patterns Discovered

- Typed preset schema → service-harness core → HARNESS mode → operation registryという層別接続は、既存preset互換性を保ちながら新しい実行ライフサイクルを追加する再利用可能な統合パターンである。
- 実装直後の意図ドリフト判定は、成果物の技術的成功とミッション目標への適合を別々に検証する必要性を示す。

## Failures & Recoveries

- Intent drift score 0.7が閾値0.6を超えて進行が停止 → REALIGNへ移行して目標との整合を再確認中。回復完了の証拠はまだない。
- 全体contract checkが既存desktop-recording fixture不整合で保留 → focused 17 tests、typecheck、lint、build:packages、build:actuators、catalog/op-registry検証で今回の変更範囲を独立確認した。

## Reusable Artifacts

- Service Harness改善計画書
- Typed service preset schema
- describe/plan/receipt/verificationを実装するservice-harness core
- HARNESS execution modeとoperation registry接続
- Focused service harness contract test suite

---

_Distilled by Kyberion | Mission: MSN-SERVICE-HARNESS-20260816 | 2026-08-16_
