---
title: Cross-Device Handoff Operations
category: Procedure
tags: [handoff, browser, ios, android, runbook, security]
importance: 7
last_updated: 2026-04-27
---

# Cross-Device Handoff Operations

Operational runbook for moving an authenticated runtime session between
Kyberion-managed surfaces (web browser, iOS WebView, Android WebView) without
re-authenticating and without leaking session state.

For envelope shape see [`schemas/cross-device-handoff.schema.json`](schemas/cross-device-handoff.schema.json).

## 1. When to Hand Off

Use a handoff only when **all** of the following hold:

1. The same human principal is operating both surfaces.
2. The target surface needs the source's session state to continue work
   (auth, scroll position, partially filled form, etc.).
3. The mission already exists and the handoff is recorded against it.

Do **not** use a handoff when:

- The principal differs (use re-authentication instead).
- The handoff would cross tenants (`confidential/{org}/` boundaries).
- The session was opened in an interactive workflow that the user has not
  acknowledged completing on the source surface.

## 2. Pipelines

| Pipeline | Direction |
|---|---|
| `pipelines/web-session-handoff-runner.json` | web → web (round-trip / template) |
| `pipelines/mobile-webview-handoff-runner-ios.json` | iOS WebView → web |
| `pipelines/mobile-webview-handoff-runner-android.json` | Android WebView → web |

Each pipeline calls the source actuator's `export_session_handoff` followed
by the target actuator's `import_session_handoff`. The envelope written
between them must conform to the cross-device handoff schema.

## 3. Operator Checklist

### 3.1 Before export

- [ ] `MISSION_ID` env is set to an active mission (handoff anchors to it).
- [ ] Mission tier matches the surface's tier (no public-tier handoffs of
      authenticated state).
- [ ] `expires_at` window is short — minutes, not hours.
- [ ] `policy.allowed_target_origins` lists only the destination origin.
- [ ] `policy.max_replay_count = 1` unless replay is explicitly required.

### 3.2 Before import

- [ ] Envelope `expires_at` is in the future.
- [ ] `target_surface.kind` matches the importing actuator.
- [ ] `policy.allowed_target_origins` includes the active origin.
- [ ] `audit.source_chain_tip` is recorded — record this on the importer's
      audit-chain as `parent_hash`.
- [ ] `surface_state.contract_ref` is one the importing actuator recognizes.

### 3.3 After import

- [ ] Verify the round-trip: re-export from the target, diff against the
      source envelope's `surface_state` modulo timestamps; investigate diffs.
- [ ] Append a `cross_device.handoff_imported` event to the mission's
      `audit-chain` with the `handoff_id`.

## 4. Failure Modes and Fallbacks

| Failure | Action |
|---|---|
| Envelope `expires_at` in past | Reject; emit `cross_device.handoff_expired` audit event; do not retry. |
| `surface_state.contract_ref` unknown | Reject; emit `cross_device.handoff_unsupported_contract`. |
| `policy.allowed_target_origins` mismatch | Reject; emit `cross_device.handoff_origin_mismatch`. |
| `audit.source_chain_tip` missing or unreachable | Apply `policy.fallback_behavior`. |
| Secret in `secret_refs` cannot be resolved | Apply `policy.fallback_behavior`. Default = `reject_and_log`. |
| Surface state corrupt or schema-invalid | Reject; treat as a security event (see §6). |

`fallback_behavior = prompt_operator` should only be used during
operator-attended workflows; never in unattended pipelines.

## 5. Replay and Expiry

- `max_replay_count` is enforced by the target actuator. The importer
  maintains a small persistent dedup ring (handoff_id → first-import
  timestamp).
- Envelopes older than `expires_at` are deleted from the dedup ring.
- The dedup ring lives under
  `active/missions/{tier}/{mission_id}/evidence/handoff-dedup.jsonl` so it is
  rotated with the mission.

## 6. Security Considerations

- Secret values (cookies, tokens) **must not** be embedded in the envelope.
  Use `secret_refs` and resolve via `SecretResolver` at the importer.
- The envelope is recorded in the mission's audit-chain. Treat the chain
  itself as in-scope for the same compliance regime as the session it carries.
- A handoff is a privilege-elevation primitive. A SECURITY_READY review gate
  should fire on the mission whenever a handoff is added to a previously
  un-handed-off flow.
- Handoffs across tier boundaries (`personal` ↔ `confidential` ↔ `public`)
  are forbidden by `policy-engine`.

## 7. Producing a Handoff (developer notes)

To wire a new surface for handoff:

1. Define a `surface_state` contract for that actuator. Publish it as
   `schemas/<surface>-handoff-state.schema.json` with a versioned
   `contract_ref`.
2. Implement `export_session_handoff` in the actuator: read the actuator's
   live state, fill the envelope with `envelope_version: "1.0.0"`,
   `surface_state.contract_ref`, expiry, and the dedup-friendly
   `handoff_id`.
3. Implement `import_session_handoff`: validate the envelope against
   `schemas/cross-device-handoff.schema.json`, look up `contract_ref`,
   apply state.
4. Add an example to `libs/actuators/<surface>/examples/` and reference the
   pipeline from `pipelines/`.
5. Add a contract test under `libs/actuators/<surface>/src/index.test.ts`
   that validates a representative envelope.

## 8. Reference

- [`schemas/cross-device-handoff.schema.json`](schemas/cross-device-handoff.schema.json)
- [`pipelines/web-session-handoff-runner.json`](pipelines/web-session-handoff-runner.json)
- [`pipelines/mobile-webview-handoff-runner-ios.json`](pipelines/mobile-webview-handoff-runner-ios.json)
- [`pipelines/mobile-webview-handoff-runner-android.json`](pipelines/mobile-webview-handoff-runner-android.json)
- [`libs/actuators/browser-actuator/examples/web-runtime-session-handoff-export-template.json`](libs/actuators/browser-actuator/examples/web-runtime-session-handoff-export-template.json)
- Audit-chain integration: [`libs/core/audit-chain.ts`](libs/core/audit-chain.ts)
- Secret resolution contract: [`libs/core/secret-resolver.ts`](libs/core/secret-resolver.ts)
