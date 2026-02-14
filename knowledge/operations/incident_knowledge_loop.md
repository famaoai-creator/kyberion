# Incident Knowledge Loop: Learning from Failures

## 1. Overview

インシデント（スキル失敗、SLO 違反）を「負の遺産」ではなく「学習の機会」として捉え、自律的に知識を蓄積するためのプロトコル。

## 2. Post-Mortem Structure (RCA Template)

障害発生後、以下の項目を埋めて `knowledge/incidents/` に保存する。

- **Mission ID**: 追跡用のユニーク識別子
- **Detection**: どのように検知したか（SLO Breach, Health Check 等）
- **Root Cause**: 根本原因（error-signatures.json に基づく解析結果）
- **Resolution**: 実行した修復レシピ
- **Prevention**: 同様の事象を自動修復するための「新しいレシピ案」

## 3. Knowledge Feedback

蓄積された Post-Mortem データは、定期的に `error-signatures.json` にフィードバックされ、RCA 推論の精度を向上させるために使用される。
