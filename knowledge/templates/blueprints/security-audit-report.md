---
title: Blueprint: Security Audit Report
category: Templates
tags: [templates, blueprints, security, audit, report]
importance: 4
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Blueprint: Security Audit Report
<!-- Owner: Auditor / QA -->
<!-- Visibility: [L1: EXECUTIVE, L3: SYSTEM/DATA] -->

## 1. Security Posture Summary [L1]
- **Overall Risk Level**: [LOW/MEDIUM/HIGH/CRITICAL]
- **Key Findings**: Top security concerns identified.
- **Compliance Status**: Alignment with project security policies.

## 2. Vulnerability Scan Results [L3] [AUDIT: Security]
<!-- 指令: security-scannerによる物理的なスキャン結果を添付せよ -->
- 2.1 Static Analysis (SAST) Findings
- 2.2 Dependency Vulnerability Audit

## 3. Sensitive Data Detection [L3]
<!-- 指令: .envやハードコードされたシークレットの有無を確認せよ -->
- 3.1 Secret detection logs
- 3.2 Access Control & Privilege review

## 4. Remediation Plan [L2]
- 4.1 Required Fixes (Immediate)
- 4.2 Security Hardening recommendations
