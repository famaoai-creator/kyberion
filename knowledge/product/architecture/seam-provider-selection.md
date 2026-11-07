---
title: Seam Provider Selection — Choosing Between Providers of the Same Function
kind: reference
scope: repository
authority: reference
phase: [alignment, execution]
tags:
  [
    seam,
    provider,
    selection,
    calibration,
    operator-rules,
    browser,
    ocr,
    stt,
    tts,
    image,
    video,
    music,
    vad,
    governance,
    audit,
    saved-defaults,
    tenant,
  ]
owner: ecosystem_architect
last_updated: 2026-11-04
---

# Seam Provider Selection

Several seams have providers that do the same job with different
capabilities and characteristics — Chromium vs Lightpanda, WhisperKit vs
mlx_whisper, apple_vision vs tesseract, kokoro vs mlx_audio_qwen3, … Choosing
between them is **deterministic**, **audited**, **pinned per mission** and,
where nobody knows the right answer yet, **decided by a human after a
side-by-side calibration run**. It is not an LLM judgment.

Code: `libs/core/provider/seam-provider-selection.ts` (decision),
`libs/core/provider/seam-selection-rules.ts` (operator rules + measured traits),
`libs/core/provider/seam-calibration.ts` (calibration runner),
`libs/core/provider/provider-pins-store.ts` (mission pins). Product policy: one file per
seam under `knowledge/product/governance/seam-provider-selection/<seam>.json`.
Operator overlay: `active/shared/runtime/seam-selection/rules.json` — shared
runtime storage because every role that selects a provider (worker,
surface_runtime, …) must read it; the personal tier is not readable by those
roles. It holds preferences and measured numbers, not personal data, can only
reorder providers that already passed each seam's hard filter, and every
change is audited (`action: seam_selection_rule_change`).
`KYBERION_SEAM_SELECTION_RULES_PATH` overrides the path for direct script runs
and tests (`pnpm kyberion` does not forward it). CLI:
`pnpm kyberion seam select …`.

## Decision order

1. **Hard filter (code truth).** The seam's caller marks every provider
   eligible or not from what the task needs (capabilities, availability,
   language, egress, identity class, …) with short `unmet` reasons.
2. **Mission pin.** A choice pinned earlier in the mission under the same
   decision key is reused while it is still eligible (never overwritten by a
   one-off fallback).
3. **Operator rule.** The most specific rule whose `purpose` / `context`
   (e.g. `language=ja`) matches wins; its preferred providers lead in order,
   ineligible ones are skipped.
4. **Purpose ranking.** `Σ weight(purpose, trait) × trait(provider)` using the
   policy's declared traits, replaced by the operator's **measured** values
   where they exist (the rationale prints each basis).
5. **Default.** No purpose → the caller's own configured default (a domain
   store such as engine-runtime-preferences or the voice profile), else the
   **saved seam default** (next section), else the policy default — the
   first _eligible_ provider of `default_chains[<order key>]` /
   `default_chains.default`, else `default_provider`. If none can run the
   task, the policy's `fallback_purpose` ranks what can. The rest of
   `ranked` follows the policy chain order.

Every decision is recorded in the audit chain (`action: provider_selection`,
operation `<seam>/<provider>`, with eligible / excluded / scores / ranked /
rule / rationale). Seams that walk a fallback chain use `decision.ranked`.

## Saved defaults — "use X for this seam unless told otherwise"

A human can save a default provider per seam, layered by scope
(`libs/core/provider/seam-selection-defaults.ts`). The first layer that names the seam
wins:

| Layer          | Where                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| `env`          | `KYBERION_SEAM_DEFAULTS="seam=provider;seam2=provider"` (process-level; CI, direct runs)              |
| `project`      | scope partition file, `projects[<project_id>]`                                                        |
| `organization` | scope partition file, `organizations[<organization_id>]`                                              |
| `tenant`       | scope partition file, `defaults`                                                                      |
| `operator`     | `active/shared/runtime/seam-selection/defaults.json` (beside the rules)                               |
| (policy)       | `default_chains` / `default_provider` of the governed policy — the shared baseline, not a saved layer |

The scope partition file is
`active/shared/runtime/seam-selection-defaults/<tier>/<tenant|shared>/defaults.json`
(`confidential/<tenant>` with a tenant, `public/shared` without), a registered
partitioned runtime-state root: tier-guard applies the tenant's permissions,
another tenant never sees it, and tenant offboarding purges it. The scope
comes from `currentScope()` (`KYBERION_TENANT` / organization / project).

