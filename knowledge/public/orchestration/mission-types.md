---
title: Mission Types & Categories
category: Orchestration
tags: [orchestration, mission, types]
importance: 8
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Mission Types & Categories

本ドキュメントは、当エコシステムにおけるミッションの分類と、それぞれの実行規程を定義する。

## 1. 評価ミッション (Evaluation Mission)

**定義**: 対象となるソースコード、ユーザーデータ、環境設定の改変を一切行わず、現在の環境で「何ができるか」「何が不足しているか」を純粋に評価・診断するミッション。

### 1.1 実行原則 (The Zero-Write Rule)
- **改変禁止**: `write_file`, `replace`, `run_shell_command` による破壊的操作、Gitのステージング/コミットは厳禁とする。
- **観察優先**: 既存のログ、ソースコード、ドキュメントの読み取り (`read_file`, `grep_search`, `glob`) を中心に実行する。
- **検証環境**: 動作確認が必要な場合は、`active/shared/tmp/` または mission-local な一時領域でのみ一時的な実行を許可する。

### 1.2 主な目的
- 新機能導入前の現状分析 (Capability Gap Analysis)。
- セキュリティ、パフォーマンス、またはコード品質の現状診断。
- 既存シナリオの動作可否判定 (Dry-run)。

## 2. 構築・修復ミッション (Development/Fix Mission)

**定義**: 目的達成のために、物理的な資産（コード、ドキュメント）の追加、修正、削除を行うミッション。

### 2.1 実行原則 (Surgical Refit)
- `Plan -> Act -> Validate` のサイクルを遵守する。
- `AGENTS.md` の標準規程に従い、Git Checkpointing を行いながら物理的な成果物を構築する。

---

## 3. 仮説探索ミッション (Hypothesis Tree Mission)

**定義**: 収束の前に意図的に発散を起こし、反対意見を資産として残すミッション。創造的判断、新規事業、組織設計、技術選定などで使用する。

### 3.1 実行原則
- [hypothesis-tree-protocol.md](knowledge/public/orchestration/hypothesis-tree-protocol.md) に従い、divergence → critique → convergence の 3 段階を必ず通す。
- 不採用仮説は `dissent-log.json` に保存する (judgment-rules.json の `require_dissent_quorum` に従う)。
- 重大判断 (priority 8+) では [counterfactual-simulation-protocol.md](knowledge/public/orchestration/counterfactual-simulation-protocol.md) の適用を推奨する。

## 4. 交渉ミッション (Negotiation Mission)

**定義**: 成果物がコードではなく **合意** であるミッション。投資家面談、顧客提案、ベンダー交渉、M&A、組織内合意など。

### 4.1 実行原則
- [negotiation-protocol.md](knowledge/public/orchestration/negotiation-protocol.md) に従い、`negotiation` ブロック (BATNA/ZOPA/concession_ladder/red_lines) を planning 段階で必ず埋める。
- 本番セッションは **必ず人間が主導** し、エージェントは [real-time-coaching-protocol.md](knowledge/public/orchestration/real-time-coaching-protocol.md) の補助に徹する。
- 相手情報は [relationship-graph-protocol.md](knowledge/public/orchestration/relationship-graph-protocol.md) から取得する。

## 5. ミッション状態への反映

すべてのミッションは、`mission-state.json` の `type` フィールドによってその性質を明示しなければならない。

- `type: "evaluation"` : 評価ミッション（読み取り専用）
- `type: "development"` : 構築ミッション（書き込み許可）
- `type: "hypothesis-tree"` : 仮説探索ミッション（発散→批判→収束）
- `type: "negotiation"` : 交渉ミッション（合意形成、人間主導）
