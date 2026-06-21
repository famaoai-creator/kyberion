# Intent Learning Seed Cache Plan

This document locks the migration plan for treating existing hardcoded intent rules as seed or predefined cache data.

No runtime behavior change in this PR.

## Current hardcoded sources

- `libs/actuators/orchestrator-actuator/src/super-nerve/resolver.ts`
- `knowledge/product/governance/standard-intents.json`
- `libs/core/contextual-intent-frame.ts`
- `libs/core/contextual-intent-learning.ts`

## What can move first

- Static pipeline mappings that already exist in `standard-intents.json`
- Catalog-backed intent definitions with deterministic pipeline steps

## What should stay in code for now

 - Keep start-service and stop-service command construction in code
- Any procedural logic that assembles shell commands from text
- Security-sensitive or parameterized action shaping

## Proposed seed cache shape

- Public seed file under `knowledge/product/governance/`
- `source: seed`
- `tier: public`
- confirmed examples only
- shared schema-compatible fields for utterance, intent, action, object, subject, locale, and optional date/source binding data

## Proposed merge order

1. Move deterministic static pipeline mappings first.
2. Keep procedural command construction in code.
3. Add a public seed cache fixture.
4. Use confirmed learning records as few-shot examples later.

## Safety boundaries

- Personal data stays in `knowledge/personal/`
- Project-internal data stays in `knowledge/confidential/{project}/`
- Public seed data must not include personal or confidential examples

## Non-goals

- No runtime behavior change
- No resolver order changes
- No schema expansion beyond what is needed for the seed fixture
