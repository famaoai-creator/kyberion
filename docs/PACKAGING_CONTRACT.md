# Packaging Contract

Kyberion uses `pnpm` workspaces, but runtime code must not depend on workspace layout details.

This document defines the package-boundary rules that keep builds stable across Node, Next, scripts, and tests.

## ESM Discipline

Kyberion's runtime contract is ESM-first.

- `package.json` in governed runtime packages must declare `type: "module"`
- runtime code imports exported packages by package name
- relative TS imports include `.js` extensions
- source trees must not keep legacy shadow `.js` artifacts beside `.ts` siblings

The enforcement command is:

```bash
pnpm run check:esm
```

This check is part of `pnpm run validate` and CI.

## Rules

### Runtime code imports by package name

Allowed:

```ts
import { logger } from "@agent/core";
import { safeReadFile } from "@agent/core/secure-io";
```

Forbidden:

```ts
import { logger } from "../libs/core/index.js";
import { safeReadFile } from "@agent/core/src/secure-io.js";
import { safeReadFile } from "@agent/core/dist/secure-io.js";
import { safeReadFile } from "@agent/core/secure-io.js";
```

These runtime restrictions apply to:

- `scripts/`
- `libs/actuators/`
- `presence/displays/`
- `satellites/`

### Tests may source-import the module under test

Tests are allowed to import local source modules directly when the test is explicitly targeting that module's behavior.

Allowed in tests:

```ts
const { ensureMissionTeamRuntime } = await import("../libs/core/mission-team-orchestrator.js");
```

This is a white-box exception, not a general convenience rule.

- keep it narrow
- keep it source-local to the module under test
- prefer public package imports for shared helpers
- add or update the whitelist in `tests/package-boundary-contract.test.ts` when introducing a new exception

The preferred shape is still:

- use `@agent/core` public entrypoints in tests whenever possible
- use white-box source imports only when a package subpath cannot express the test cleanly

Still forbidden in tests:

```ts
import { safeReadFile } from "@agent/core/src/secure-io.js";
import { safeReadFile } from "@agent/core/dist/secure-io.js";
import { safeReadFile } from "../libs/core/dist/secure-io.js";
```

### `exports` is the runtime contract

If runtime code needs a symbol and no public export exists:

1. add a public export
2. consume the public export

Do not bypass the package with `src` or `dist` imports.

For `@agent/core`, this also means:

- do not rely on wildcard `exports`
- every consumed subpath should be explicitly declared in `libs/core/package.json`
- package subpath imports should be extensionless, for example `@agent/core/secure-io`
- package-boundary tests should fail if a new subpath is used without an explicit export

### Apps may use adapters

Bundler-sensitive apps such as Next surfaces may add local adapters.

The adapter must still import only public package entrypoints.

### Build layout is internal

Package-local `dist/` exists for builds, but consumers must not import from it directly.

### Root `imports` must not emulate workspace packages

Do not use root `package.json#imports` hacks to create fake support for package names like `@agent/core`.

Workspace package resolution must come from:

- `pnpm` workspace linking
- package `exports`
- TypeScript path mapping only as editor/typecheck support

### TypeScript `paths` are editor support, not a package contract

App-local `tsconfig.json` may map `@agent/core` to workspace source for typecheck and bundler support.

That does not change the runtime contract:

- consumers still import `@agent/core`
- only `package.json#exports` defines the public API
- `src/` and `dist/` remain internal layout details

## Recommended split

- `libs/*`
  - package-first
- `presence/displays/*`, `satellites/*`
  - adapter-first if needed
- mission/runtime/surface control
  - API/event/process-first

This keeps:

- package boundaries explicit
- bundler-specific workarounds local
- orchestration ownership deterministic

## `@agent/core` public subpath catalog

Use extensionless subpaths only.

### Common runtime helpers

- `@agent/core`
- `@agent/core/core`
- `@agent/core/types`
- `@agent/core/shared-business-types`

### Secure I/O and local utilities

- `@agent/core/secure-io`
- `@agent/core/fs-utils`
- `@agent/core/cli-utils`
- `@agent/core/path-resolver`
- `@agent/core/validate`
- `@agent/core/validators`

### Agent runtime and orchestration

- `@agent/core/agent-lifecycle`
- `@agent/core/agent-manifest`
- `@agent/core/agent-registry`
- `@agent/core/agent-runtime-supervisor`
- `@agent/core/runtime-supervisor`
- `@agent/core/managed-process`
- `@agent/core/provider-discovery`
- `@agent/core/a2a-bridge`
- `@agent/core/acp-mediator`
- `@agent/core/channel-surface`
- `@agent/core/surface-runtime`
- `@agent/core/mission-team-composer`
- `@agent/core/mission-team-orchestrator`
- `@agent/core/mission-orchestration-events`

### Contracts and policy helpers

- `@agent/core/pipeline-contract`
- `@agent/core/trust-engine`
- `@agent/core/secret-guard`
- `@agent/core/entropy-gate`
- `@agent/core/network`
- `@agent/core/reflex-terminal`

If a new subpath is needed:

1. add it to `libs/core/package.json#exports`
2. use the extensionless form in code
3. keep `tests/package-boundary-contract.test.ts` passing
