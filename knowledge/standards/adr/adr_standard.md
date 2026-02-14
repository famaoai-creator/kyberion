# Architecture Decision Record (ADR) Standard

ACE Engine での合意形成を公式な記録として残すための標準フォーマット。

## 1. ADR テンプレート

```markdown
# ADR-[ID]: [Title]

## Status
[Proposed | Accepted | Rejected | Superseded]

## Context
[解決すべき問題、背景、ステークホルダーの要望、技術的制約]

## Decision
[ACE Engine が下した結論。具体的なアーキテクチャの選択、採用する技術、変更内容]

## Rationale (ACE Debate Summary)
[なぜその決定に至ったか。対立した意見（例: Security vs Speed）と、どう妥協・統合したかの論理的根拠]

## Consequences
[この決定によって得られるメリット、および受け入れるべきデメリット（技術負債、追加コスト等）]

## Evidence Chain
[EVD-XXXXXX: ハッシュ値による不変の証跡リンク]
```

## 2. 運用規程
- すべての **ACE審議 (S1/S2評価を含むもの)** は、完了後に自動的にこの形式で `docs/adr/` に保存される。
- Chronos Mirror はこれらの ADR を「意思決定の歴史」としてタイムライン表示する。

---
*Created: 2026-02-14 | Ecosystem Architect*
