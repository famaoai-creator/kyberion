# Work home: supported coverage and boundaries

Presence's existing home now combines supported work and attention in one view.
It reuses the existing conversation, task-session, approval, held-action and
artifact stores. It is a read projection, not an execution engine.

## Six-proposal coverage

| Proposal                     | Delivered in this slice                                                                                                        | Deliberate limit                                                                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One place for action-needed  | Pending approvals and held actions plus request/session input, blocked and unknown states                                      | No shared login-blocker store; hygiene, memory, and arbitrary provider queues are not silently imported                                                                          |
| Work list                    | All rows supplied by the supported scoped readers; source availability, truthful statuses, conversation/progress links         | Not a universal inventory of every mission/provider; a capped upstream window remains partial                                                                                    |
| Fewer repeated confirmations | Existing decision context is linked, no second approval dialog or new authority endpoint                                       | Grouping is visual only; no new permission bundle, blanket grant, or cross-request approval reuse                                                                                |
| Resume safely                | Read-only selected conversation context, recorded/verified times, uncertainty and next step                                    | Opening, refresh, reload and selection never dispatch/retry/approve/resume execution                                                                                             |
| Understand artifact versions | Verified diagnostic receipt lineage: latest verified, older verified, requested pending/unknown, explicit format-change reason | Generic artifacts have unknown version/time; no content-diff view; receipt links reopen context, not a file editor; existing review/edit surfaces remain the place for revisions |
| Task-grouped updates         | Per-item details and available recorded updates; quiet/detailed display preference keyed to the server viewer fingerprint      | No title-inferred decision association or comprehensive history; no notification subscription/channel/digest change                                                              |

The home always states its limited supported-source coverage. An unavailable
source is not an empty source, and zero visible attention is not an all-clear
when a source is unavailable or partial.

## Status and evidence rules

- A conversation answer is **answered**, never evidence that external work ran.
- A pending follow-up takes precedence over an earlier answered result.
- Only a current execution projection with matched work identity and artifact
  byte/hash readback can produce **work_completed** and a checked-now timestamp.
- Recorded time is separate from verification time. Missing time stays unknown.
- Failed/released work is not successful work. Unknown pending effects stay
  visible in quiet mode and never produce automatic retries.
- A new requested revision does not replace the latest verified parent until
  its own current evidence verifies. Version currentness is visible in quiet
  mode. Format-change reason comes only from the actual revision binding.
- Raw task history is omitted from this aggregate because existing producers
  embed internal filesystem paths in status prose. Typed status remains visible.

## Access and navigation

The server resolves the principal and narrows tenant, organization and project.
The Home adapter checks consistent canonical/legacy visibility claims and tier
access before emitting titles, statuses or links. Remote records with unknown
tier fail closed. Conflicting or malformed scope claims are omitted.

Home is available to a remote read token, but its conversation source retains
the existing localadmin-only boundary. A remote token cannot turn the aggregate
into an indirect conversation reader; it sees that source as unavailable.

Local display preference stores only quiet/detailed, keyed by a fingerprint of
the server-derived principal and all scope restrictions. It stores no work text.
Storage failure keeps the current tab usable. It never invokes the real
notification-preferences endpoint.

Links carry the narrowed selection once from the server. Client code does not
rewrite those links from mutable preferences. Stale refreshes and old-scope
responses are discarded. Resume links contain no send/mic/prefill instruction.
Unknown or evicted request IDs produce an unavailable message, not selection of
another request. Historical focus is one-shot after hydration so subsequent new
messages retain normal conversation scrolling.

The legacy decision workbench cannot currently preserve a narrower selection.
Therefore approval/held-action cards expose its link only for the full local
all-scope operator view. Under narrower or remote scope the card stays visible
with an explicit unavailable-destination explanation. This slice does not widen
the workbench or create a duplicate decision authority UI.

## Read-only behavior

- Exact-viewer conversation-work read: no locks, transcript writes or partition
  enumeration. It uses the same current evidence verifier as execution status.
- Conversation GET uses the readOnly history projection. Fresh reports and
  bound status replies are computed in memory with safe status-only copy;
  stale success metadata is removed when verification is unavailable.
- Home's already-constructed OS surface snapshot uses readOnly plus
  includeObservations=false. It does not reconcile linked approvals, decide,
  apply, or refresh observation journals. Existing unrelated snapshot behavior
  is unchanged. The no-write claim does not cover constructing a new default
  shared control plane, whose startup may migrate/cache state.
- The held-action snapshot currently returns at most 50 latest records before
  pending filtering. A full window is marked partial with unknown total, even
  if none of those 50 is pending.

## Verification

Focused coverage executes the actual shipped browser scripts with DOM/event
fixtures, and invokes the real read adapter with isolated data-source fixtures.
It covers multiple work items, attention, malformed/widened scope, tier and
principal isolation, partial source failure, refresh ordering, reload, denied
storage, inert navigation, pending amendments, old/pending artifact versions,
and no approval/conversation mutation during reads.

DOM tests are not visual browser validation. Browser rendering checks, aggregate
repository gates, full locale-stable suite results, and any environment limits
are recorded separately in the delivery evidence and PR test plan.
