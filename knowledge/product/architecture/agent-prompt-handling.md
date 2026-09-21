---
title: Pane Agent Prompt Handling
tags: [architecture, agent-runtime, herdr, pane, approval, allowlist, trust, readiness]
last_updated: 2026-09-21
---

# Pane Agent Prompt Handling

A pane agent (herdr) can stop and ask: a workspace trust prompt on first
run, "Do you want to make this edit?" mid-turn, a sign-in. From outside,
such an agent looks idle or `blocked`, and its question used to be returned
as its answer. Three layers now handle it.

| Layer  | Where                                                     | What                                                                                                                                                                                                   |
| ------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Detect | `libs/core/agent-runtime-readiness.ts`                    | Classifies the pane screen: `ready` / `awaiting_human` (with signature) / `starting` / `unavailable`. herdr `blocked` also counts.                                                                     |
| Decide | `libs/core/agent-prompt-response.ts`                      | Picks one of: auto-answer (allowlist rule), escalate (approval request), human_only.                                                                                                                   |
| Act    | `libs/core/agent-pane-runtime-herdr.ts` (`settlePrompts`) | Sends keys, relays a person's approval, or fails with `[AGENT_RUNTIME_AWAITING_HUMAN]` / `[AGENT_RUNTIME_PROMPT_DECLINED]`. The routing ledger records both as `not_attempted`, not as model failures. |

## Policy and customization

- Product defaults: `knowledge/product/governance/agent-prompt-response-policy.json`.
  They answer nothing automatically and add no launch flags.
- Per-installation overlay: `knowledge/personal/governance/agent-prompt-response-policy.json`
  (same schema). Rules with the same `id` replace product rules. `launch_args`
  and `relay_keys` are replaced per key.

```json
{
  "version": "1.0.0",
  "auto_answer": [
    {
      "id": "trust-my-worktrees",
      "signature": "workspace_trust",
      "cwd_prefixes": ["{repo_parent}"],
      "keys": ["enter"],
      "note": "sibling worktrees of this checkout"
    }
  ],
  "launch_args": { "codex": ["-s", "workspace-write"] }
}
```

Guards that no policy can lift:

- `sign_in`, `device_code` and `terms_or_consent` are never auto-answered.
  Sign-in and device-code prompts are not escalated either: a person has to
  act in the pane or browser.
- A `workspace_trust` rule must name `cwd_prefixes`. The match is on path
  boundaries, so `/work/repo` does not cover `/work/repo-evil`.
- A `generic_confirm` or `agent_blocked` rule must have `excerpt_pattern`.
  A rule that could answer any question is ignored.
- An answer that does not take effect (the same prompt is still on screen)
  stops the turn instead of being resent.

## Escalation

Escalated prompts become approval requests on channel `agent-runtime`,
created through the approval store. A person decides them with
`pnpm kyberion approvals` / `approve <id>` / `reject <id>` or on the surfaces.
The turn waits up to `escalation_wait_ms` (default 300000). If no decision
arrives, the request stays open and the next turn relays a decision made
later.

- Only decisions recorded as `decidedByType: human` are relayed.
- Each decision is consumed after it is relayed. A later identical prompt
  opens a new request, so one "yes" never becomes a standing grant.
- Auto-answers and relays are recorded in the audit chain as
  `agent_prompt_response`.
