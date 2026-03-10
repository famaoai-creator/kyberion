---
title: リリース整合性監査 標準運用手順書 (Release Audit SOP)
category: Common
tags: [common, pmo, release, audit, sop, security]
importance: 5
author: Ecosystem Architect
last_updated: 2026-03-06
---

# リリース整合性監査 標準運用手順書 (Release Audit SOP)

*Version: 1.3.0 (Execution Steps & Jira Evidence Added)*
*Category: PMO / Governance*

## 1. 目的 (Objective)
リリース計画書 (Confluence) に基づき、GitHub (実装) と Jira (証跡) の両面から「過去の障害パターン」を物理的に検出し、リリースの安全性を担保する。

## 2. 物理的な実行手順 (Execution Steps)

### Step 1: 計画書からの全リンク抽出 (Input Extraction)
Confluence のリリース計画書 (HTML同期済み) から、監査の「実体」と「証跡」となるリンクを全抽出する。
- **実行コマンド**:
  ```bash
  # GitHub PR の抽出
  grep -oE "https://github.com/[a-zA-Z0-9._/-]+/pull/[0-9]+" <plan_html_path> | sort | uniq
  
  # Jira チケット (要件・試験証跡) の抽出
  grep -oE "https://sbisecsol.atlassian.net/browse/[A-Z]+-[0-9]+" <plan_html_path> | sort | uniq
  ```

### Step 2: 要件と試験証跡の検証 (Requirement & Evidence Check)
`jira-agile-assistant` を使用し、抽出した Jira チケットの内容を確認する。
- **チェック項目**:
    - `Description` に受入基準 (AC) が明記されているか。
    - `TaskList` またはコメント欄に、SRE/QA による「試験完了」の証跡があるか。
- **実行コマンド**:
  ```bash
  node skills/connector/jira-agile-assistant/dist/index.js --action=get-issue --issue-key=<JIRA_ID>
  ```

### Step 3: GitHub 物理監査 (Physical & Semantic Audit)
GitHub CLI (`gh`) を使用し、PR の中身を「重点チェック観点」に照らしてスキャンする。
- **実行コマンド**:
  ```bash
  # PR の概要とファイルリストの確認
  gh pr view <PR_NUMBER> --repo sbisecuritysolutions/<REPO_NAME> --json title,body,files
  
  # 意味的な Diff 監査 (インフラ変更、パッチ混入の有無)
  gh pr diff <PR_NUMBER> --repo sbisecuritysolutions/<REPO_NAME>
  ```

## 3. インシデント駆動型：重点チェック観点 (Critical Checkpoints)

### A. 可用性・堅牢性 (V1-V3 基準)
- **[V1] 50x リトライ**: BFF 層で 504/503 エラーのリトライがあるか。
- **[V2] null/空文字防御**: フロントエンドで API 戻り値の null チェックがあるか。
- **[V3] 入力バリデーション**: `transfer` 等で全角・半角スペースの `trim()` があるか。

### B. マルチテナント保護 (Tenant Purity)
- **他行ワークフロー干渉**: 対象外の銀行（福島・愛媛等）のファイル変更がないか。
- **設定誤混入**: 特定行の PR に他行の設定が紛れ込んでいないか。

### C. 基盤・インフラ防御 (Code Purity)
- **隠れた CI 変更**: 計画外の `.github/workflows/` の変更は厳禁。
- **不透明なパッチ**: `.patch` ファイルや、説明のない `pnpm-lock.yaml` の大量更新は REJECT。

## 4. 判定基準とアクション (Verdict & Action)

| 判定 | 条件 | アクション |
| :--- | :--- | :--- |
| **PASS** | すべてのチェック項目を満たす。 | タグ打ち・デプロイ承認。 |
| **WARN** | 他行影響リスクがあるが、意図的。 | **全行回帰テストの証跡**を確認。 |
| **REJECT** | Jira ID 欠落、無関係なファイル混入、V1-V3 違反。 | **Revert 指示**、または PR 分割。 |

## 5. 証跡の記録
- 判定結果は `active/shared/metrics/audit_result_{YYYYMMDD}.json` に物理出力する。
