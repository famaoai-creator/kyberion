---
title: インシデント重大度モデル (Incident Severity Model)
category: Operations
tags: [operations, incident, severity, sev, escalation, on-call]
importance: 8
author: Ecosystem Architect
last_updated: 2026-07-08
---

# インシデント重大度モデル (Incident Severity Model)

`incident-response` ワークフローのトリアージ・フェーズ(`SEVERITY_GATE`)で用いる、一般化された重大度定義。顧客固有の SLA・連絡先・システム名は含めない — テナント個別の閾値は `knowledge/confidential/{tenant}/operations/` に上書き定義する。

## 重大度定義

| SEV      | 定義                                                                          | 例                                                     | 初動目標                 | 対応体制                                                | 会議体                                          |
| -------- | ----------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------ | ------------------------------------------------------- | ----------------------------------------------- |
| **SEV0** | サービス全断・重大なデータ毀損/漏洩・重大なセキュリティ侵害。事業継続に直結。 | 主要サービスの全面停止、認証基盤の停止、個人情報の漏洩 | 即時(15分以内)招集・着手 | インシデント指揮官 + 関係全チーム、経営エスカレーション | `incident-command`(必須) → `steering-committee` |
| **SEV1** | 主要機能の重大な障害・広範な影響。回避策が限定的。                            | 決済/取引の失敗が継続、主要APIの高エラー率             | 30分以内に着手           | インシデント指揮官 + 担当チーム                         | `incident-command`(必須)                        |
| **SEV2** | 一部機能の障害・限定的な影響。回避策あり。                                    | 一部画面の不具合、非同期処理の遅延                     | 営業時間内・当日中       | 担当チーム(オンコール)                                  | 任意(担当判断)                                  |
| **SEV3** | 軽微な不具合・影響ほぼなし。計画的に対応可能。                                | 表示崩れ、軽微なログ異常                               | 次回リリース/計画対応    | 担当者                                                  | 不要                                            |

## トリアージの判定軸

重大度は次の3軸の最大値で決める(いずれか一つでも高ければ引き上げる):

1. **影響範囲** — 全ユーザー/全テナント > 特定機能/一部テナント > 個別
2. **事業影響** — 収益・信頼・規制順守への直撃 > 業務効率の低下 > 軽微
3. **回避可能性** — 回避策なし > 回避策あり(手間大) > 回避策あり(容易)

## エスカレーションとオンコール

- **SEV0/SEV1**: `incident-command` 会議体を即時招集(`governance-body-registry.json` の preconditions を満たすこと)。SEV0 は `steering-committee` へ自動エスカレーション。
- **オンコール**: 一次受け(検知・トリアージ) → 二次(担当チーム) → 指揮官の段階的エスカレーション。詳細は `pagerduty_best_practices.md` / `modern_sre_best_practices.md` を参照。
- **連絡方針**: 顧客・エンドユーザー向け連絡は `incident-command` で方針決定し、封じ込め判断(`CONTAINMENT_APPROVED`)と併せて記録する。

## ワークフローとの対応

`incident-response` ミッションワークフロー(`mission-workflow-catalog.json`)の各ゲートに対応:

| フェーズ          | ゲート                 | 会議体/判定                                       |
| ----------------- | ---------------------- | ------------------------------------------------- |
| triage            | `SEVERITY_GATE`        | `incident-command` が SEV 確定(本モデル)          |
| containment       | `CONTAINMENT_APPROVED` | `incident-command` が封じ込め実行を承認           |
| remediation       | `REMEDIATION_APPROVED` | `incident-command` が恒久対応を承認               |
| postmortem_review | `POST_INCIDENT_REVIEW` | `post-incident-review` が根本原因・再発防止を検証 |

→ 関連: [incident-management-excellence.md](./incident-management-excellence.md) · [incident_knowledge_loop.md](./incident_knowledge_loop.md) · `governance-body-registry.json`
