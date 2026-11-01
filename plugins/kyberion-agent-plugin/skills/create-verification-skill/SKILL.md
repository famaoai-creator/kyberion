---
name: create-verification-skill
description: Generate a project-local verification skill that drives the real app surface (CLI, UI, API, desktop) the way a user or operator does. Use when the repo has no scripted Launch/Doctor/Drive/Evidence/Cleanup recipe, or when asked to create a verify-<app> skill. Complements Kyberion golden procedure checks — does not replace them.
---

# Create a verification skill (Kyberion)

Every serious project needs a scripted way to drive the real app and prove behavior: launch it,
exercise a feature the way a user would, and capture evidence. This skill generates that as a
**project-local** skill (default `.cursor/skills/verify-<app>/`) tailored to the repo.

Upstream inspiration: pstack `/create-verification-skill` (MIT). Rewritten for Kyberion —
actuators, secure-io, storage floors, mission evidence — not Cursor Task/`poteto-agent` routing.
Orchestration overview: `knowledge/product/orchestration/create-verification-skill-playbook.md`.

You write the generator's output for the **next agent**, not for a human: it will be read cold,
mid-task, by an agent that has never seen the app.

## 1. Interview the repo, not the user

Answer these from the codebase; ask the operator only what you cannot observe:

- **Surface:** what does a user/operator actually touch? Web UI, CLI/TUI, desktop, API, mobile,
  library? Pick the primary surface; note the rest.
- **Run:** how does the app start locally? Prefer documented scripts (`package.json`, Makefile,
  QUICKSTART). Note ports, env vars, seed data, auth.
- **Drive:** existing harnesses first (Playwright, expect/PTY, HTTP, Kyberion browser/terminal/
  system actuators). Only then pick a generic recipe.
- **Observe:** screenshots, terminal transcripts, response bodies, logs, exit codes, DB/state
  files. Prefer `pnpm kyberion read|see|listen|watch` for perception over hand-rolled parsers.
- **Isolate:** can two instances run side by side (ports, data dirs, profiles)? If not, the
  generated skill must refuse to double-drive a shared instance.

If the checkout does not build or start as-is, fix that first (or report it precisely) before
generating. Verification scaffolding created only for the run must be marked and removed in
Cleanup — never left as silent state.

## 2. Generate the skill

Write `.cursor/skills/verify-<app>/SKILL.md` with YAML frontmatter (`name: verify-<app>`,
`description` naming the app, surface, and when to reach for it). Include these sections,
grounded in what the interview found (no placeholders left):

- **Launch:** exact start command; how to tell it is ready (usable state, not merely a process
  answering). Empty data dir → migrations/seed. Teardown for servers; for short-lived CLIs,
  launch means build once then each drive in an isolated PTY/tmux session.
- **Doctor:** one read-only check — process up, right build, port owned by us, auth valid. Agents
  run this first whenever anything looks off.
- **Drive:** harness recipe with real selectors/commands from this repo. Prefer stable handles
  (ARIA names, data attributes, prompt strings, route paths) over coordinates.
- **Evidence:** what to capture and where. Standards: real user path (not test-only setters);
  capture action + resulting state; verify side effects; mocks only at production boundaries.
  Paths: mission `evidence/` when inside a mission, otherwise `active/shared/tmp/<job>/` or
  `writeScopedArtifact` — never ad-hoc directories. File I/O via `@agent/core/secure-io` in any
  helper scripts.
- **Cleanup:** tear down only what this run started. Kill by the pid/handle you created, never by
  process name. Cleanup must **not** delete proof artifacts; name where evidence survives.
- **Helpers:** any shipped script is executable; invocation shown in the skill body.

## 3. Seed the feature map

Create `features/README.md` plus one file per top user-facing feature (start with 3–5 from
routes, commands, menus, or docs). Follow
[`references/feature-map-example/`](./references/feature-map-example/). Each feature file:

1. H1 + one paragraph of user-visible behavior
2. Exactly four H2s: `Sub-features`, `How to get to it (user POV)`, `Driving it with <harness>`,
   `Gotchas`

Keep implementation internals out. Name user paths, stable handles, required state, commands,
and observable proof. Never weaken a journey to make it pass — report unmet preconditions.

## 4. Prove the generated skill before handing it over

Run its own instructions end to end once: Launch → Doctor → Drive **one** mapped feature →
capture Evidence → Cleanup. After cleanup, confirm evidence still exists at the named location.
Fix failures and always run cleanup after failed iterations so ports/processes are not stranded.
A skill never executed is a draft, not a deliverable.

If you proved in a stand-in (container vs VM, local vs remote), list every setup step the
stand-in did that the target will not — those stay unverified until a real-target run.

## 5. Kyberion closing

When this generation runs inside a mission: write the deliverable paths into the task report and
`pnpm mission record-evidence <ID> <task_id> "<note>" --actor-id <who> --evidence <paths>`.
Do not claim "verified" without quoting doctor + drive outputs. Golden procedure checks remain
the authority for recorded browser/service procedures — link them from the feature map when a
feature already has a catalog entry.
