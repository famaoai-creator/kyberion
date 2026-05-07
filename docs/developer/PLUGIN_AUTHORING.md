---
title: Plugin Authoring Guide
category: Developer
tags: [plugin, actuator, authoring, c-5]
importance: 9
last_updated: 2026-05-07
---

# Plugin Authoring Guide

How to add a new actuator to Kyberion in ~30 minutes. Phase C'-5 of `docs/PRODUCTIZATION_ROADMAP.md`.

This guide assumes you've read [`TOUR.md`](./TOUR.md) and skimmed [`EXTENSION_POINTS.md`](./EXTENSION_POINTS.md). It is for authoring **first-party** actuators inside `libs/actuators/`. Third-party / out-of-tree plugins via the `plugins/` directory are a separate path (Phase D'-1, not yet stabilized).

## When to add a new actuator

You need a new actuator when you have:

- A new external system / device / domain to integrate (a SaaS, a piece of hardware, a CLI tool).
- A new class of operation that doesn't fit existing actuators.
- A vertical-specific operation that should not pollute a general-purpose actuator.

You do **not** need a new actuator when:

- You can wrap an existing op with a sub-pipeline (use `pipelines/fragments/`).
- The work is one-shot and won't be reused (use a one-off script).
- It's a customization for a single customer (use `customer/{slug}/mission-seeds/`).

## The 30-minute walkthrough

We'll build a fictional actuator: `weather-actuator`, with one op `current_weather` that fetches today's weather.

### Step 1 — Scaffold (3 min)

```bash
mkdir -p libs/actuators/weather-actuator/src
cd libs/actuators/weather-actuator
```

Create the package `package.json`:

```json
{
  "name": "@actuators/weather-actuator",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "scripts": {
    "build": "tsc -p ../../tsconfig.actuators.json"
  },
  "dependencies": {
    "@agent/core": "workspace:*"
  }
}
```

### Step 2 — Manifest (2 min)

`libs/actuators/weather-actuator/manifest.json`:

```json
{
  "actuator_id": "weather-actuator",
  "version": "1.0.0",
  "description": "Weather lookup actuator (example)",
  "contract_schema": "schemas/weather-action.schema.json",
  "capabilities": [
    {
      "op": "current_weather",
      "schema_ref": "schemas/weather-action.schema.json",
      "platforms": ["darwin", "linux", "win32"]
    }
  ]
}
```

### Step 3 — Schema (5 min)

`schemas/weather-action.schema.json`:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://kyberion.ai/schemas/weather-action.schema.json",
  "title": "Weather Action",
  "type": "object",
  "required": ["action"],
  "properties": {
    "action": { "const": "current_weather" },
    "location": { "type": "string", "description": "City name or 'lat,lon'" },
    "units": { "enum": ["metric", "imperial"], "default": "metric" }
  }
}
```

### Step 4 — Implementation (15 min)

`libs/actuators/weather-actuator/src/index.ts`:

```typescript
import {
  logger,
  classifyError,
  formatClassification,
  TraceContext,
  persistTrace,
} from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';

interface WeatherAction {
  action: 'current_weather';
  location: string;
  units?: 'metric' | 'imperial';
}

interface WeatherResult {
  status: 'ok' | 'failed';
  location: string;
  temperature_c?: number;
  condition?: string;
  error?: string;
}

async function getWeather(location: string, units = 'metric'): Promise<WeatherResult> {
  // In a real actuator, replace this with a fetch to a weather API.
  // Use secret-actuator to read the API key — never inline.
  if (!location) {
    return { status: 'failed', location: '', error: 'location is required' };
  }
  // Stub for the example.
  return {
    status: 'ok',
    location,
    temperature_c: 23,
    condition: 'sunny',
  };
}

async function handleAction(input: WeatherAction): Promise<WeatherResult> {
  const trace = new TraceContext('weather-actuator', { actuator: 'weather-actuator' });
  trace.addEvent('weather.requested', { location: input.location });
  try {
    const result = await getWeather(input.location, input.units);
    trace.addEvent('weather.returned', { status: result.status });
    return result;
  } catch (err: any) {
    const classified = classifyError(err);
    logger.error(formatClassification(classified));
    return { status: 'failed', location: input.location, error: classified.detail };
  } finally {
    try { persistTrace(trace.finalize()); } catch (_) { /* persistence best-effort */ }
  }
}

const argv = createStandardYargs(process.argv.slice(2)).argv as { input?: string };
if (!argv.input) {
  console.error('Usage: weather-actuator --input <action.json>');
  process.exit(1);
}

