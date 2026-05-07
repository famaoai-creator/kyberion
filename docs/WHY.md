# Why Kyberion

A short answer to: *who is this for, what problem does it solve, and why couldn't it be solved by something else?*

## The Problem

Knowledge workers — especially executives, founders, and FDE / SI engineers — spend most of their day on work that is **structured, repetitive, but irreducibly contextual**:

- Reviewing approvals across 5 different SaaS apps.
- Reading a PDF, summarizing it, and putting the summary into the right Notion / Slack / email.
- Coordinating a meeting recap, follow-up tasks, and stakeholder update — same shape every week.
- Watching a vendor renewal deadline approach and chasing 3 internal teams.

Tools today fall into two camps:

1. **Generic LLM chat (ChatGPT, Claude.ai)** — flexible, but stateless. No memory of your context, no governance, no execution. You re-explain everything every time.
2. **RPA / no-code automation (Zapier, n8n, UiPath)** — has execution, but brittle. Every workflow is a fragile chain of point-to-point rules with no understanding of *intent*.

Neither matches how organizations actually work, which is:

```
Intent → Plan → Result
```

You don't think "trigger → action → output". You think "I want X done, figure out the rest".

## What Kyberion Is

Kyberion is an **organization work loop engine**: it turns intent into governed execution, evidence, and reusable memory.

Practically:

- You phrase outcomes (`今週の進捗レポートを作って`, `この PDF をパワポにして`, `経費承認を進めて`).
- Kyberion plans the steps, asks only when something material is ambiguous, and runs the work.
- Every run produces a result, an artifact, and a trace that later runs can learn from.
- Multiple actuators (browser, voice, file, code, etc.) execute the steps. The plan is governed by approval policies, tier isolation, and audit chains.

If you've used:

- `Computer Use` / browser-driving agents → Kyberion is that, but with mission state, governance, and reusable knowledge layered above the browser.
- `Cursor` / coding agents → Kyberion is broader: code is one actuator among many, and the unit of work is a mission with persistent state, not a single chat.
- RPA → Kyberion replaces the brittle rule chains with intent-driven plans that survive site changes.

## Who It's For

In priority order:

1. **Founders / executives / power users** who want to delegate repetitive cognitive work and have it *actually* be done, with audit trails.
2. **FDE / SI engineers** who deliver Kyberion-based automation to customers and need fork-free customization.
3. **OSS contributors** building actuators / pipelines / vertical templates on top.

This is **not** for:

- People who want a chat interface for occasional questions (use Claude.ai or ChatGPT).
- Teams that need a turnkey SaaS today (Kyberion is OSS-first; SaaS comes later if user demand justifies it).
- Engineers who want a coding-only assistant (use Cursor).

## What Makes Kyberion Different

| Trait | Why it matters |
|---|---|
| **Mission as first-class state** | A piece of work has its own git repo, its own state, its own evidence. Survives restarts, audits, and 24h+ runs. |
| **3-tier knowledge isolation** | Personal / confidential / public tiers, enforced at the file-IO boundary. Customer secrets cannot leak into reusable knowledge. |
| **Actuator catalog with semver** | 23+ actuators covering browser, voice, file, code, network, etc. Each with a semver-stable contract so 3rd-party extensions don't rot. |
| **ADF (governed pipeline format)** | Pipelines are validated, sub-pipeline composable, with declarative `on_error`. Not yet another YAML soup. |
| **Customer aggregation point** | One directory (`customer/{slug}/`) for FDE customizations. No fork required for 80%+ of customer work. |
| **Trace + governance** | Every run emits a structured trace + audit chain entry. Failures get classified and fed back into reusable hints. |
| **Voice-native UX** | Speak to it; it speaks back. From the browser, no API key required. |

## The Strategic Bet

Knowledge work is moving from "I do this manually with LLM help" to "I delegate and verify". The winner won't be the most chat-fluent model — it'll be the system that:

1. **Captures intent reliably** (so delegation is safe).
2. **Has evidence and audit** (so verification is fast).
3. **Accumulates organizational memory** (so the same problem doesn't cost twice).

Kyberion is the bet that **the engine** of that system, not the LLM, is the durable artifact. LLMs will be replaced every 6 months. The engine that turns them into governed organization work outlasts them.

## Where We Are

Kyberion is **OSS, in active development**. The current focus (`docs/PRODUCTIZATION_ROADMAP.md`):

- Phase A: Make it a 5-minute first-win for any developer.
- Phase B: Make it survive 30 days of continuous use.
- Phase C': Make it contributable in under a week.
- Phase D': Make FDE / implementation-support engagements possible without forks.

If any of this resonates, the [Quickstart](./QUICKSTART.md) is the next step. If you'd rather understand the architecture first, start with [`knowledge/public/architecture/organization-work-loop.md`](../knowledge/public/architecture/organization-work-loop.md).

The Quickstart is organized around a first-win ladder: 30 seconds for `pnpm doctor`, 5 minutes for `pipelines/voice-hello.json`, and 15 minutes for the browser-session smoke.
