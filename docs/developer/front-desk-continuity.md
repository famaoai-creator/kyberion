# Front-desk continuity foundation

Presence Ask and Concierge text requests share a server-owned, scope-derived conversation. Existing Concierge v1 IDs, paths, and the last 50 durable turns are preserved. Presence's former per-tab history remains a local read-only archive; it is not imported as executable context. Only the explicitly identified loopback operator aliases across surfaces. Tokens and other principals never alias.

## Supported boundary

| Capability                                                        | Scoped front-desk text mode                                                              |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Direct conversation                                               | Supported with a fresh supervised runtime per turn                                       |
| Completed transcript context                                      | Last 20 messages, 16,000 total characters, 4,000 per message; untrusted context only     |
| Same request replay                                               | Display-only; stable request ID and same resolved conversation scope required            |
| Tenant/organization/project restriction                           | Server validates allowed lists; ambiguous execution scope is rejected before reservation |
| Background review                                                 | Explicitly unsupported                                                                   |
| A2A delegation                                                    | Explicitly unsupported                                                                   |
| Governed CLI execution                                            | Explicitly unsupported                                                                   |
| Legacy task-session execution or steering                         | Explicitly unsupported                                                                   |
| Shared personal queries and feedback recording                    | Explicitly unsupported                                                                   |
| Durable background execution, stop/steer, or concurrent long work | Not implemented by this slice                                                            |
| Concierge server-side voice listen-once                           | Separate legacy path, not the durable text contract                                      |

Unsupported routes return a non-success capability error and preserve the draft. There is no unscoped execution fallback. Legacy callers that do not opt into the server-owned conversation key retain their existing behavior. A fresh runtime adds startup overhead. Base manifest, policy, prerequisite checks, actuator permissions, and NHI identity remain authoritative; runtime partitioning is not a new filesystem sandbox.

## Retry and cleanup limits

New requests bind the raw input digest before redaction. Server reservation time governs the 24-hour duplicate-protection window; a client-issued timestamp only validates request freshness. Evicted replies retain bounded conflict receipts, not unlimited historical replay. Pending and uncertain results never trigger a second execution automatically. Only a typed admission rejection before execution may mark a request as not started and permit explicit same-ID retry.

Conversation reservation uses the shared filesystem lock. All competing processes must run the repaired protocol in the same PID/filesystem namespace. Atomic publication, bounded publication retries, and automatic dead-main-lock recovery remain enabled. The upstream implementation's documented >10-minute stalled-reclaimer exception was not its only risk: deterministic interleaving also demonstrated overlapping acquisition without elapsed-time aging. This integration prevents taking over an extant cleanup guard and never sweeps a live cleaner's tomb. It does not claim safety for mixed old/new lock implementations, external live-file mutation, or the legacy non-atomic I/O fallback stalled beyond its malformed-record recovery age.

### Exceptional cleanup-guard recovery

A cleanup guard is normally released in the cleaner's finally path. If that cleaner is killed, loses power, or cannot release/verify its guard, a later stale-main recovery can time out. A suspended cleaner can finish when it resumes. An orphan guard does not by itself block acquisition of an otherwise free main lock. This exceptional failure frequency has not been measured, so it is not described as guaranteed rare.

The diagnostic identifies the affected resource and guard; inspectLockRecovery reports manual recovery without an automatic-reclaim countdown. First allow a live cleaner to finish. If it cannot, identify every process that may acquire that resource and establish quiescence before inspecting and removing the orphan guard, then restart only those verified participants. For shared front-desk keys this includes both Presence and Concierge and any direct callers. This is an operator precondition, not an implemented drain/repair command or a guarantee that one surface's stop result proves quiescence. If participants cannot be reliably enumerated, stop and request a broader known-safe maintenance scope; never delete a live guard to force progress. Do not erase conversation receipts or retry uncertain work during recovery.

Scoped execution admits at most eight turns in one live supervisor, with same-conversation overlap denied. Shutdown waits for pending boot and requires an acknowledged stopped result before capacity is released. Failed cleanup retains its slot. The cap survives surface restarts while that daemon remains alive; it is not a crash-proof global OS-process budget. Existing idle cleanup applies. Operators must reconcile orphaned runtime state after daemon crashes rather than assuming a new process proves old work stopped.

Progress verdicts persist principal/scope/item uncertainty in browser session storage before POST. Old reads cannot clear newer uncertainty; only a later read containing the exact terminal entry can reconcile it. Storage restoration errors keep actions disabled and preserve unverified data. This is a client safeguard: the inherited deliverable-inbox backend is not an exactly-once mutation service.

## Startup and deployment

Follow QUICKSTART's managed reconcile, status, and setup-report sequence. Enabled configuration alone is not health evidence. The local auto-admin opt-in is only for a trusted local operator; remote viewing does not authorize actions. Browser navigation uses configured surface origins through the existing public-base-URL contract, with loopback defaults. It does not open listeners or relax mutation authentication.

## Regression map and verification limits

