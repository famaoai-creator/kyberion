---
title: Production Evidence Register
category: Developer
tags: [production-readiness, evidence, operations]
importance: 9
last_updated: 2026-05-15
---

# Production Evidence Register

この register は、`PRODUCTION_RELEASE_GATE_AUDIT.ja.md` で local test だけでは証明できないと判定した
production-readiness evidence を追跡する。機械判定の canonical source は
`knowledge/public/governance/production-evidence-register.json` で、この文書は運用者向けの要約と更新手順を示す。
収集手順は [`../operator/PRODUCTION_EVIDENCE_COLLECTION.md`](../operator/PRODUCTION_EVIDENCE_COLLECTION.md) を正とする。

## 判定ルール

- Code gate は `pnpm run validate`、targeted tests、actual first-win pipeline execution で判定する。
- Operational gate はこの register に evidence を追加し、対応する reviewer が確認してから `status` を更新する。
- `status` が `pending_external_evidence` の項目が 1 つでも残る間は、Kyberion を「production-ready」と呼ばない。
- 通常検証は `pnpm run check:production-evidence-status` で pending 項目を報告しつつ成功する。
- Release promotion 時は `pnpm run check:production-evidence-complete` を実行し、全項目が `verified` でなければ失敗させる。
- `evidence_refs` に repo-local path を使う場合は、レビュー時点で実在する file または directory だけを採用する。

## Evidence Items

| ID | Gate | Required evidence | Current status | Owner | Template | Verification command / artifact |
|---|---|---|---|---|---|---|
| EV-30DAY-OPS | Roadmap D2 / Phase B acceptance | 30 日連続稼働の run log。主要シナリオの成功率、human intervention 件数、unknown error 率を含む。 | `pending_external_evidence` | operator | `docs/operator/templates/production-evidence-30day-ops.md` | `docs/operator/PRODUCTION_EVIDENCE_COLLECTION.md`, `active/shared/logs/traces/`, incident summary |
| EV-EXT-CONTRIB | Roadmap D5 / Phase C' acceptance | 外部 contributor が good-first-issue を 1 週間以内に merge した PR。issue、PR、review、merge date を含む。 | `pending_external_evidence` | maintainer | `docs/operator/templates/production-evidence-external-contribution.md` | `docs/operator/PRODUCTION_EVIDENCE_COLLECTION.md`, GitHub issue / PR URL, `docs/developer/GOOD_FIRST_ISSUES.md` slice |
| EV-FDE-DEPLOY | Roadmap Phase D' acceptance | 外部 FDE / SI が fork なしで 1 件の顧客導入を完了した evidence。customer overlay、migration note、deployment runbook、postmortem を含む。 | `pending_external_evidence` | operator + maintainer | `docs/operator/templates/production-evidence-fde-deployment.md` | `docs/operator/PRODUCTION_EVIDENCE_COLLECTION.md`, `migration/`, customer overlay evidence |

## Update protocol

1. Add evidence as a dated row or linked artifact.
2. Record the reviewer and exact verification date.
3. Update `knowledge/public/governance/production-evidence-register.json` and this summary together.
4. Change `Current status` only after the artifact exists and has been reviewed.
5. Update `PRODUCTION_RELEASE_GATE_AUDIT.ja.md` if the evidence changes the release-gate conclusion.
