---
title: Dependency Placement Policy
category: Governance
tags: [dependency, runtime, pnpm, uv, venv, policy]
importance: 9
last_updated: 2026-07-02
---

# Dependency Placement Policy

Kyberion separates dependency placement by lifecycle, ownership, and persistence. Operators should not decide install locations ad hoc.

## Canonical Placement Matrix

| Kind | Canonical owner | Canonical location | Installation path |
|---|---|---|---|
| Workspace Node dependencies | repo workspace | repo root `node_modules/` | `pnpm install` at repo root |
| Managed tool runtimes | tool-runtime registry | `active/shared/runtime/tool-runtimes/<tool-id>/` | tool-runtime policy + registry |
| Managed service runtimes | service-runtime registry | `active/shared/runtime/service-runtimes/<service-id>/` | service-runtime policy + registry |
| Runtime state / receipts | runtime layer | `active/shared/runtime/**/state.json` and readiness receipts | runtime layer / `env:bootstrap` |
| Shared caches | runtime policy | `active/shared/tmp/*-cache/` | runtime layer |
| Temporary working files | pipeline / mission | `active/shared/tmp/` or mission evidence dirs | pipeline / mission controller |
| Secrets / credentials | connection tiers | `knowledge/personal/`, customer overlays, or secret guard | service binding flow |

## Non-Canonical Locations

The following are not standard placement targets for new work:

- repo-local `.venv/`
- machine-specific absolute paths such as `/Users/<name>/...`
- global package installs such as `npm install -g ...`
- ad hoc `pip install ...` or `uv pip install ...` instructions embedded in product-tier presets or pipeline templates

These may exist temporarily for backward compatibility, but they are migration debt and must not become new defaults.

## Rules

1. Node dependencies belong to the workspace.
   - Install them once at the repo root with `pnpm install`.
   - Product-tier docs and presets must not require `npm install -g`.

2. Python and mixed-language runtime dependencies belong to managed runtime roots.
   - Tool-scoped environments go under `active/shared/runtime/tool-runtimes/<tool-id>/`.
   - Service-scoped environments go under `active/shared/runtime/service-runtimes/<service-id>/`.
   - The package manager (`uv`, `pip`, `brew`, etc.) is an implementation detail of the runtime layer, not a product-tier operator choice.

3. Product-tier artifacts must stay machine-portable.
   - No committed `/Users/...`, `/home/...`, or similar machine-local prefixes in `knowledge/product/**`.
   - Use repo-relative paths, path tokens such as `{{@shared:...}}`, or runtime resolution through the governed layers.

4. Operator setup must flow through governed bootstrap paths.
   - Use `pnpm env:bootstrap --manifest <id>` for environment prerequisites.
   - Use runtime registries and service presets for long-lived tools and services.
   - Do not embed step-by-step package-manager commands inside reusable product-tier presets unless the artifact is explicitly marked as legacy migration guidance.

## Legacy Compatibility

Some runtime helpers still probe `.venv/bin/python3` after `KYBERION_PYTHON_BIN` and `KYBERION_PYTHON`. That fallback is compatibility-only:

- it does not define the standard install destination
- it must not be introduced into new product-tier defaults
- migration should converge on managed runtimes or explicit operator overrides

## Review Checklist

When reviewing a new surface, actuator, or template:

- Does it introduce a new install location outside the matrix above?
- Does it assume `.venv` as the default runtime?
- Does it hard-code a machine-specific absolute path?
- Does it tell operators to install packages manually instead of pointing them to `env:bootstrap` or a runtime registry?

If any answer is yes, the change is not aligned with Kyberion runtime governance.