Semantics — a saved default is **soft**:

- it applies only when the call names no provider and no purpose; mission
  pins and operator rules still win (a rule with an empty `when` _forces_ a
  provider even over purposes — that is what rules are for, not defaults);
- eligibility always decides; an ineligible saved default falls back to the
  policy default and the rationale says why
  (`saved default (tenant) 'x' cannot run this task (…)`);
- a saved default opts the call into governed selection, so the choice is
  audited (`default_source` in the decision) and pinned inside a mission;
- an unreadable layer (no permission, invalid file) is skipped with one
  warning; selection never breaks because of an overlay.

```bash
pnpm kyberion seam select defaults list [--seam S] [--tenant T] [--organization O] [--project P]
pnpm kyberion seam select defaults set --seam ocr-provider --provider tesseract            # operator
pnpm kyberion seam select defaults set --seam ocr-provider --provider llm_api --tenant acme # tenant
pnpm kyberion seam select defaults set --seam lease-backend --provider local-file-lock \
     --tenant acme --project billing                                                       # project
pnpm kyberion seam select defaults unset --seam ocr-provider --tenant acme
```

`--layer` defaults to the most specific layer the flags name. Providers are
validated against the policy's `providers`. Changes are audited
(`action: seam_selection_default_change`).

Consumers get this for free through `resolveSeamSelectionEntry` /
`resolveSeamProviderDecision` and `ProviderChainRouter` (the saved default
_leads_ the policy chain). Seams that walk their own chain or pick a single
implementation use `resolveSeamDefaultOrder(seam, { orderKey, builtin })` /
`resolveSeamDefaultProvider(seam, { eligible, builtin })`; the `builtin`
constant is only the hermetic fallback when no policy is present — never a
second source of truth. `seam-policy-consistency.test.ts` keeps
`default_provider` inside `default_chains.default` and every policy in
`index.json`.

**Compatibility contract.** Callers select only when a purpose is given, an
operator rule **matches this request**, or the default cannot run the task.
A saved seam default also opts in. Otherwise routing is byte-for-byte what it
was (rules that exist but do not match change nothing). An explicitly named provider always wins.

## When no rule is known: calibrate, then let a human decide

```bash
pnpm kyberion seam select list                       # seams, purposes, adapters, rules
pnpm kyberion seam select calibrate --seam ocr-provider --input sample.json [--providers a,b] [--repeats 3]
#  → active/missions/{tier}/{tenant-or-shared}/<mission>/evidence/seam-calibration/<seam>/<run>/report.md
#    (+ report.json, artifacts); mission-less probes use active/shared/tmp/seam-calibration/
#    and reports redact content-bearing inputs, transcripts and trial errors.
pnpm kyberion seam select rules set --seam ocr-provider --rule-id ocr-ja --context language=ja \
     --prefer tesseract,apple_vision --evidence <report.json> --note "…"
pnpm kyberion seam select apply-measurements --report <report.json> [--traits latency,accuracy]
pnpm kyberion seam select explain --seam ocr-provider --purpose accuracy --context language=ja
```

- Calibration runs the same input on every eligible provider (paid or
  off-machine providers only when listed in `--providers`), measures latency
  plus adapter metrics (e.g. character error rate against a reference text),
  keeps the artifacts for listening/viewing, and suggests measured trait
  values (min–max normalised across providers).
- The human records the outcome either as a **rule** (a preference for a
  purpose / context) or as **measured traits** (so purpose ranking uses real
  numbers). Both are written as `sovereign_concierge` to the operator
  overlay; the product policy stays the shared baseline. When all providers
  measure the same on a metric, all get 1 (none is worse).

## Seams wired in