- Startup/readiness: scripts/setup_report.test.ts, managed_startup.test.ts, setup_source_maintenance.test.ts
- History and replay: front-desk-conversation-store.test.ts, conversation-routes.test.ts, Concierge route.history.test.ts
- Browser interrupted/repeated flows: ask-client.test.ts, conversation-response-input.test.ts, progress-client.test.ts
- Scope and result fidelity: progress-scope-routes.test.ts, progress.test.ts, home.test.ts
- Scoped runtime and cleanup: surface-conversation-runtime-context.test.ts, agent-lifecycle.surface-context.test.ts, surface-runtime-orchestrator.conversation-context.test.ts, surface-runtime-conversation-data.context-binding.test.ts
- Lock publication/reclamation: lock-utils-contention.test.ts

DOM doubles and handler tests do not prove rendering, mobile layout, or accessibility behavior. Actual visual/browser end-to-end verification was unavailable in the review environment. Local daemon IPC was permission-blocked and was not retried. GitHub Linux CI on commit 46c4a0f passed all 17 supervisor-daemon tests, covering real Unix forwarding with mocked runtimes; this is separate from model-provider execution. No actual model-provider request was used to validate this change.

## Conversation request routing (bounded intake slice)

The shared front-desk store classifies each newly reserved user turn into a new
request, follow-up, status question, approval candidate, cancellation candidate,
chat, or clarification. Classification is deterministic and advisory; it grants
no authority.

Only three decisions carry a local intake reply that Concierge and Presence
return instead of calling the scoped runtime: a status question that resolves to
a recorded request, an approval or cancellation that names a recorded request,
and the selection question (and its answer) for an ambiguous status/control
reference. New requests and explicitly named follow-ups are recorded silently and
still go to the runtime, so it answers them exactly as before. Everything else,
including unmatched or unknown references, mixed clauses, bare confirmations such
as “はい” or “ok”, ordinals without a pending question, and implicit amendments
such as “make it shorter”, stays ordinary chat. Bare confirmations must reach the
runtime because they may answer its own execution preview.

The server-owned transcript now keeps a separate request index. Request IDs are
server-bound turn IDs; normal replies use readable titles. The index survives
bounded transcript eviction and is partitioned by the same principal, member,
role, source, tenant, organization, project and tier restrictions. Existing v1
transcripts remain readable and migrate to v2 on their next write; older assistant text is
never promoted into a task or an approval.

A named unique request can be selected. When several requests could match
“さっきの件どう？”, the reply lists their titles and asks which one. The original
question and exact candidates are persisted, so a subsequent title or ordinal
selection can recover after reload. Mixed requests are passed whole to the
runtime and are not partially recorded. At capacity, new requests and follow-ups
are simply not recorded; existing requests are never evicted and chat is never
blocked.

The index is bounded to 64 requests, 64 follow-up notes per request and 4 MiB of
encoded state. Original redacted request text is retained separately from the
bounded display title. This slice does not add archival or task execution.

A request record carries one status. `recorded` means no reply has completed.
When the runtime turn that recorded or amended the request completes, the front
desk passes an outcome derived only from the runtime's structured result
(`classifyConversationTurnOutcome`), never from reply text:

- `completed`: answered in place (a direct answer needing no approval, input or
  further execution). The record keeps the answering turn ID, a 280-character
  excerpt and the time, and status replies quote that excerpt.
- `awaiting_input`: the runtime asked for clarification.
- `needs_execution`: approval, a mission proposal, or a non-direct resolution
  shape. The scoped conversation cannot run this work. The optional
  `workItemId` field is reserved for a governed executor (the planned
  front-desk intake dot) to link the WorkItem it creates; nothing sets it yet,
  and status replies say the hand-off is not automated. The queue and executor
  design is in the
  [front desk intake queue plan](./improvement-plans-2026-10/FRONT_DESK_INTAKE_QUEUE_PLAN_2026-10-05.ja.md).

Local intake replies and ordinary chat never change a record. Earlier v2 records
with `execution: "not_started"` are read and that field is dropped. This slice
neither scans nor
executes legacy global TaskSession records, and does not implement a task worker.
The existing scoped unsupported-capability boundaries remain in place. Approval
and cancellation candidates do not change execution state or grant permission;
the user must use a supported scoped workflow with its existing confirmation.

Reservation, request-index changes, clarification and the immutable routing
decision and its inert reply are written atomically under the existing conversation lock.
A crash before HTTP reply delivery can replay that known result without execution.
Model/chat turns keep the existing pending/uncertain rules. Replaying
one request ID returns its recorded response/decision without adding another task
or update. Same-ID/different-text conflicts remain rejected. Intake replies use
the same durable completion handling as conversation replies; an unsaved reply
never becomes an invitation to retry a possibly completed operation.

Regression coverage includes the real Presence handler through the shared store,
Concierge handler boundary tests, isolation, duplicate IDs, transcript eviction,
malformed state, secret redaction, non-authoritative approval/cancellation, and
ordinary chat that resembles intake grammar (for example “What happened in 1945?”,
“宿題終わった？”, “はい”, a bare “2”) reaching the runtime.

Deploy the updated store with both front-desk processes. Older binaries reject v2
transcripts instead of silently overwriting the new request index. Back up the
scoped transcript before any deliberate downgrade; never drop the index to bypass
that version check.
