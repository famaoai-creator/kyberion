---
record_id: mem-MSN-OPS-ALERT-WINDOW-20261122-2026_11_22
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-OPS-ALERT-WINDOW-20261122-2026_11_22
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-22T05:41:13.433Z
source_branch: agent/factory-ops-alert-window
source_commit: a856fb0598425de3d80b4eae85457c66c6ddde07
---

# Bound rolling log dominance probes to a recency window and count actual sample keys

Bounding ops-health-probe alert dominance checks to a 24h recency window (ALERT_DOMINANCE_WINDOW_MS) prevents fixed historical bursts from permanently drowning live signal, and per-key counting selects the true dominant sample_key.

## Applicability

- mission
- mission:MSN-OPS-ALERT-WINDOW-20261122

## Reusable Steps

1. Bounding ops-health-probe alert dominance checks to a 24h recency window (ALERT_DOMINANCE_WINDOW_MS) prevents fixed historical bursts from permanently drowning live signal, and per-key counting selects the true dominant sample_key

## Expected Outcome

## Context

When an append-only alert log like ops-alerts.jsonl is rotation-bounded, resolved historical incident bursts stay readable in the file after the emitter stops failing.

## Pattern

1. Filter timestamped rows against a bounded recency window (default 24h via ALERT_DOMINANCE_WINDOW_MS) while retaining un-timestamped rows fail-open and offering an explicit alertDominanceWindowMs <= 0 opt-out.
2. Track exact per-key occurrence counts in a map instead of keeping the lexicographically largest key so sample_key and sample_key_count accurately identify the dominant alert cause.

## Outcome

Live ops-alerts.jsonl findings for daemon-watchdog dropped from 1 false alert_dominance finding (2092/2166 historical rows) to 0 under the 24h window, and unbounded mode accurately surfaces the true mode sample_key (1105 occurrences).

## Evidence

- active/missions/public/MSN-OPS-ALERT-WINDOW-20261122/evidence/implementation-report.md
- active/missions/public/MSN-OPS-ALERT-WINDOW-20261122/evidence/test-report.md
- active/missions/public/MSN-OPS-ALERT-WINDOW-20261122/evidence/distillation.md

## Artifacts
