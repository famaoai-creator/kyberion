---
title: 'Logging Policy: console and file logs humans and LLMs can act on'
tags: [governance, logging, observability, console-output, jsonl]
last_updated: 2026-10-07
---

# Logging Policy

Canonical rules for console and file logging in Kyberion. Goal: when something
happens, both humans and LLM agents must be able to tell **what**, **why**, and
**what to do next** — without wading through noise.

## 1. Console output

### Emitters

Two emitters share one engine (`libs/core/logger.ts`):

| Emitter                 | Surface                                        | Use for                               |
| ----------------------- | ---------------------------------------------- | ------------------------------------- |
| `logger` from `core.js` | stderr (all levels), colored, mission-prefixed | Human-facing CLI progress             |
| `createLogger(name)`    | stderr, `[ts] [LEVEL] [name] msg`              | Named components, daemons, subsystems |

**stdout is for a command's output, never for logs.** Both emitters write to
stderr so JSON, reports and other data on stdout stay parseable — by `--json`
consumers and by parent processes that parse a child's stdout (for example the
browser actuator run from `browser-conversation-session`). Print results with
the script harness `print`, not with `logger.info`.

Never add `console.log/error/warn` calls in library code — route through one of
the two emitters so level filtering, quiet mode and dedup apply.

### Levels

| Level     | Meaning                                                              | Examples                                                       |
| --------- | -------------------------------------------------------------------- | -------------------------------------------------------------- |
| `debug`   | Routine construction/boot detail; off by default (`LOG_LEVEL=debug`) | `backend ready`, provider discovery scans, janitor submissions |
| `info`    | Progress essentials only                                             | pipeline started, step completed, final summary                |
| `success` | Info-rank completion marker                                          | mission/pipeline completed                                     |
| `warn`    | Recoverable anomaly a human should notice                            | policy violation, degraded route, failed notification delivery |
| `error`   | Failure                                                              | step failed, unusable reasoning chain                          |

Rules:

- **Quiet by default.** If a message describes normal construction
  ("X ready", "scanning…", "loaded N policies"), it is `debug`, not `info`.
- **Never log empty values.** `Mission ID: NONE` is noise — omit the line.
- **No duplicated text inside one message** (`job submitted: job submitted`).
- Consecutive identical lines are compressed automatically to a
  `… (repeated above ×N)` marker. warn/error are never compressed.
- `--quiet`, `--json` argv and `LOG_LEVEL=silent` suppress non-error output.
  `LOG_FORMAT=json` emits one JSON object per line.

### Diagnostic format for warn/error

`formatDiagnostic({ component, what, why, next, evidence })` renders:

```
[component] what — why | next: <action> | evidence: <path>
```

Use it (or the same field order inline) for warnings and errors so an LLM or
operator can act without re-reading a stack. `next` and `evidence` are optional
but strongly preferred when a follow-up exists.

### CLI failure boundary

The `defineScript` harness (`libs/core/script-harness.ts`) is the single
failure boundary for every CLI entrypoint, and `scripts/run_built.mjs` covers
import-time failures before it. Both render `error.message` plus a `next:`
remediation hint — **never a raw stack trace** — unless `DEBUG` is set
(`core.ts` convention). Rules for thrown failures:

- Operator-facing failures should throw `DiagnosticError`
  (`libs/core/logger.ts`) — `[CODE] what — why | next: remedy`, the same shape
  as `OwnerScopeError`. The boundary never appends a generic hint on top of it.
- Plain `Error`s get a `next:` hint auto-derived from `error.code` (ENOENT,
  EACCES, ECONNREFUSED, ERR_MODULE_NOT_FOUND, …) when the message lacks
  `| next:` already.
- In `--json` mode the report is `{ ok:false, error, next?, stack? }`; `stack`
  appears only under `DEBUG`.
- Long-lived daemon guards (`process-guards.ts`) still record full stacks at
  error level — they are postmortem evidence, not operator output.

## 2. File logs (`active/shared/logs/`)

JSONL everywhere — machine- and LLM-readable. Policy per stream:

| Stream           | Character     | Compaction policy                                                                                       |
| ---------------- | ------------- | ------------------------------------------------------------------------------------------------------- |
| `audit/`         | compliance    | Full fidelity; hash chain intact. Only re-derivable arrays may be replaced by `count`+`digest`          |
| `traces/`        | debugging     | Empty span fields (`events`, `artifacts`, `knowledgeRefs`, `children`, `attributes`) omitted at persist |
| `worker-events/` | observability | `payload` omitted when empty; payloads are allowlist-redacted                                           |
| `process/`       | per-process   | Every logger line, one file per entry script (`<entry>.log`), JSONL, 10 MB × 5 rotation                 |

`process/` is fed automatically: `core.ts` installs a file sink that tees
each logger line (both emitters) into `active/shared/logs/process/<entry>.log`
(`run_doctor.log`, `run_pipeline.log`, …) with `pid`, emitter name and
`mission` in `meta`. It records even when the console is quiet (`--json`,
`--quiet`, `LOG_LEVEL=silent` → file keeps `info`+), so silencing the console
never loses a warning. Disable with `KYBERION_PROCESS_LOG=0`; it is never
active under Vitest.

Rules:

- Omit empty objects/arrays — never persist `"payload": {}` or `"events": []`.
- Do not repeat bulk reference data on every line (e.g. provider lists);
  record a `count` + short `digest` instead. The full set must be
  re-derivable from an authoritative catalog.
- Audit entries are evidence: fields that establish accountability are never
  dropped; only redundant, re-derivable bulk data may be compacted.

## 3. Adding a new message

1. Pick the level by the table above (default answer for boot/construction
   detail is `debug`).
2. Emit through `core.ts` `logger` or `createLogger(name)` — never `console.*`.
3. For warn/error, use `formatDiagnostic` or match its field order.
4. If the same call site can fire repeatedly in one process (factories,
   loops), it belongs at `debug` — do not rely on dedup as a crutch.