| Seam (policy file)           | How callers opt in                                                                | Purposes                                    | Eligibility (hard filter)                                                                             | Calibration metrics                |
| ---------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `browser-automation-runtime` | `options.runtime_purpose`; CLI `--browser-purpose`                                | evidence, throughput, authenticated         | pipeline ops/options vs runtime capabilities                                                          | success, latency                   |
| `image-generation-provider`  | `purpose` (`generate_image`)                                                      | quality, speed, privacy, cost               | `mode`, availability, host hand-off only with `allow_host_handoff`                                    | artifact, latency                  |
| `video-generation-provider`  | `purpose` (`generate_video`)                                                      | quality, speed, cost, privacy               | credentials, first/last frame, aspect ratio, audio; no fallback purpose (never a paid model silently) | artifact, latency                  |
| `music-generation-provider`  | `purpose` (`generate_music`, no `backend_id`)                                     | quality, speed                              | availability, max duration, output format                                                             | artifact, latency                  |
| `ocr-provider`               | `purpose` (`ocr_image`); rules match `language`                                   | accuracy, speed, privacy, cost              | `mode` egress, availability                                                                           | CER vs expected text, latency      |
| `speech-to-text-bridge`      | `purpose` (`transcribe*`); rules match `language`                                 | accuracy, latency, privacy                  | timestamps granularity, local_only, language, synthetic                                               | CER vs reference, latency          |
| `streaming-stt-bridge`       | `--stt-purpose`; used when env unset and a stub is not acceptable                 | accuracy, latency, privacy                  | local_only, language, synthetic                                                                       | CER, final chunks, latency         |
| `voice-hub-stt`              | voice-hub `resolveVoiceSttBackendOrder` options                                   | accuracy, latency, privacy                  | availability probes                                                                                   | —                                  |
| `voice.vad-backend`          | `resolveVadBackend(id, { purpose })`; `--vad-purpose`                             | accuracy, light                             | probe                                                                                                 | — (needs labelled speech segments) |
| `voice-tts-engine`           | `purpose` / `language` (`speak_local`, `generate_voice` with `engine_id: 'auto'`) | naturalness, latency, privacy               | status, platform, format, runtime adapter, text language, local_only, identity class                  | artifact (listen), latency         |
| `streaming-tts-bridge`       | `selectStreamingTtsBridge`                                                        | per policy                                  | languages, local_only, synthetic                                                                      | —                                  |
| `authn-principal-resolver`   | `resolveAuthnPrincipal(request, { purpose, context })`                            | local_dev, remote_human, …                  | credential type, loopback proof, agent/human principals, IdP config, zero-config                      | —                                  |
| `authz-policy-engine`        | `authorizeWithPolicyEngine(query, { purpose, context })`                          | default_surface, membership, lockdown, test | principal kinds, effects, tenant/member awareness, requiresConfig                                     | —                                  |

AuthN/AuthZ usage (requests, providers, env knobs, surface wiring contract):
[authn-authz-seams](./authn-authz-seams.md).

Explicit choices that always win: `browser_runtime`, `providerPreference` /
`backend_id`, voice `engine_id` / `backend`, `KYBERION_VAD`,
`KYBERION_STREAMING_STT_BRIDGE`, `KYBERION_STREAMING_TTS_BRIDGE`,
`VOICE_HUB_STT_PREFERENCE`, operator preference files.

**TTS identity guard.** A personal voice (clone tier) is never switched for
preference. If its engine cannot run the request, only another **local**
clone engine may take over with the same reference samples; otherwise the op
is blocked with the reason. Stock voices switch only among stock engines.

Not wired: camera / audio bus / calendar / meeting drivers (device-, platform-
or account-bound — nothing to choose between).

## Traits must say where their numbers come from

Every trait value carries `trait_basis: measured | declared` plus `evidence`.
All product-policy values are `declared` today (no per-provider measurements
exist in the repo); calibration + `apply-measurements` is how an operator
turns them into `measured` values for their own environment.

## Adding another seam

1. Give its providers capability declarations the caller can check.
2. Add `knowledge/product/governance/seam-provider-selection/<seam>.json`
   (`seam_id`, `default_provider`, `default_chains.default` when the order
   matters, optional `fallback_purpose`, `traits`, `providers` with traits +
   basis + evidence, `purposes`) and append the id to `index.json`. Never
   copy the default into code except as the `builtin` hermetic fallback.
3. In the caller, build `{ id, eligible, unmet }` candidates and call
   `resolveSeamProviderDecision({ seam, candidates, purpose, context, decisionKey })`
   only under the compatibility contract above; write the chosen id back
   where downstream code reads it so nested calls do not re-select.
4. Add a calibration adapter under `scripts/lib/seam-calibration/<seam>.ts`
   and register it in `scripts/lib/seam-calibration-adapters.ts`.
