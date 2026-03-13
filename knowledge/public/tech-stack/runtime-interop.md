---
title: The Kyberion Runtime Interop Standard: TypeScript Authority with CJS Continuity
category: Tech-stack
tags: [tech-stack, runtime, interop]
importance: 5
author: Ecosystem Architect
last_updated: 2026-03-06
---

# The Kyberion Runtime Interop Standard: TypeScript Authority with CJS Continuity

This document clarifies the architectural relationship between CommonJS (CJS) and TypeScript (TS) within the Kyberion Monorepo.

## 1. The Strategy: "TypeScript Authority"

Kyberion has transitioned to a **TypeScript-First Architecture** to ensure maximum type safety and structural integrity.

| Layer | Technology | Philosophy | Role |
| :--- | :--- | :--- | :--- |
| **Authority Layer** | TypeScript (`.ts`) | "Source of Truth" | All logic, including core orchestration and skills, is authored in TS. |
| **Runtime Layer** | Node.js (`.js`) | "Execution Engine" | Compiled output in `dist/` is used for runtime execution. |
| **Continuity Layer**| CommonJS (`.js`) | "Legacy Bridge" | Lightweight bridges in `libs/core/` ensuring backward compatibility for older tools. |

## 2. The "TypeScript Authority" (Why TS?)

The decision to use TypeScript for all core components is driven by:

1.  **System-Wide Type Safety**: Prevents runtime errors by catching logic mismatches during compilation.
2.  **Schema Alignment**: Ensures that skill outputs strictly match the `schemas/` defined in the project.
3.  **Refactoring Reliability**: Allows for large-scale architectural changes with confidence.

## 3. Interoperability Mechanics

### A. The `@agent/core` Namespace
Both TS skills and legacy CJS scripts consume core utilities through the `@agent/core` namespace.

- **TS Consumer**: `import { logger } from '@agent/core/core';`
    - Resolves to: `dist/libs/core/core.js` (at runtime).
- **CJS Consumer**: `const { logger } = require('@agent/core/core');`
    - Resolves to: `libs/core/core.js` (Bridge), which then loads the `dist` version.

### B. File Extension Policy

- **`.ts`**: Mandatory for all source code in `scripts/`, `libs/core/`, and `skills/`.
- **`.js`**: Found in `dist/`, these are the compiled artifacts.
- **`.js`**: Used exclusively for **Bridges** in `libs/core/` to maintain backward compatibility.

## 4. Summary: The New Golden Rule

> **"TypeScript is the Authority; Compilation is the Gate; Bridges ensure Continuity."**

All development must happen in `.ts` files. The `dist/` folder must be kept up-to-date via `npm run build` to ensure the ecosystem remains healthy.