import * as fs from 'node:fs';
const action: WeatherAction = JSON.parse(fs.readFileSync(argv.input, 'utf-8'));
handleAction(action).then(result => {
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'failed') process.exit(1);
});
```

### Step 5 — Add to workspace (1 min)

`pnpm-workspace.yaml` already includes `libs/actuators/*`, so just:

```bash
pnpm install
```

### Step 6 — Build + smoke (2 min)

```bash
pnpm --filter @actuators/weather-actuator build
echo '{"action":"current_weather","location":"Tokyo"}' > /tmp/w.json
node dist/libs/actuators/weather-actuator/src/index.js --input /tmp/w.json
# Expect: { "status": "ok", "location": "Tokyo", "temperature_c": 23, "condition": "sunny" }
```

### Step 7 — Add to baseline (1 min)

```bash
pnpm tsx scripts/check_contract_semver.ts -- --rebaseline
git add libs/actuators/weather-actuator/ schemas/weather-action.schema.json scripts/contract-baseline.json
```

### Step 8 — Use it from a pipeline (1 min)

`pipelines/example-weather.json`:

```json
{
  "pipeline_id": "example-weather",
  "version": "1.0.0",
  "action": "pipeline",
  "steps": [
    {
      "id": "ask-weather",
      "type": "apply",
      "op": "weather:current_weather",
      "params": { "location": "Tokyo" }
    }
  ]
}
```

Then `pnpm pipeline --input pipelines/example-weather.json`.

### Step 9 — Add a test (3 min)

`libs/actuators/weather-actuator/src/index.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { ... } from './index.js';   // export getWeather for testing

describe('weather-actuator', () => {
  it('returns failed when location missing', async () => {
    const r = await getWeather('');
    expect(r.status).toBe('failed');
  });

  it('returns ok for a valid location', async () => {
    const r = await getWeather('Tokyo');
    expect(r.status).toBe('ok');
  });
});
```

```bash
pnpm vitest run libs/actuators/weather-actuator/
```

## Mandatory before merging

- [ ] `manifest.json` declares ops with correct platforms.
- [ ] `schemas/<actuator>-action.schema.json` validates inputs (referenced by manifest).
- [ ] CLI entry point exists with the `runActuator` / `createStandardYargs` pattern.
- [ ] Trace integrated (see [`TRACE_MIGRATION_TEMPLATE.md`](./TRACE_MIGRATION_TEMPLATE.md)).
- [ ] Errors classified via `classifyError` (see [`error-classifier.ts`](../../libs/core/error-classifier.ts)).
- [ ] At least one unit test.
- [ ] `pnpm tsx scripts/check_contract_semver.ts -- --rebaseline` recorded.
- [ ] An entry added to [`CAPABILITIES_GUIDE.md`](../../CAPABILITIES_GUIDE.md) (auto-generated; see `pnpm catalog`).

## Common pitfalls

- **Using `node:fs` directly**: forbidden. Use `safeReadFile` / `safeWriteFile` from `@agent/core`.
- **Inlining secrets**: forbidden. Use `secret-actuator` to fetch from the OS keychain.
- **Calling `process.env.SHELL`**: per the recent fix in `scripts/run_pipeline.ts`, use `bash -c` directly. The `SHELL` env var is unreliable across CI / Docker.
- **Skipping the schema**: every actuator op must have a schema entry. Pipelines are validated before execution; an unschema'd op fails preflight.
- **Throwing on partial success**: an actuator should return `{ status: 'failed', error: '...' }` rather than throw, except for unrecoverable errors. Pipeline `on_error` cannot fall back from a thrown unhandled exception cleanly.

## What about plugins (out-of-tree actuators)?

The `plugins/` directory is the **future** location for third-party actuators. Currently:

- The plugin loader is Beta (per `EXTENSION_POINTS.md` §2.3).
- Out-of-tree plugins must currently include their own manifest + schema and register via `pnpm plugin install <path>`.
- Phase D'-1 will stabilize plugin authoring as v1. Until then, in-tree (under `libs/actuators/`) is the recommended path for production work.

## Reference actuators

Read these top-to-bottom for examples of well-structured actuators:

- `libs/actuators/file-actuator/src/index.ts` — minimal, single op.
- `libs/actuators/wisdom-actuator/src/index.ts` — multi-op, knowledge-tier-aware.
- `libs/actuators/browser-actuator/src/index.ts` — complex, with Trace, runtime state, leases.
- `libs/actuators/system-actuator/src/index.ts` — broad surface, multiple op types.
