---
title: Lockfile review — web-push (Web Push for the concierge PWA)
tags: [release-governance, lockfile, dependency, web-push, 2026-10]
last_updated: 2026-10-01
status: active
---

# Lockfile review: `web-push` (2026-10-01)

This record covers the one dependency addition in the Web Push PR.

## What was added

| Package                           | Version | Kind         | License | Install scripts |
| --------------------------------- | ------- | ------------ | ------- | --------------- |
| `web-push` (`@agent/core`, root)  | 3.6.7   | direct, prod | MPL-2.0 | none            |
| `asn1.js`                         | 5.4.1   | transitive   | MIT     | none            |
| `bn.js`                           | 4.12.5  | transitive   | MIT     | none            |
| `http_ece`                        | 1.2.0   | transitive   | MIT     | none            |
| `minimalistic-assert`             | 1.0.1   | transitive   | ISC     | none            |
| `@types/web-push` (`@agent/core`) | 3.6.4   | direct, dev  | MIT     | none            |

`web-push` also depends on `https-proxy-agent`, `jws` and `minimist`, which the
lockfile already resolved (no new versions of those).

The root `package.json` also lists `web-push`: the entry-point bundles under
`dist/scripts/` keep external packages external and resolve them from the
repository root, so a dependency imported only through `@agent/core` must be
declared there too (the first-win lifecycle smoke failed with
`ERR_MODULE_NOT_FOUND` without it).

## Why a library rather than our own

Web Push needs RFC 8291 payload encryption (`aes128gcm`) and RFC 8292 VAPID
signing. Hand-rolling either is the kind of cryptography this repository should
not write itself; `web-push` is the widely used Node implementation (source
repository `web-push-libs/web-push` per its package metadata; npm maintainer
`marco-c`). Its `dist.integrity` on the registry matches the lockfile entry.

## Checks performed

- **Install scripts**: none of the six packages defines `preinstall`, `install`
  or `postinstall` (checked on the registry metadata).
- **Audit**: `pnpm audit --prod` after the change reports one low finding
  (`dompurify`, reached through `chronos-mirror-v2 › @copilotkit`), which is
  identical to the result without this change. None of the new packages has an
  advisory.
- **Licenses**: MPL-2.0 (`web-push`, file-level copyleft, used unmodified as a
  dependency) and MIT / ISC for the rest.
- **Reach**: imported only from `libs/core/surface/web-push.ts`, which runs on
  the server. No browser bundle imports it (the concierge client uses the
  browser's own `PushManager`).

## How the dependency is contained

- Outbound requests only go to the known browser push services: the endpoint
  host is checked against an allowlist before anything is stored, so a
  client-supplied endpoint cannot make the server contact an arbitrary host.
- Payloads are content-free (a fixed title and line per event kind).
- Nothing is sent unless the operator has set the VAPID key pair in the
  environment.

## Accepted invocation

`PI_ALLOW_LOCKFILE_CHANGE=1 PI_LOCKFILE_REVIEW_EVIDENCE=docs/developer/improvement-plans-2026-10/LOCKFILE_REVIEW_2026-10-01-web-push.md pnpm check -- --scope pr`

- `pnpm-lock.yaml` sha256: afad32010318748fa15b2595b8d7860b3f11edf4b6d79ec681cb3284834fd272
