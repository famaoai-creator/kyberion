---
title: Blueprint: Information Asset Registry (情報資産管理台帳)
category: Templates
tags: [templates, blueprints, information, asset, registry]
importance: 4
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Blueprint: Information Asset Registry (情報資産管理台帳)
<!-- Owner: PMO / Ecosystem Architect -->
<!-- Visibility: [L2: MANAGEMENT, L3: SYSTEM/DATA] -->

## 1. Asset Governance Summary [L1]
- **Total Assets Count**: Scanned files across code/knowledge/vault.
- **Sensitivity Distribution**: Ratio of Personal / Confidential / Public tier assets.

## 2. Information Asset Ledger [L3] [INVENTORY: All Paths]
<!-- 指令: ディレクトリをスキャンし、各階層のTier設定と機密性、保存期間を抽出せよ -->
| Asset Name | Category | Tier | Owner | Physical Path | Retention |
| :--- | :--- | :--- | :--- | :--- | :--- |
| [Name] | [Code/Knowledge] | [L1-L4] | [Role] | [Path] | [Indefinite/Mission-Life] |

## 3. Confidential Data Map [L3] [RESEARCH: Confidential Tier]
- 3.1 Company Secrets Location: Specific files in `knowledge/confidential/`.
- 3.2 Access Log Summary: Who/What accessed sensitive data.

## 4. Integrity & Backup Status [L2]
- 4.1 Checksum Validation Status: Are assets tampered with?
- 4.2 Sync Status: `sovereign-sync` result for remote vaults.

## 5. Risk & Compliance Level [L2] [AUDIT: Tier Guard]
<!-- 指令: tier-guard.cjsによる境界チェック結果を反映せよ -->
- 5.1 Violation History: Leaks detected between tiers.
- 5.2 Remediation Status: Masking or Move actions performed.
