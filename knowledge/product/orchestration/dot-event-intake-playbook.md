---
title: 'Dot Event Intake Playbook — enabling a source end to end'
tags: [orchestration, dots, event-intake, feed, webhook, operations, playbook]
last_updated: 2026-11-16
runtime_stages: [execution]
---

# Dot Event Intake Playbook

How to take an intake source from nothing to a dot actually waking — declaration,
secret, enablement, verification, live test, and the failure triage table.
Architecture and semantics live in [event-feed-intake](../architecture/event-feed-intake.md)
and [resident-dot-model](../architecture/resident-dot-model.md); this page is the
operational sequence. Invariants: tenant binding always comes from the policy, never
the payload; every source ships disabled; stored payloads are 16 KB max and treated
as untrusted input.

## 0. Pick the intake shape

| If the source…                                                          | Shape                                                     | Effort           |
| ----------------------------------------------------------------------- | --------------------------------------------------------- | ---------------- |
| can POST a webhook with HMAC-SHA256                                     | push source in `event-intake-policy.json`                 | declaration only |
| only answers when asked (search, list, ticket query)                    | `kind: 'feed'` trigger over a service preset              | declaration only |
| is internal to one tenant (no webhook at all)                           | tenant overlay `local_only` source + `ingestLocalEvent`   | declaration only |
| needs signature verification beyond HMAC-SHA256, or a new reaction axis | extend `verifyInboundSignature` / add a `DotTrigger` kind | code             |

## 1. Push source (webhook)

1. **Declare** the source in `knowledge/product/governance/event-intake-policy.json`
   (`sources.<id>`): `signature_header`, `prefix`, `secret_key`,
   `event_type_header`, `delivery_id_header`, `max_body_bytes`, `enabled: false`.
   Add `tenant_slug` to bind the source to one tenant (events land under
   `runtime/dot/tenants/<slug>/` and only that tenant's dots see them).
2. **Register the secret** — the `secret_key` value must exist in the secret
   store: `pnpm secret introduce event-intake <SECRET_KEY>` (service id
   `event-intake`). Never paste the secret into the policy file.
3. **Wire the dot** — in the charter's `attention.triggers`:
   `{ "kind": "event", "sources": ["<id>"], "types": [...], "match": {...} }`.
   `types` filters on the event-type header; `match` filters on a payload
   `json_path`. Run `pnpm kyberion dot validate <dot_id>`.
4. **Enable** on this host: `enabled: true` in the policy, or
   `KYBERION_EVENT_INTAKE_SOURCES=<id>` (host opt-in, checked by the intake
   plan). Start the intake surface (`scripts/event_intake_surface.ts`) if it is
   not already running.
5. **Verify declared state** — `pnpm kyberion dot intake` must show the row
   `ARMED yes` with `enablement: <mechanism>`. `armed: no` explains itself
   (see triage below).
6. **Live test** — `pnpm kyberion dot event ingest --source <id> --file <event.json> --type <t>`
   exercises the same ledger/dedupe path without a signature; then a real
   signed POST to `POST /events/<id>` proves the end-to-end path. Watch the
   wake land in `dot-wake-ledger.jsonl` and `dot status`.

## 2. Pull feed

1. **Declare the source** in the intake policy (or a tenant overlay for a
   tenant-local feed). The feed ingests under this `source` id.
2. **Check the service preset** — `knowledge/product/orchestration/service-presets/<svc>.json`
   must contain the `service_id` and a read-only `action`. Missing service →
   author a preset (`service_id`, `base_url`, `auth_strategy`, `operations`).
3. **Charter wiring** — a `feed` trigger (`source`, `service_id`, `action`,
   `params`, `items_path`, `item_id_path`, `cursor_path`, `every_s`,
   `on_first_poll`) plus a matching `event` trigger on the **same source** —
   `dot validate` rejects a feed without one.
4. **Verify** — `pnpm kyberion dot intake` shows the pull row with coverage:
   `baseline` recorded after the first poll; `stalled` after repeated failures.
   Coverage is evidence of the last successful poll, not a backlog count.

## 3. Tenant-local source (overlay)

Declare the source (same shape as the product policy) in the tenant's
governance overlay file. The merge marks it `local_only` (the webhook never
accepts it) and binds it to that tenant — a different `tenant_slug`, a product
source name, or a name another tenant also claims drops the declaration with a
warn. Ingest via `ingestLocalEvent` or `pnpm kyberion dot event ingest`.

## 4. Failure triage

| Symptom in `dot intake` / logs      | Cause                                                                | Fix                                                                                  |
| ----------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `armed: no`, `enablement: disabled` | source not enabled on this host                                      | `enabled: true` in policy or `KYBERION_EVENT_INTAKE_SOURCES`                         |
| 401 on the webhook                  | bad/unknown signature or disabled source (identical by design)       | check the secret key in the secret store and the signature headers                   |
| `duplicate` result                  | same `source+delivery_id` or payload digest inside the replay window | expected; lower `replay_window_hours` only if the sender legitimately repeats bodies |
| feed row `stalled`                  | provider or binding failing                                          | check `feed/<specId>.json` `last_error`, preset credentials, provider health         |
| `dot validate` rejects the charter  | `feed` without a matching `event` trigger on the same source         | add the event trigger — a feed cannot wake a dot by itself                           |
| watcher re-fires on its own rows    | dot watches an append-only store it writes to                        | add `ignore_jsonl_kinds` for its record kinds (see Watches in resident-dot-model)    |
| events ingested, no wake            | no charter trigger matches source/type/match                         | `pnpm kyberion dot intake` shows declared-vs-subscribed; check `types`/`match`       |

## 5. Operate

- The event ledger is `active/shared/runtime/dot/events.jsonl` (system floor)
  or `…/tenants/<slug>/events.jsonl` (tenant-bound sources); undelivered alert
  rows dedupe via `ops-alerts.dedupe.json`.
- `pnpm kyberion dot event continue <dot_id>` resumes a quiesced event wake
  after the cause is fixed.
- `pnpm kyberion dot intake` is the review step before enabling anything: a row
  that is `armed: false` or `stalled` explains itself instead of failing
  silently at 3 a.m.
