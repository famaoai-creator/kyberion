---
title: pnpm lockfile review evidence 2026-10-10 @simplewebauthn (HA-07)
tags: [release-governance, lockfile, security, approval, 2026-10]
last_updated: 2026-10-10
status: active
---

# pnpm lockfile review evidence (2026-10-10 @simplewebauthn, HA-07)

This file is the explicit review evidence required by `check:lockfile-commit-gate` for the HA-07 passkey change.

- **Reason for update**: HA-07 of [HUMAN_APPROVAL_TRUST_PLAN](./HUMAN_APPROVAL_TRUST_PLAN_2026-10-05.ja.md) implements WebAuthn passkey approval (A3). Plan decision 3 adopts `@simplewebauthn/server` with a lockfile review instead of a hand-rolled CBOR/COSE implementation.
- **Specifiers added**: `@simplewebauthn/server@^13` in `libs/core/package.json`; `@simplewebauthn/browser@^13` in `presence/displays/concierge/package.json`.
- **New packages (22)** — all pure JavaScript, none declares a `preinstall` / `install` / `postinstall` script:
  - `@simplewebauthn/server@13.3.3` (MIT), `@simplewebauthn/browser@13.3.0` (MIT)
  - `@levischuck/tiny-cbor@0.2.11` (MIT), `@hexagon/base64@1.1.28` (MIT)
  - `@peculiar/x509@1.14.3`, `@peculiar/utils@2.0.3`, `@peculiar/asn1-{schema,x509,x509-attr,ecc,rsa,android,cms,csr,pfx,pkcs8,pkcs9}@2.10.0` (MIT)
  - `asn1js@3.0.10` (BSD-3-Clause), `pvtsutils@1.3.6` (MIT), `pvutils@1.2.0` (MIT), `tsyringe@4.10.0` (MIT), `tslib@1.14.1` (0BSD, `tsyringe` range)
- **Diff review**: the lockfile delta only adds the rows above and the two importer specifiers. No existing package version, `patchedDependencies`, or override changed. `pinned-deps` and `install-script-allowlist` gates pass.
- `pnpm-lock.yaml` sha256: 4c6f5742b3bd89aae660c1fbd9265088c653095332a9306a362acc6d717a532b
- The accepted invocation is `PI_ALLOW_LOCKFILE_CHANGE=1 PI_LOCKFILE_REVIEW_EVIDENCE=docs/developer/improvement-plans-2026-10/LOCKFILE_REVIEW_2026-10-10-simplewebauthn.md pnpm check -- --scope pr`.
