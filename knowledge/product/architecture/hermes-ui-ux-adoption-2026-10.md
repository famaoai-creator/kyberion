---
title: Hermes UI and UX adoption into existing Kyberion facades
tags: [hermes-agent, ui, ux, tui, connections, learning, tool-discovery]
last_updated: 2026-10-28
status: implemented
runtime_stages: [planning, execution, review]
---

# Hermes UI and UX adoption

This update extends the [July absorption plan](../../../docs/developer/improvement-plans-2026-07/HERMES_AGENT_ADOPTION_PLAN_2026-07-18.ja.md).
The October comparison uses the upstream live documentation, not a pinned release or an executed Hermes installation.

## Adopted behavior

| Hermes pattern                                            | Kyberion implementation                                                                                                                                                  | Boundary preserved                                                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Progressive tool disclosure with a bounded listing        | `prompt-cache-discipline.ts` shortens descriptions to names, then namespace counts; the default announcement budget is 16,000 UTF-8 bytes                                | Byte budget is deterministic, not an exact model token count. Role filtering and execution grants remain authoritative.                         |
| Explicit maintenance protection and recoverable archives  | `background-review-curator.ts` uses separate maintenance metadata, pin/hold, pending or approved background-review references, and an explicit restore operation         | Only eligible generated proposals are maintained. Restoring returns to review; it never approves, applies, or publishes the proposal.           |
| Visible learning review state                             | `KnowledgeLearningPanel` shows the saved review snapshot, its source and payload digest separately from editable text, and states that pending review is not publication | The existing shared approval and publication facades remain the only authority. A payload digest is not a target-file diff.                     |
| Searchable connection setup with explicit account actions | Concierge's service catalog has search, connection-method filters, explicit supported sign-in, loading/error/retry states and collapsed setup details                    | Availability and stored configuration are not successful authentication. Viewer/owner filtering and the existing OAuth endpoint stay unchanged. |
| Searchable modal navigation and preserved input           | Terminal HUD adds Ctrl+P navigation, Escape back to the composer, an explicit busy-draft message and a connection-settings handoff                                       | The picker does not authenticate, install, probe or execute shell commands. A kept draft is not a durable queued message.                       |

## Retention and recovery operations

Use the existing facade rather than editing registry JSON:

```sh
pnpm background-review status --json
pnpm background-review curate --dry-run --json
pnpm background-review pin --candidate <id> --actor-id <actor>
pnpm background-review hold --candidate <id> --actor-id <actor>
pnpm background-review restore --candidate <id> --actor-id <actor> --dry-run
pnpm background-review restore --candidate <id> --actor-id <actor>
```

`unpin` removes a pin; `manage` permits automatic archival again. Maintenance consent does not rewrite generation provenance.
For scoped records, pass the exact existing `MemoryScopeEnvelope` through `--scope-json`; omitting it addresses only legacy records.
The normal storage and execution policy still governs access. An actor label is audit metadata, not an authentication credential.

## Deferred and deliberately different

- External memory providers remain optional future adapters. Do not synchronize transcripts to a new service as part of a UI improvement.
- Do not copy Hermes' best-effort audit behavior into governed knowledge mutation paths.
- Preserve the distinction between a conversation boundary, a task session and mission completion. The existing stable-prefix/compaction implementation is reused.
- General task, schedule and pipeline dependency protection needs an authoritative reference relation before it can be added to proposal retention. This change protects the existing background-review approval relation; it does not claim arbitrary dependency discovery.
- Per-provider token counting and empty-search server summaries need richer catalog metadata before they can be implemented truthfully.

## Verification contract

Regression coverage exercises large/Unicode tool catalogs and role visibility, proposal protection/restore/scope, catalog failure/retry/filtering and explicit sign-in, saved versus edited review content, and TUI keyboard navigation with draft preservation. Package builds check the exported types. No external account is connected and no real credentials are changed during verification.

The execution evidence for this adoption is owned by `MSN-HERMES-UX-20261028`. Browser availability and other environmental limits must be reported separately from test and build results.

## Upstream references

- [Tool Search](https://hermes-agent.nousresearch.com/docs/user-guide/features/tool-search)
- [Curator](https://hermes-agent.nousresearch.com/docs/user-guide/features/curator)
- [Persistent Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)
- [Desktop settings and connection scope](https://hermes-agent.nousresearch.com/docs/user-guide/desktop)
- [TUI](https://hermes-agent.nousresearch.com/docs/user-guide/tui)
