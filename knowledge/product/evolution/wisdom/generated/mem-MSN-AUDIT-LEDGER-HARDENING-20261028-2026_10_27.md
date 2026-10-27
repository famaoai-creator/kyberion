---
record_id: mem-MSN-AUDIT-LEDGER-HARDENING-20261028-2026_10_27
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-AUDIT-LEDGER-HARDENING-20261028-2026_10_27
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-27T15:35:16.953Z
source_branch: fix/audit-ledger-hardening-20261028
source_commit: 2264b2a382dead4c15818d7bbe00e642bd7997e9
---

# Hash-chain verifiers must enforce keyed algorithm discipline, not only links

A chain that accepts per-entry algorithm choice (sha256 or hmac-sha256) is only as strong as its weakest accepted entry: verify the algorithm sequence, the window boundary, and every unreadable line, or a forger rewrites the chain without the key.

## Hint Scope

mission

## Trigger Phrases

- When a hash chain records its algorithm per entry (chain_alg), link and hash checks alone do not make it tamper-evident: unkeyed sha256 entries can be recomputed by anyone. Rules learned in MSN-AUDIT-LEDGER-HARDENING-20261028:

1. Verify the algorithm sequence with one shared tracker (libs/core/chain-integrity.ts createChainAlgTracker): an unkeyed entry after a keyed one is a downgrade (chain_downgrade), and a chain born keyed (tenant ledger partitions) may hold no unkeyed entry at all (unkeyed_entry).
2. Downgrade detection alone still accepts a chain rewritten unkeyed from genesis. The authoritative verifier (audit:verify, the daily audit-verify-daily pipeline) therefore requires keyed entries by default; accepting a legacy unkeyed prefix is an explicit opt-in (--allow-legacy-unkeyed). In-process liveness checks may stay lenient so legacy hosts do not fail lifecycle steps.
3. A windowed verification (--since) must continue from the last readable entry before the window (its hash and keyed state); otherwise a rewritten window restarts from the real boundary hash and passes.
4. A verifier must report unreadable lines and files as findings. A reader that drops a whole file on one bad line lets a forger hide keyed entries from the tracker.
5. Records that may land in the untenanted system ledger (no mission, failed ephemeral mission, inherited possibly-archived MISSION_ID) must not carry personal-tier identifiers such as keychain account names; record counts instead and keep names in the evidence ledger of a mission the caller itself started.

Before tightening a verifier, measure real data (here: system ledger and audit chain were fully keyed, and the 20 existing audit-chain findings were identical before and after), so the change adds no false findings.

## Recommended References

- active/missions/public/MSN-AUDIT-LEDGER-HARDENING-20261028/evidence/distillation.md

## Evidence

- active/missions/public/MSN-AUDIT-LEDGER-HARDENING-20261028/evidence/distillation.md

## Artifacts
