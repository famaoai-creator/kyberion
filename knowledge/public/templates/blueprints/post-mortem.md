---
title: Blueprint: Post-Mortem (事後検証報告書)
category: Templates
tags: [templates, blueprints, post, mortem]
importance: 4
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Blueprint: Post-Mortem (事後検証報告書)
<!-- Owner: SRE / Auditor -->
<!-- Visibility: [L1: EXECUTIVE, L2: MANAGEMENT] -->

## 1. Summary of Event [L1]
- **Incident Description**: What happened?
- **Impact Duration**: Downtime/Latency period.
- **Severity Score**: Based on SLO violation level.

## 2. Detection & Response [L2]
- 2.1 How was it detected? (e.g., Automated SLI alert).
- 2.2 Response Timeline: Sequence of actions taken to restore service.

## 3. Root Cause Analysis (The Five Whys) [L2]
<!-- 指令: 技術的、プロセスの両面から根本原因を特定せよ -->
- 3.1 Technical Trigger
- 3.2 Systemic Failure (Why didn't we prevent this?)

## 4. Error Budget Impact [L1]
- 4.1 Budget Remaining: Pre vs Post incident status.
- 4.2 Policy Actions: (e.g., Freezing feature releases to focus on stability).

## 5. Corrective & Preventive Actions [L2]
<!-- 指令: 再発防止のために更新が必要なADR、SLO、またはSkillを特定せよ -->
- 5.1 Action Items (Action, Owner, Due Date).
- 5.2 Hardening strategy for future missions.
