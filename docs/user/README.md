# Kyberion — User Docs

For people **using** Kyberion to get work done. If you are trying to operate / deploy it, see [`../operator/`](../operator/). If you are extending it, see [`../developer/`](../developer/).

## Start here

**[QUICKSTART](../QUICKSTART.md) is the one front door** — do its first win before anything below. The rest of this table is what to read after it.

| Step | Doc                                                  | What you get                                                                                     |
| ---- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1    | [WHY.md](../WHY.md)                                  | What this thing is and why it exists.                                                            |
| 2    | [QUICKSTART.md](../QUICKSTART.md)                    | **Start here.** 5 minutes from clone to first working smoke; also the onboarding entry points.   |
| 3    | [SURFACES.md](../SURFACES.md)                        | Which entrance to use for which job (concierge, Presence Studio, Chronos, terminal, pads, chat). |
| 4    | [USE_CASE_QUICKSTARTS.md](./USE_CASE_QUICKSTARTS.md) | Three task-first entry points: meeting facilitator, report generation, browser research.         |

Stuck? Run `pnpm kyberion setup report --persona first-time-user`, then open [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

## By what you want to do

| I want to…                                                           | Read                                                                                                                          |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Browse the workflows I can ask for                                   | [SCENARIO_CATALOG.md](../SCENARIO_CATALOG.md)                                                                                 |
| Plan ad hoc work across calendar, meeting, email, documents, browser | [PRODUCTIVITY_TASKS.md](./PRODUCTIVITY_TASKS.md)                                                                              |
| Have Kyberion join and follow up on a meeting                        | [meeting-facilitator.md](./meeting-facilitator.md) — meeting use-case and safety boundaries                                   |
| Work as, or for, a specific customer                                 | [customer-overlay-use-cases.md](./customer-overlay-use-cases.md) — create, inspect, activate, onboard, and switch engagements |
| Run day-to-day operations (Slack, Chronos, terminal)                 | [OPERATOR_UX_GUIDE.md](../OPERATOR_UX_GUIDE.md)                                                                               |
| Know what is ready, conditional, or environment-dependent            | [OPERATIONS_READINESS_MATRIX.md](./OPERATIONS_READINESS_MATRIX.md) — pair it with `pnpm kyberion setup report`                |
| Understand what happens to my data                                   | [PRIVACY.md](../PRIVACY.md) / [.ja.md](../PRIVACY.ja.md)                                                                      |

## One command per sense

Task-oriented notes for every everyday command (ask, inbox, calendar, schedule, capture, record, vault, secret, ...) are in the [Commands Guide](./COMMANDS_GUIDE.md); the generated list of all commands is the [CLI Reference](../CLI_REFERENCE.md).

From a terminal, you rarely need a pipeline: `pnpm kyberion read <file>` (documents), `see` (images), `listen` (audio), `watch` (video), `write` (brief → document), `draw` (prompt → image), `speak` (text → audio), `ask "<request>"` (plain words), `approvals` (decide). Plain `pnpm kyberion` shows a status digest and your next action. Overview: [README](../../README.md#one-verb-per-sense).

## How the docs are organised

- `docs/user/`, `docs/operator/`, `docs/developer/` — one folder per audience. Several long-standing user-facing guides still live directly under `docs/` (linked above) so existing links keep working; the links on this page are always the current locations, and the [docs index](../README.md) lists the role of every top-level document.
- `docs/` — for humans: hand-written, narrative, meant to be read top to bottom.
- `knowledge/public/` — for the Kyberion runtime: structured JSON / YAML / Markdown that workers retrieve. Not optimized for human onboarding.

If you find yourself reading from `knowledge/public/` to understand what to do, that is a docs gap — please file an issue with the `docs` label.

The Slack / Chronos / terminal guides remain inside `OPERATOR_UX_GUIDE.md` and `HOWTO.md`; those two files are the source for them. Per-command notes live in the [Commands Guide](./COMMANDS_GUIDE.md).
