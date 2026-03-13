# Kyberion Glossary

This glossary translates Kyberion's ecosystem language into practical terms for contributors and operators.

## Core concepts

### Sovereign

The human owner/operator whose intent the ecosystem serves.

### Sovereign Entity

The autonomous agent persona defined by `AGENTS.md`. It is the acting identity of the system, not just a collection of scripts.

### Charter

The governance rules in `AGENTS.md`. These rules define safety, lifecycle, tier isolation, and execution constraints.

### Actuator

A concrete execution component under `libs/actuators/` that performs physical work such as file I/O, browser automation, network access, or orchestration.

### Procedure

Distilled operational knowledge or reusable method stored in the knowledge tier, often used to guide actuator behavior.

### ADF (Agentic Data Format)

A human-readable structured contract between reasoning and execution layers. In Kyberion, ADF is preferred over opaque script fragments.

### Mission

A bounded unit of work with lifecycle state, evidence, and history. Mission operations are managed through `scripts/mission_controller.ts`.

### KSMC (Kyberion Sovereign Mission Controller)

The mission lifecycle controller referenced in the charter. It handles mission start, checkpoints, finish, and transactional safeguards.

## Lifecycle terms

### Onboarding

The phase where environment safety and identity are established, typically via `pnpm onboard`.

### Alignment

The planning and intent-definition phase. Work should not begin physically until goals and strategy are clear.

### Recovery & Resilience

The automatic resume/self-healing phase entered when a stale `.kyberion.lock` or interrupted mission state is detected.

### Mission Execution

The phase where actual changes are made and validated.

### Review & Distillation

The cleanup and learning phase where results are preserved as reusable wisdom.

## Architecture terms

### Brain

The reasoning/planning layer that interprets intent, chooses procedures, and shapes execution.

### Spinal Cord

The actuator layer that performs the physical work chosen by the reasoning layer.

### Nerve System

Kyberion's background messaging, daemon, and observability model. See `docs/architecture/NERVE_SYSTEM_GUIDE.md`.

### Reflex

A predefined automatic response, often expressed declaratively in ADF instead of TypeScript.

### Pulse

A shared runtime health/state signal, commonly surfaced through files like `active/shared/runtime/pulse.json`.

## Governance and storage terms

### Tier Isolation

The rule that Personal, Confidential, and Public data must stay physically separated.

### Personal Tier

Private, user-specific data under `knowledge/personal/`, including identity and private context.

### Confidential Tier

Sensitive organizational or client-specific data stored separately from public knowledge.

### Public Tier

Reusable shared knowledge, governance, and procedures intended for broad reuse within the ecosystem.

### Micro-Repo

An independently managed Git-backed mission workspace used to reduce leakage and improve rollback safety.

### Sovereign Shield

The combined protection model around tier isolation, operational governance, and safe execution boundaries.

### Sudo Gate

The requirement for explicit sovereign approval before riskier or architectural actions are taken.

## Practical entrypoints

### Onboarding Wizard

`scripts/onboarding_wizard.ts`, the interactive setup for identity and initial user configuration.

### Capability Discovery

`scripts/capability_discovery.ts`, which inspects actuator manifests and environment compatibility.

### Mission Journal

`scripts/mission_journal.ts`, the human-readable view over recorded mission history.

### Global Skill Index

`knowledge/public/orchestration/global_skill_index.json`, the compact registry of runnable actuators/skills used by the CLI.
