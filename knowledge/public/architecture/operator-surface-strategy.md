---
title: Operator Surface Strategy (CLI + Read-only Web)
category: Architecture
tags: [ui, surface, operator, cli, web, strategy]
importance: 8
last_updated: 2026-04-27
---

# Operator Surface Strategy

This document fixes Kyberion's stance on **how operators interact with the
system**: which surfaces are first-class, which are observation-only, and
what is intentionally not built.

It complements [`USER_EXPERIENCE_CONTRACT.md`](../../../docs/USER_EXPERIENCE_CONTRACT.md)
(which defines the *language* of the human boundary) by defining the
*surfaces* that boundary lives on.

## 1. Stance

**CLI / pipeline first. Read-only web second. No mutating GUI.**

In one sentence: **commands enter through CLI; state is observed through
read-only web; mutations to mission state never originate from a Web UI**.

## 2. Surface Tiers

| Tier | Surface | Who | Mutates state? |
|---|---|---|---|
| Primary | `claude` / `codex` / `gemini` CLI + `pnpm pipeline` | Operators, agents | Yes — primary entry |
| Primary | `mission_controller` CLI | Operators | Yes — mission lifecycle |
| Secondary | Read-only mission status viewer (web) | Operators, leadership | No — view only |
| Secondary | `chronos-mirror-v2` (presence display) | Stakeholders | No — passive feed |
| Tertiary | Mobile / WebView surfaces (handoff target) | Operators in motion | Limited — handoff-imported sessions |
| Forbidden | Public-facing web admin UI | — | Never |

## 3. Why CLI-first

- **Auditability**: every CLI invocation lands as one entry on `audit-chain`
  with full argv. UIs introduce intermediation that the chain can't see.
- **Reproducibility**: a command in a runbook reproduces a state. A button
  click does not.
- **Composability**: pipelines, shell scripts, and CI all consume CLI.
- **Bandwidth match**: operators of Kyberion are already at a terminal —
  forcing them through a Web UI is friction, not capability.

## 4. Why a read-only Web is still worth building

CLI is bad at:

- Showing many missions side-by-side
- Giving non-operator stakeholders (CEO, compliance) a status view
- Surfacing `audit-chain`, `intent-snapshot`, and review-gate states in a
  visual timeline

A read-only viewer that **renders** mission state from filesystem +
audit-chain (without writing) gets these affordances without breaking the
auditability invariant.

## 5. The Minimum Operator Surface (MOS)

A single Next.js app under `presence/displays/operator-surface/` (planned —
not yet implemented) renders the following from filesystem + audit-chain
**without ever issuing a write**:

### 5.1 Pages

| Path | Purpose |
|---|---|
| `/` | Active missions (one row per mission, latest checkpoint, status) |
| `/missions/:id` | Mission detail: history, checkpoints, evidence files, audit chain entries |
| `/audit` | Audit chain timeline filtered by tenant / mission / date |
| `/intent-snapshots` | Recent intent decisions (snapshot store) with diff against prior snapshot |
| `/health` | Latest `vital-check` / `full-health-report` outputs |
| `/knowledge` | Browseable `knowledge/public/` index |

### 5.2 Data sources (read-only)

```
filesystem (via secure-io read APIs)
  - active/missions/{tier}/{id}/mission-state.json
  - active/missions/{tier}/{id}/evidence/*
  - active/audit/system-ledger.jsonl
  - knowledge/public/**/*.{md,json}
  - knowledge/incidents/*.md
```

No write APIs. Everything mutating routes through CLI.

### 5.3 Auth model

- Local-only by default (`http://localhost:PORT`, bound to loopback).
- Multi-tenant deployment: reverse-proxy with auth, scope each session to
  one `KYBERION_TENANT`. The app reads `KYBERION_TENANT` from env and
  filters all data sources accordingly.
- No write endpoints means no CSRF surface and no privilege boundary
  beyond filesystem permissions.

### 5.4 Action affordances (without mutation)

Where the user might want to act, the page renders a **`suggested_command`**
they can copy into their CLI — never a button that calls an API.

This matches the `Next Action Contract` from
[`USER_EXPERIENCE_CONTRACT.md`](../../../docs/USER_EXPERIENCE_CONTRACT.md):
the surface explains the purpose, then shows the runnable command.

## 6. Existing Surfaces — Where They Fit

| Existing | Role |
|---|---|
| `presence/displays/chronos-mirror-v2/` | Ambient status / wallboard (passive) |
| `presence/displays/computer-surface/` | Computer-use bridging (input/output to a remote GUI session) — **not** a Kyberion operator UI |
| `presence/displays/presence-studio/` | Authoring surface for presence content; not for mission control |

The MOS does not replace any of these — it's a fourth display whose only
job is to make filesystem + audit-chain readable.

## 7. Anti-patterns (do not build)

