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

DOM doubles and handler tests do not prove rendering, mobile layout, or accessibility behavior. Actual visual/browser end-to-end verification was unavailable in the review environment. Daemon IPC forwarding integration timed out under a bounded test run and remains unverified; mocked transport/client tests are separate evidence. No actual model-provider request was used to validate this change.
