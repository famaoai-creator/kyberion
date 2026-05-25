---
title: Harness Landscape Scan 2026-05
category: External Wisdom
tags: [external-wisdom, harness, control-plane, skills, kanban, voice, multimodal, browser]
knowledge_type: explicit
intelligence_layer: methodology
importance: 8
author: Sovereign Concierge
last_updated: 2026-05-26
---

# 2026-05 Harness Landscape Scan

Kyberion should treat the current agent ecosystem as converging on four layers:

- a user-facing surface
- a reusable harness
- a control plane for policy, budgets, and observability
- a durable collaboration substrate for tasks and handoffs

The recent releases below are not identical, but they point in the same direction.

## 1. What the current market is optimizing for

### 1.1 Multimodal first-run surfaces

The newest products are trying to make voice, images, video, and local files usable immediately rather than requiring a bespoke setup flow.

- Gemini Spark is being positioned as a proactive desktop agent that can work with local files and desktop workflows, with voice features landing in the macOS app.
- Codex now ships with image generation skills and document skills, not just code editing.
- OpenClaw keeps tightening its voice, image, PDF, media, and messaging tool surface so the first usable workflow is close to the user’s existing apps.

### 1.2 Skills and plugins as shared capability units

The most useful pattern is no longer “one giant prompt”.
It is a shared skill pack or plugin bundle that can be reused across surfaces.

- Claude Cowork exposes skills, plugins, connectors, and scheduled tasks through Claude Desktop.
- Codex lets teams create, manage, and share skills across the app, CLI, and IDE.
- Hermes treats skills as on-demand knowledge documents that live in a shared directory and can be surfaced as slash commands.
- OpenClaw has also moved toward shared skill installation and managed skill distribution.

### 1.3 Durable multi-agent collaboration

The multi-agent story is shifting from fragile subagent fan-out toward durable boards and shared task state.

- Hermes Kanban is the clearest example: a shared durable board with named agents, comment threads, task events, and board-level persistence.
- Codex emphasizes multiple agents in parallel, separate threads, and worktrees.
- OpenHands emphasizes orchestration and control plane concerns rather than only a single harness loop.

### 1.4 Control plane as a first-class product surface

The highest-signal architectural change is the appearance of a real control plane.

- OpenHands Enterprise describes a harness, orchestrator, and control plane stack.
- Claude Cowork adds analytics, OpenTelemetry, and role-based access control.
- OpenClaw continues to scope runtime context, delivery guidance, and explicit command hints so the surface stays separate from the base persona.

## 2. Comparative summary

| Project | Main signal | Kyberion takeaway |
|---|---|---|
| OpenClaw | Local, messaging-first assistant with tightened gateway, voice, and skill surfaces | Preserve the message-surface entrypoint, but keep mission ownership and traceability explicit |
| Hermes Agent | Skills + persistent memory + kanban board + messaging gateway | Adopt the durable board and shared skill model, not fragile in-process swarms |
| OpenHands Enterprise | Harness / orchestrator / control plane separation | Treat policy, routing, budgets, and observability as a distinct layer |
| Claude Cowork | Desktop knowledge work, scheduled tasks, plugins, connectors, RBAC, telemetry | Make the desktop work surface easy to extend but keep admin controls centralized |
| Gemini Spark | Proactive desktop agent with local files, voice, and workflow automation | Absorb multimodal, voice, and desktop-file workflows into the Kyberion front door |
| Codex app | Command center for agents, multi-agent threads, worktrees, skills | Use threads and worktrees for supervised parallel work; promote shareable skills |
| browser-use | CDP-first browser automation, real Chrome attach, session persistence | Keep browser automation as an attachable capability rather than a hard-coded UI |

## 3. What Kyberion should copy

### 3.1 Surface should be easy to enter

Kyberion should keep the first-run surface shallow:

- voice and browser should be immediately usable
- image and document generation should be one click away
- message surfaces should preserve the sender identity and the reply authority

### 3.2 Skills should be shareable

Kyberion should treat skills as a shared bundle of:

- instructions
- examples
- scripts
- connectors or adapter references

That keeps the system repeatable across CLI, browser, and operator surfaces.

### 3.3 Collaboration should be durable

Kyberion should prefer durable work queues over transient “spawn a subagent and hope” loops.

Hermes Kanban is the clearest pattern to borrow:

- named worker
- explicit assignee
- shared board
- persistent handoffs
- task events

### 3.4 Control plane should stay separate

Kyberion should not collapse the control plane into the harness.
The control plane is where policy, budgets, approvals, audit trails, and global visibility live.

## 4. Security observations

The bigger the connector and skill surface, the more important the security gates become.

Risk areas that matter most for Kyberion:

- broken access control on shared skill and plugin surfaces
- authentication and authorization failures on remote entrypoints
- injection through prompts, documents, uploaded assets, or browser content
- security misconfiguration on loopback-only and local service endpoints
- logging and monitoring gaps for high-risk interactions
- server-side request forgery through browser, fetch, or connector layers
- unsafe consumption of provider APIs and plugin packages

The useful takeaway from OWASP is not just “scan dependencies”.
It is to keep:

- access control explicit
- secrets scoped
- input validation centralized
- logs and traces reviewable
- remote fetches allowlisted
- plugin and skill installation approval-aware

## 5. Kyberion conclusion

Kyberion should absorb the market in this order:

1. multimodal entry surfaces
2. shared skills and plugins
3. durable kanban-style collaboration
4. control-plane governance
5. browser and provider-native adapters behind the bridge layer

That keeps the product easy to use immediately while preserving the mission, policy, and trace model that make Kyberion different.

## 6. Sources

- OpenClaw releases: https://github.com/openclaw/openclaw/releases
- Hermes Kanban: https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban
- Hermes Skills: https://hermes-agent.nousresearch.com/docs/user-guide/features/skills
- OpenHands agent control plane: https://www.openhands.dev/blog/agent-control-plane
- Claude release notes: https://support.claude.com/en/articles/12138966-release-notes
- Gemini Spark and desktop local-files update: https://blog.google/innovation-and-ai/products/gemini-app/next-evolution-gemini-app/
- Codex app: https://openai.com/index/introducing-the-codex-app/
- browser-use CLI 2.0: https://github.com/browser-use/browser-use/releases