1. **Web-issued mission mutations** — e.g. "approve" button that calls a
   server endpoint that runs `mission_controller verify`. Always route
   such a request through the operator's local CLI.
2. **Server-side reasoning backend** — e.g. a web form that triggers
   `pnpm pipeline ...` on a shared host. Pipelines run under a specific
   persona context; centralizing them muddies authority.
3. **Mobile authoring** — composing missions from a phone. The surface
   is too narrow for the audit story to land cleanly. Mobile is a
   handoff *target*, not a source.
4. **Dashboards that aggregate confidential data across tenants** — they
   will leak under operational pressure. Per-tenant deployments only.

## 8. MVP Implementation Hints

When the MOS is finally built:

- Stack: Next.js 15 + React 19 + Tailwind, mirroring
  `chronos-mirror-v2`'s tooling.
- Data layer: a thin loader that reads filesystem with `secure-io`'s
  read APIs only; no `safeWriteFile` import in the app at all.
- Audit-chain rendering: stream-parse `system-ledger.jsonl` server-side,
  hash-verify in the page render path; show a red banner if continuity is
  broken.
- Diff view for intent-snapshots: render a structural diff between the
  current and previous snapshot.
- Operator command rendering: when showing `suggested_command`, copy with
  one click; don't `exec` server-side.

## 9. Acceptance Criteria for "MOS shipped"

The MOS is considered shipped when **all** hold:

- [ ] No write API in the app's network surface (`grep -r 'app/api' app | grep -i 'POST\|PUT\|DELETE'` returns 0).
- [ ] Renders mission list, mission detail, audit timeline, intent
      snapshots, health, knowledge index.
- [ ] Multi-tenant: an operator with `KYBERION_TENANT=acme` cannot see
      another tenant's mission state.
- [ ] All actions surfaced via copy-able `suggested_command`.
- [ ] CI runs MOS-side tests as part of `pnpm run validate`.

### 9.1 Security baseline (mandatory before any external exposure)

`Read-only` is **not** a substitute for security review (IP-7 from the
2026-04-27 outcome simulations). All of the following must pass before
the MOS is exposed beyond loopback / a single trusted operator:

- [ ] **SSRF test suite** — Server-Components / Server-Actions paths that
      fetch backend data (audit-chain, mission-state, knowledge files)
      have explicit allowlist of permitted source paths and reject
      operator-controlled URL fragments. Tests fuzz query strings, route
      params, and `?` interpolation in `revalidatePath` calls.
- [ ] **WAF placement** — In any deployment that is reachable from
      outside loopback, the MOS lives behind a WAF; IP allowlist is
      configured to corporate / VPN ranges only.
- [ ] **Client certificate or OIDC + tenant scope** — Authentication
      pins the operator's `KYBERION_TENANT`; no UI-side tenant switch.
- [ ] **Independent auth review** — A reviewer who did not write the auth
      code signs off on session, CSRF, and OIDC-callback handling.
- [ ] **Filesystem read sandbox** — The MOS's data layer imports
      `safeReadFile` only; `safeWriteFile` is statically forbidden by a
      lint rule (`no-restricted-imports` for the MOS package).
- [ ] **Observation-only audit** — The MOS itself emits `mos.read` audit
      events for every operator page view, scoped to the active tenant.

### 9.2 Alternative path: structured CLI output → existing dashboards (IP-8)

For organisations that do not want to host a Next.js app at all, an
acceptable alternative is to skip the MOS and instead:

- Have CLIs emit structured JSON (one event per line, schema-validated)
  to stdout when `KYBERION_FORMAT=ndjson`.
- Pipe that stream into an existing observability stack (Grafana Loki,
  Datadog Logs, Elastic, Splunk).
- Render mission timelines and audit trails using the dashboards of
  that stack.

This is operationally cheaper for small teams: no UI to maintain, no
auth surface to secure, no SSRF to test. The trade-off is that
non-engineer stakeholders need access to the observability stack instead
of a purpose-built UI.

The decision tree is:

```text
Will the deployment serve >5 stakeholder personas (CEO, compliance, ops,
                                                  audit, customer)?
├── Yes → Build the MOS (§5 / §9.1).
└── No  → Use the structured-CLI / existing-dashboards path (§9.2).
         Re-evaluate when the persona count grows.
```

## 10. Reference

- [`docs/USER_EXPERIENCE_CONTRACT.md`](../../../docs/USER_EXPERIENCE_CONTRACT.md)
- [`kyberion-canonical-concept-index.md`](./kyberion-canonical-concept-index.md)
- [`kyberion-intent-catalog.md`](./kyberion-intent-catalog.md)
- [`multi-tenant-operations.md`](./multi-tenant-operations.md)
- [`../../../presence/displays/chronos-mirror-v2/`](../../../presence/displays/chronos-mirror-v2/)
