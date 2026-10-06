---
record_id: mem-MSN-TUI-SIMPLE-MOD-20261006-2026_10_06
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-TUI-SIMPLE-MOD-20261006-2026_10_06
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-06T13:29:34.786Z
source_branch: main
source_commit: 17529cb2a131466b81a5293c09d011a52fa490a2
---

# TUI responsiveness: registry panels + worker-thread loaders + WORK-sentinel chat

terminal-hud moved panel loaders onto an unref worker thread and dropped fs watchers — key input blocking dropped from >26s/8.3s to ~50ms on a heavy checkout. Chat answers via one fast reasoning call; WORK sentinel routes state changes to the governed surface. Open follow-ups: dead intentResolution field, worker-timeout blast radius, GenericPanel snapshot on UI thread, no cancel on governed-surface calls.

## Hint Scope

mission

## Trigger Phrases

- Pattern: registry-driven panels (registry.ts) + synchronous loaders behind loadInWorker (worker-client.ts, 30s timeout) keep the Ink thread input-responsive; drop chokidar watchers to kill re-render churn (~110KB -> ~3.4KB). quick-chat.ts: single model_tier=fast call, HISTORY_TURNS=8, 25s abort, WORK_SENTINEL hands acting requests to the governed surface so the chat path never holds write authority. Verify TUI changes with a pty.fork keystroke-timing harness, not unit tests alone. Lessons on process: record evidence as work happens — reconstructed deliverables drifted from reality and needed review fixes.

## Recommended References

- active/missions/public/MSN-TUI-SIMPLE-MOD-20261006/evidence/perf-measurement.md
- active/missions/public/MSN-TUI-SIMPLE-MOD-20261006/evidence/ux-contract.json
- active/missions/public/MSN-TUI-SIMPLE-MOD-20261006/evidence/test-report.md

## Evidence

- active/missions/public/MSN-TUI-SIMPLE-MOD-20261006/evidence/perf-measurement.md
- active/missions/public/MSN-TUI-SIMPLE-MOD-20261006/evidence/ux-contract.json
- active/missions/public/MSN-TUI-SIMPLE-MOD-20261006/evidence/test-report.md

## Artifacts
