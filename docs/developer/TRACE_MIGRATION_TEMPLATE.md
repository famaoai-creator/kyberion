---
title: Trace Integration Migration Template
category: Developer
tags: [trace, observability, migration, actuator]
importance: 8
last_updated: 2026-05-07
---

# Trace Integration Migration Template

How to migrate an actuator from ad-hoc logging to the unified `Trace` model defined in `libs/core/src/trace.ts`.

This is the pattern established in **Phase B-1** of the productization roadmap. The first reference implementation is `browser-actuator` (already done). Apply this template to any actuator that runs multi-step pipelines.

## Why

Before:
- Each actuator logs its own format (`action_trail`, ad-hoc strings, custom JSON).
- No correlation across actuators within a single mission.
- Chronos / observability tooling has to special-case each actuator.

After:
- Every actuator emits a `Trace` with hierarchical `Span`s.
- Mission ID flows through metadata for cross-actuator correlation.
- Trace JSONL is appended to `active/shared/logs/traces/traces-YYYY-MM-DD.jsonl` (or `customer/{slug}/logs/traces/...` when KYBERION_CUSTOMER is set).
- Chronos viewer (Phase B-8) reads this single format.

## Migration Steps

### 1. Import the Trace primitives

```typescript
import { TraceContext, persistTrace } from '@agent/core';
```

### 2. Create a TraceContext at pipeline entry

```typescript
const traceCtx = new TraceContext(`{actuator-name}:{logical-name}`, {
  actuator: 'your-actuator',
  pipelineId: sessionId,            // or whatever correlates this run
  missionId: ctx.mission_id,        // when available
});
```

### 3. Wrap each step in startSpan / endSpan

```typescript
for (const step of steps) {
  const spanId = traceCtx.startSpan(`${step.type}:${step.op}`, {
    stepId: step.id || `step-${index}`,
  });
  try {
    // existing step execution
    await runStep(step);
    traceCtx.endSpan('ok');
  } catch (err) {
    traceCtx.endSpan('error', err.message);
    throw err;
  }
}
```

### 4. Attach artifacts

When a step produces a file (screenshot, generated PPT, etc.), record it:

```typescript
traceCtx.addArtifact('screenshot', screenshotPath, 'login-confirmation');
// types: 'screenshot' | 'file' | 'document' | 'log'
```

### 5. Attach knowledge references

When a step consumes a knowledge document (e.g. via `wisdom.query`):

```typescript
traceCtx.addKnowledgeRef('knowledge/public/procedures/hints/intra-login.md');
```

### 6. Add events for noteworthy moments

```typescript
traceCtx.addEvent('cdp-attached', { port: 9222 });
traceCtx.addEvent('ringi-approved', { count: 42 });
```

### 7. Finalize and persist at the end

```typescript
const trace = traceCtx.finalize();
ctx.trace = trace;
ctx.trace_summary = traceCtx.summary();
try {
  ctx.trace_persisted_path = persistTrace(trace);
} catch (err) {
  // Persistence failure must not break the pipeline.
  logger.warn(`Failed to persist trace: ${err.message}`);
}
```

Use `finalizeAndPersist(traceCtx)` if you don't need to inspect the trace before persisting.

### 8. Keep the actuator's existing context shape

For backward compatibility, **do not** remove existing `action_trail` / step results / etc. The Trace is **additive** — downstream code that depends on the existing context shape keeps working. Trace consumers (Chronos viewer, distillation, error classifier) read from `ctx.trace`.

## Reference Implementation

See `libs/actuators/browser-actuator/src/index.ts`:

- `traceCtx` is created at line ~411.
- Each step is wrapped at line ~427.
- Screenshot artifacts are recorded at line ~450.
- Finalization + persistence is at line ~552.

## Customer-aware Persistence

When `KYBERION_CUSTOMER` is set, `persistTrace` automatically routes to `customer/{slug}/logs/traces/`. The actuator does not need to do anything different — `traceLogDir()` resolves the right path.

## What NOT to Do

- ❌ Don't store traces in `dist/` or any compiled-output location.
- ❌ Don't write traces with raw `fs.appendFileSync` — use `persistTrace` so the path-scope policy applies.
- ❌ Don't fail the pipeline if persistence fails — wrap in try/catch and log a warning.
- ❌ Don't remove existing logging until at least 1 minor version has passed (deprecation policy).

## Status

- [x] `browser-actuator` — migrated (reference implementation)
- [x] `mission_controller` checkpoint — migrated (Phase B-1.5: spans for git.stage, git.commit, state.save, project_ledger.sync, intent_delta.emit)
- [ ] `media-actuator` — TODO (Phase B-1.4)
- [ ] `media-generation-actuator` — TODO
- [ ] `meeting-actuator` — TODO
- [ ] `mission_controller` evidence/finish — TODO (Phase B-1.5 continued)
- [ ] `voice-actuator` — TODO
- [ ] `code-actuator` — TODO
- [ ] (others) — TODO

When migrating, update the box above in the same PR.
