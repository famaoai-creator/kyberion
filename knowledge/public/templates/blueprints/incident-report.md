---
title: Blueprint: Incident Report (障害報告書)
category: Templates
tags: [templates, blueprints, incident, report, ace]
importance: 4
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Blueprint: Incident Report (障害報告書)
<!-- Owner: Auditor / ACE Engine -->
<!-- Visibility: [L1: EXECUTIVE, L3: SYSTEM/DATA] -->

## 1. Executive Incident Summary [L1]
- **Incident Title**: Brief descriptive name.
- **Severity**: [Critical/High/Medium/Low]
- **Service Impact**: Duration and scope of downtime/failure.
- **Resolution Status**: [Resolved/Workaround/Open]

## 2. Occurrence Details [L2]
- 2.1 Detection Time: [YYYY-MM-DD HH:MM]
- 2.2 Resolved Time: [YYYY-MM-DD HH:MM]
- 2.3 Detection Method: (e.g., Automated Alert, Human User report).

## 3. Root Cause Analysis (RCA) [L3] [LOG: Error Tails]
<!-- 指令: エラーログの該当箇所をスキャンし、スタックトレースやエラーコードを特定せよ -->
- 3.1 Technical Root Cause: Specific line of code or config failure.
- 3.2 Process Root Cause: Why was this not caught in validation/testing?

## 4. Resolution & Recovery Actions [L2]
- 4.1 Immediate Mitigation: Short-term fix applied.
- 4.2 Self-Healing Activity: Log of `self-healing-orchestrator` actions.

## 5. Prevention Plan [L2]
<!-- 指令: 再発防止のために更新が必要なskill、test、またはknowledgeを特定せよ -->
- 5.1 Corrective Actions: (e.g., Added new test case, Refactored skill logic).
- 5.2 Future Improvements: Strategic hardening.
