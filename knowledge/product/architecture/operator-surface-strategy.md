---
title: Operator Surface Strategy (CLI + Governed Operator Web)
category: Architecture
tags: [ui, surface, operator, cli, web, strategy]
importance: 8
last_updated: 2026-10-12
---

# Operator Surface Strategy

This document fixes Kyberion's stance on **how operators interact with the
system**: which surfaces are first-class, which are observation-only, and
what is intentionally not built.

It complements [`USER_EXPERIENCE_CONTRACT.md`](../../../docs/USER_EXPERIENCE_CONTRACT.md)
(which defines the _language_ of the human boundary) by defining the
_surfaces_ that boundary lives on.

## 1. Stance

**CLI / pipeline first. Observation-first web with narrowly governed settings.**

Most commands enter through CLI and state is observed through the Operator Web.
The explicit exceptions are inbox acknowledgement and authenticated administrator
selection settings: per-mission actor choices and per-reasoning-role runtime
choices. These delegate to existing governed core facades; they do not start
missions, spawn agents, execute reasoning, change credentials or grant authority.

## 2. Surface Tiers

| Tier      | Surface                                             | Who                   | Mutates state?                                            |
| --------- | --------------------------------------------------- | --------------------- | --------------------------------------------------------- |
| Primary   | `claude` / `codex` / `gemini` CLI + `pnpm pipeline` | Operators, agents     | Yes — primary entry                                       |
| Primary   | `mission_controller` CLI                            | Operators             | Yes — mission lifecycle                                   |
| Secondary | Operator Web                                        | Operators, leadership | Observation; scoped administrator selection settings only |
| Secondary | `chronos-mirror-v2` (presence display)              | Stakeholders          | No — passive feed                                         |
| Tertiary  | Mobile / WebView surfaces (handoff target)          | Operators in motion   | Limited — handoff-imported sessions                       |
| Forbidden | Public-facing web admin UI                          | —                     | Never                                                     |

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
with observation-first pages and the bounded settings exceptions above:

### 5.1 Pages

| Path                | Purpose                                                                   |
| ------------------- | ------------------------------------------------------------------------- |
| `/`                 | Active missions (one row per mission, latest checkpoint, status)          |
| `/missions/:id`     | Mission detail: history, checkpoints, evidence files, audit chain entries |
| `/audit`            | Audit chain timeline filtered by tenant / mission / date                  |
| `/intent-snapshots` | Recent intent decisions (snapshot store) with diff against prior snapshot |
| `/health`           | Latest `vital-check` / `full-health-report` outputs                       |
| `/knowledge`        | Browseable `knowledge/public/` index                                      |

### 5.2 Data sources (read-only)

```
filesystem (via secure-io read APIs)
  - active/missions/{tier}/{id}/mission-state.json
  - active/missions/{tier}/{id}/evidence/*
  - active/audit/system-ledger.jsonl
  - knowledge/public/**/*.{md,json}
  - knowledge/product/evolution/*.md
```

Only the enumerated inbox and selection-settings endpoints may mutate. Mission
selection writes enter the mission lifecycle facade; reasoning writes enter the
shared revisioned configuration service. The Web must never write their stores
directly. Preview is read-only and must not launch discovery probes or providers.

### 5.3 Auth model

- Local-only by default (`http://localhost:PORT`, bound to loopback).
- Multi-tenant deployment: reverse-proxy with auth, scope each session to
  one `KYBERION_TENANT`. The app reads `KYBERION_TENANT` from env and
  filters all data sources accordingly.
- Settings mutations require an authenticated administrator, same-origin/CSRF
  validation and server-derived tenant, organization and project scope.
- Credential-free loopback access remains read-only. Client scope parameters
  can narrow authorization, never create it.
- The shared global reasoning configuration is writable only by an unscoped
  administrator; scoped administrators must not acquire global write access.

### 5.4 Action affordances

Where the user might want to act, the page renders a **`suggested_command`**
they can copy into their CLI. The bounded selection editors additionally provide
edit, read-only preview, save and cancel. They show the requested and effective
choice, its source and any rejection or fallback reason. Saves reject stale
revisions and retain an audit trail; changing settings never replaces an active
task owner.

This matches the `Next Action Contract` from
[`USER_EXPERIENCE_CONTRACT.md`](../../../docs/USER_EXPERIENCE_CONTRACT.md):
the surface explains the purpose, then shows the runnable command.

## 6. Existing Surfaces — Where They Fit

| Existing                               | Role                                                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `presence/displays/chronos-mirror-v2/` | Ambient status / wallboard (passive)                                                          |
| `presence/displays/computer-surface/`  | Computer-use bridging (input/output to a remote GUI session) — **not** a Kyberion operator UI |
| `presence/displays/presence-studio/`   | Authoring surface for presence content; not for mission control                               |

The MOS does not replace any of these — it's a fourth display whose only
job is to make filesystem + audit-chain readable.

## 7. Anti-patterns (do not build)

1. **Unbounded Web-issued mission mutations** — e.g. a button running
   `mission_controller verify`, dispatch or arbitrary CLI commands. Selection
   settings use their dedicated facade only; lifecycle actions stay in the CLI.
2. **Server-side reasoning backend** — e.g. a web form that triggers
   `pnpm pipeline ...` on a shared host. Pipelines run under a specific
   persona context; centralizing them muddies authority.
3. **Mobile authoring** — composing missions from a phone. The surface
   is too narrow for the audit story to land cleanly. Mobile is a
   handoff _target_, not a source.
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

- [ ] Mutation routes match the explicit inbox/settings allowlist; all other
      write APIs are rejected by the boundary test.
- [ ] Renders mission list, mission detail, audit timeline, intent
      snapshots, health, knowledge index.
- [ ] Multi-tenant: an operator with `KYBERION_TENANT=acme` cannot see
      another tenant's mission state.
- [ ] Lifecycle actions use copy-able `suggested_command`; settings use
      authenticated, scoped, revision-checked editors.
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
- [`kyberion-canonical-concept-index.md`](kyberion-canonical-concept-index.md)
- [`kyberion-intent-catalog.md`](kyberion-intent-catalog.md)
- [`multi-tenant-operations.md`](multi-tenant-operations.md)
- [`../../../presence/displays/chronos-mirror-v2/`](../../../presence/displays/chronos-mirror-v2)
