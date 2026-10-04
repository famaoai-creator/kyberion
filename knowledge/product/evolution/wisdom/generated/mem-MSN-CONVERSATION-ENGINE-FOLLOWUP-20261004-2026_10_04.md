---
record_id: mem-MSN-CONVERSATION-ENGINE-FOLLOWUP-20261004-2026_10_04
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-CONVERSATION-ENGINE-FOLLOWUP-20261004-2026_10_04
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-04T15:40:28.252Z
source_branch: feat/conversation-engine-followup-20261004
source_commit: 05360f795845c51b6e491b9554b3fbff52e1baf5
---

# Engine-driven loop migration: evidence-clocking, output multiplexing, and decision-queue patterns

Reusable lessons from migrating realtime-voice-loop's duplicated deciders into the ConversationEngine (CE-02) and adding semantic reply segments with an instant reaction slot (CE-06).

## Hint Scope

mission

## Trigger Phrases

- 1. Feed a pure decision engine events with _evidence-based_ timing, not wall-clock: chunk-duration (`silenceDeltaMs`) keeps intra-utterance pauses meaningful when input is replayed faster than real time — otherwise speculation/hold thresholds silently compress. 2. Overlapping outputs need independent activity tracking: a single `outputActive` flag let `reaction_ended` clear interruption evidence while the reply still played (CE-06 instant reaction). Track each output and only reset arbiters when all output ends. 3. Read interruption-arbiter state BEFORE the lifecycle event that resets it — `tts_end`/`output_ended` wipe buffered audio needed for replay. 4. Emit 'empty' finals too: a failed/empty transcript still needs the final event so the engine clears lastPartial/awaitingFinal and revokes stale speculation. 5. Gate straggler events on lifecycle state — late STT partials must not confirm a barge-in on a later turn's output; forward only while listening. 6. Turn decisions (hold/commit/drop) belong in a queue drained by the owner of utterance context, while output actions (pause/resume/hard_stop) apply to _all_ live outputs, not whichever exists. 7. When a repo ratchet caps max file lines, extract the cohesive seam (engine wiring + reaction emission → voice-loop-engine.ts) rather than shaving comments.

## Recommended References

- active/missions/public/MSN-CONVERSATION-ENGINE-FOLLOWUP-20261004/evidence/implementation-report.md
- active/missions/public/MSN-CONVERSATION-ENGINE-FOLLOWUP-20261004/evidence/REVIEW-execution-implement.md

## Evidence

- active/missions/public/MSN-CONVERSATION-ENGINE-FOLLOWUP-20261004/evidence/implementation-report.md
- active/missions/public/MSN-CONVERSATION-ENGINE-FOLLOWUP-20261004/evidence/REVIEW-execution-implement.md

## Artifacts
