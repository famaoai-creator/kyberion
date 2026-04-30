---
title: Hypothesis Tree Protocol
category: Orchestration
tags: [orchestration, decision, divergence, ace, creative]
importance: 8
author: Ecosystem Architect
last_updated: 2026-04-17
---

# Hypothesis Tree Protocol

ACE (consensus-protocol.md) の前段に **発散フェーズ** を必須化するプロトコル。収束前に独立した仮説を並列生成し、互いに引きずられない形で批判・選別する。

## 1. 動機

ACE は設計上、セキュリティ/緊急度の軸で合意形成を加速する。一方で創造的判断 (新規事業、組織設計、技術選定) では「最初に出た選択肢に全員が引きずられる」という anchoring が発生しやすい。これを **強制発散 → 構造化批判 → 収束** の 3 段階で抑止する。

## 2. フェーズ

### Phase A. Divergence (発散)
- **ペルソナ選定**: 最低 3 体、互いに志向が衝突するペルソナを選ぶ（例: Visionary Inventor / Ruthless Auditor / Red-Team-Adversary）。
- **分離実行**: 各ペルソナは **互いの出力を見ない** 状態で、agent-actuator の `a2a` sandbox にて並列に仮説を生成する。
- **最小出力本数**: 各ペルソナ最低 2 本。合計 6 本以上の hypothesis を担保する。

### Phase B. Critique (批判)
- 全仮説を一つの統合 context に合流させ、各ペルソナが他者案を **1 本ずつ** 攻撃する。
- 攻撃内容は根拠 (evidence) とセットで記録 (critique-record)。

### Phase C. Convergence (収束)
- ACE 標準プロトコル (consensus-protocol.md) に接続。
- 合意形成の対象は「生き残った仮説群」のみ。全ての脱落仮説は **Dissent Log** に保存 (dissent-log.schema.json)。

## 3. 成果物

`active/missions/{MissionID}/evidence/` 配下に以下を生成する:

- `hypothesis-tree.json` — 仮説・批判・選別の構造化ログ
- `dissent-log.json` — 採用されなかった仮説とその根拠
- `ace-report.json` — 最終 GO/NO-GO (従来形式)

## 4. 適用対象

本プロトコルは **`type: "hypothesis-tree"`** ミッションで必須、それ以外の development / evaluation ミッションでは任意。ただし judgment-rules.json の `require_dissent_quorum` が `true` の場合、dissent-log の 1 件以上の記録は必須となる。

## 5. 関連

- ベース: [consensus-protocol.md](knowledge/public/orchestration/consensus-protocol.md)
- 人格: [personalities/matrix.md](knowledge/public/personalities/matrix.md)
- スキーマ: [schemas/dissent-log.schema.json](schemas/dissent-log.schema.json)
- パイプライン: [pipelines/hypothesis-tree.json](pipelines/hypothesis-tree.json)

---
_Created: 2026-04-17 | Ecosystem Architect_
