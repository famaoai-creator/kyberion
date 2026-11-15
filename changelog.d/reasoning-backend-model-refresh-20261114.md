---
category: Added
---

- **Reasoning backend model catalog refresh (2026-11-14)** — added `anthropic:claude-fable-5-2`, `anthropic:claude-fable-5-1`, `gemini:gemini-4-carbon`, `gemini:gemini-4-hydrogen`, `openai:gpt-6.1-terra`, and `gemini:gemini-3.1-flash-lite` (already the configured `gemini-fast` default) to the governed model registry with cost rates and provider capabilities; registered the current OpenCode free-tier set (`flint-40b`, `iceman`, `inkling-2-small`, `minimax-m3.1-flash`, `longcat-2.5`) as candidates; retired four OpenCode entries no longer in `opencode models` (`muse-spark-1.3-contributor-free`, `space-bunny-free`, `nemotron-3-ultra-free`, `longcat-2.5-preview-free`); repointed the OpenCode default model and `opencode-cli-default` route to `opencode/glm-5.3-flash-free`; added Gemini 4 Hydrogen, Claude Opus 5.5, and Claude Sonnet 5.5 to the `agy` provider capability list and `adaptive`/`swe-2`/`fable` aliases to `devin`. Existing defaults (GPT-6 Astra, Claude Opus 5.5) are unchanged.

Docs-sync resolutions for `pnpm check:docs-impact` (2026-11-15):

- `knowledge/product/governance/` ← `env-registry.json`, `model-cost-registry.json`, `model-registry.json`, `provider-config.json`, `reasoning-route-policy.json` — updated: `model-registry/README.md` now documents the coupled surfaces a model add/retire must move in the same change; the env-var surfaces (`docs/developer/CONFIGURATION.md`, `docs/developer/env.example`) were updated in this diff.
- `docs/COMPONENT_MAP.md` ← `libs/core/provider/opencode-cli-reasoning-backend.ts` — not applicable: the component map lists module paths and layer assignments, not model constants; the default-model change does not alter module structure.
- Unmapped path `ell past globalSetup snapshot#; s#  sleep 1$#  sleep 3#` — not applicable: pre-existing untracked stray file, unrelated to this change.
