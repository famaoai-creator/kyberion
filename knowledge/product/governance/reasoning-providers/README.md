---
title: 'Reasoning Provider Registry Canonical Directory'
last_updated: 2026-10-05
---

# Reasoning Provider Registry Canonical Directory

Canonical source for reasoning provider descriptors (RSP-20).

- One provider per file: `{mode}.json` (file name must match `mode`).
- Each file carries the shared envelope (`version`) plus a single-element
  `providers` array, validating against
  `knowledge/product/schemas/reasoning-provider-registry.schema.json` as-is.
- The legacy single file `reasoning-provider-registry.json` has been removed
  (snapshot abolished). Loader: `libs/core/reasoning/reasoning-provider-registry.ts`
  (`KYBERION_REASONING_PROVIDER_REGISTRY_DIR` / `KYBERION_REASONING_PROVIDER_REGISTRY_PATH`).

- `index.json` pins the canonical item order (model-registry precedent); loaders require an exact set match.

## Single source of truth (RS-01)

Every per-provider table is derived from these descriptors — do not add a
provider list, switch, or map in TypeScript. Fields:

| Field                                                                | Consumers                                                                                                              |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `transport`, `data_egress`, `capabilities`, `profile`                | backend capability profile (`backend-capability-profile.ts`), route capabilities, utility fit                          |
| `adapter` (+ `openai_compatible_preset`)                             | readiness probes (`reasoning-provider-readiness.ts`), env probe, route doctor, API / OpenAI-compatible bundle builders |
| `cli.binary`, `cli.version_args`, `cli.help_args`, `cli.bin_env_key` | env probe, conformance matrix, `providerCliBinary`, managed provider CLIs                                              |
| `cli.sandbox`                                                        | opt-in sandbox-enforcement probe (`{prompt}` / `{permission_args}` tokens)                                             |
| `cli.install`                                                        | `pnpm` managed provider CLI install metadata                                                                           |
| `cli.discovery`                                                      | chain construction skips CLIs that provider discovery reports absent                                                   |
| `cli.model_flag`                                                     | pane-agent model forwarding                                                                                            |
| `aliases`, `model_vendor`                                            | identifier resolution (runtime backend names, model-registry vendors)                                                  |
| `endpoint`, `egress_provider_id`                                     | reasoning egress gate; omitted endpoint fails closed                                                                   |
| `model_env_keys`                                                     | per-mode model env override precedence                                                                                 |
| `setup_hint`, `runtime_instructions`                                 | route doctor remediation, worker prompt provider notes                                                                 |

Adding a provider that reuses an existing adapter is a registry-only change:
add `{mode}.json`, append the mode to `index.json`, and (when it should be
selectable) to `reasoning-backend-policy.json` `allowed_modes`. An incomplete
descriptor fails closed at load with
`[REASONING_PROVIDER_REGISTRY_INVALID] <mode>: <reason>`. A genuinely new
protocol adds one id to the schema `adapter` enum plus one adapter
implementation. `libs/core/reasoning/reasoning-provider-ssot.test.ts` proves a
synthetic provider is accepted end-to-end and guards against re-hardcoded
provider lists.
