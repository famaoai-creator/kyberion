---
title: The Kyberion Runtime Interop Standard: TypeScript Authority with ESM Discipline
category: Tech-stack
tags: [tech-stack, runtime, interop]
importance: 5
author: Ecosystem Architect
last_updated: 2026-03-21
---

# The Kyberion Runtime Interop Standard: TypeScript Authority with ESM Discipline

This document clarifies the architectural relationship between CommonJS (CJS) and TypeScript (TS) within the Kyberion Monorepo.

## 1. The Strategy: "TypeScript Authority"

Kyberion has transitioned to a **TypeScript-First Architecture** to ensure maximum type safety and structural integrity.

| Layer | Technology | Philosophy | Role |
| :--- | :--- | :--- | :--- |
| **Authority Layer** | TypeScript (`.ts`) | "Source of Truth" | All logic, including core orchestration and skills, is authored in TS. |
| **Runtime Layer** | Node.js ESM (`.js`) | "Execution Engine" | Compiled output in `dist/` is used for runtime execution. |
| **Source Discipline Layer** | ESM package boundaries | "No Shadow Artifacts" | Source trees must not keep legacy `.js` bridges beside `.ts` siblings. |

## 2. The "TypeScript Authority" (Why TS?)

The decision to use TypeScript for all core components is driven by:

1.  **System-Wide Type Safety**: Prevents runtime errors by catching logic mismatches during compilation.
2.  **Schema Alignment**: Ensures that skill outputs strictly match the `schemas/` defined in the project.
3.  **Refactoring Reliability**: Allows for large-scale architectural changes with confidence.

## 3. Interoperability Mechanics

### A. The `@agent/core` Namespace
Runtime consumers use public package entrypoints through the `@agent/core` namespace.

- **TS/ESM Consumer**: `import { logger } from '@agent/core';`
    - Resolves through workspace/package `exports`.
- **ESM Subpath Consumer**: `import { safeReadFile } from '@agent/core/secure-io';`
    - Resolves to the package subpath declared in `libs/core/package.json#exports`.

Direct source-path imports such as `../libs/core/index.js`, `@agent/core/src/...`, or `@agent/core/dist/...` are forbidden for runtime code.

### B. File Extension Policy

- **`.ts`**: Mandatory for all source code in `scripts/`, `libs/core/`, and `libs/actuators/`.
- **`.js`**: Expected in `dist/`, these are the compiled runtime artifacts.
- **`.js` in source trees**: Allowed only when intentionally authored as configuration or compatibility files such as `.cjs`, or explicitly allowlisted by policy.

Kyberion no longer keeps CJS continuity bridges in `libs/core/`. Source-adjacent shadow `.js` files are treated as a defect because they can be picked up by Node before TypeScript source during local execution.

### C. Enforcement

The repository enforces these rules with:

- `pnpm run check:esm`
- `pnpm run validate`
- CI workflow checks in `.github/workflows/`

The check currently guards:

- `package.json` entries that must declare `type: "module"`
- forbidden CommonJS-only patterns in Node-executed source
- extensionless relative imports in TS/declaration files
- forbidden workspace source-path imports for exported packages
- legacy shadow `.js` artifacts in governed library source trees

## 4. Summary: The New Golden Rule

> **"TypeScript is the Authority; package exports are the contract; source trees stay free of legacy shadow JavaScript."**

All development must happen in `.ts` files. The `dist/` folder remains the runtime output, and `pnpm run build` plus `pnpm run check:esm` are the standard integrity gates.
