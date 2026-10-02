---
title: Resident Dot Model — always-on agents in Kyberion
category: Architecture
tags: [architecture, autonomy, resident-agent, dots, charter, supervision]
importance: 8
author: Ecosystem Architect
last_updated: 2026-10-02
---

# Resident Dot Model

OpenAI "dots" (announced 2026-09-29) are always-on agents inside ChatGPT: each
holds an ongoing responsibility, owns a cloud computer and browser, connects to
apps, delegates heavy work to Codex/Work tasks, and messages the human only
when a decision is needed. This document maps that shape onto Kyberion's
existing primitives and defines the missing piece: the **dot charter**.

## Element mapping

| OpenAI dot element                     | Kyberion primitive                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------------------- |
| Holds an ongoing responsibility        | `DotCharter` (`dots/`) + `worker-goal-driver` goal loop (KD-01)                        |
| Own computer + browser                 | Local host + browser-actuator / system-actuator (`computer_interaction`)               |
| App connections                        | Actuators + provenance-gated plugins + MCP bridges                                     |
| Delegates heavy work                   | mission_controller / WorkItem + `delegateTask` subagents + multi-provider co-execution |
| Works between conversations            | `chronos` scheduler + `trigger-runner` (`cron`/`watch`/`wake`)                         |
| Messages you when a decision is needed | `autonomous-ops-gate` → `approval-store` → satellites (slack/telegram/imessage)        |
| Persistent memory                      | `knowledge/` tiers + distill → `memory-promote` loop                                   |
| Emergency stop                         | `kill-switch`                                                                          |
| Liveness                               | `daemon-heartbeat` + `daemon_watchdog` + leader lease                                  |

## The charter is the only new contract

Everything else already exists. A charter binds: goal (responsibility),
attention (trigger set), authority (an existing role — never new power),
decision floor (ops-gate), and notification (deliver_to + digest). See
[`dots/README.md`](../../../dots/README.md).

## Runtime wiring (landed MSN-RESIDENT-DOT-RUNTIME-20261002)

1. `agent-runtime-supervisor` multiplexes active charters: a daemon sweep
   (`KYBERION_DOT_SWEEP_INTERVAL_MS`, default 30 s) evaluates each active
   charter's `attention.triggers` via `evaluateDotTriggersDue` and routes due
   wakes through `TriggerRunner` (idempotency + audit + the charter's role as
   the trigger authority, assumed via `withExecutionContextAsync`). The deliver
   handler runs one bounded `worker-goal-driver` turn (`runDotWake`) with the
   charter's budget and `toolRole`.
2. Due-ness memory is `active/shared/runtime/dot-wake-ledger.jsonl`; cron keys
   are `<expr>@<minute>` in the charter timezone, watch keys encode
   `mtime:size` (snapshot in `dot-watch-state.json`), wake keys are inbox-line
   hashes (`dot-inbox.jsonl`). Failed wakes stay retryable; cron does not
   catch up on slept minutes.
3. `goal.budget.token_cap_per_day` is enforced across processes via
   `dot-token-usage.jsonl`; per-wake turns/wall-clock map to
   `GoalBudgetLimits` (KD-02).
4. Status transitions are governed (`libs/core/dot/dot-lifecycle.ts`,
   `kyberion dot activate|pause|retire`): activation requires the authority
   role in the canonical registry and a heartbeat_id that collides with
   neither `DEFAULT_DAEMONS` nor another active dot.
5. The dot's heartbeat (`runtime.heartbeat_id`) joins `daemon_watchdog`'s
   supervised set while active (`listActiveDotHeartbeatIds`), so a silent dot
   pages, same as any daemon.
6. `autonomous-ops-gate` per-action floors (`decisions.*`) and
   `notification.deliver_to` sends remain follow-on; the pilot stays
   `default_decision: notify` and coordinates through its role scopes.

## Hard-won constraint from MSN-RESIDENT-DOT-20261002

The autonomy substrate only works if the _alert path itself_ is authorized:
`daemon_watchdog` and `chronos_gateway` previously lacked `ops-alerts.jsonl`
write scope, so the watchdog died exactly when it had something to report and
the hourly health watch could not escalate. Any dot runtime must land its
authority role in `security-policy.json` **before** activation — the schema
cannot express that, so `status: active` transitions are gated by
`dot-lifecycle.ts` (`transitionDotCharterStatus`), which validates role
existence and heartbeat uniqueness.

## Locality caveat

Dots run in OpenAI's cloud; Kyberion dots run on this host. macOS sleep stops
chronos and every resident loop. `decisions.quiet_hours` and
`autonomous-ops-policy.active_hours` are the sanctioned way to bound that;
true 24/7 operation needs a non-sleeping host (customer VM per
docs/operator/DEPLOYMENT.md "persistent always-on" section).
