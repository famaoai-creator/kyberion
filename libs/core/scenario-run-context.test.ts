import { afterEach, describe, expect, it } from 'vitest';

import { parseScenarioDefinition, type ScenarioDefinition } from './scenario-definition.js';
import { createScenarioRunContext, type ScenarioRunContext } from './scenario-run-context.js';
import { safeExistsSync, safeReadFile, safeRmSync } from './secure-io.js';

function scenario(overrides: Partial<ScenarioDefinition> = {}): ScenarioDefinition {
  return parseScenarioDefinition({
    schema_version: 'kyberion-scenario.v1',
    id: 'run-context-fixture',
    title: 'Run context fixture',
    tier: 1,
    executionProfile: 'simulated',
    modelFixtures: 'model-free',
    requires: {},
    seed: {},
    fixtures: { ops: {} },
    turns: [],
    finalChecks: [],
    ...overrides,
  });
}

const contexts: ScenarioRunContext[] = [];

afterEach(() => {
  for (const ctx of contexts.splice(0)) {
    try {
      safeRmSync(ctx.runRoot);
    } catch {
      // best effort cleanup; individual tests assert their own dispose() behavior
    }
  }
});

describe('createScenarioRunContext', () => {
  it('computes a stable runId for the same scenario id + seedNonce', () => {
    const a = createScenarioRunContext(scenario());
    const b = createScenarioRunContext(scenario());
    contexts.push(a, b);
    expect(a.runId).toBe(b.runId);
    expect(a.runId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('computes distinct runIds for distinct seedNonces', () => {
    const a = createScenarioRunContext(scenario(), { seedNonce: 'one' });
    const b = createScenarioRunContext(scenario(), { seedNonce: 'two' });
    contexts.push(a, b);
    expect(a.runId).not.toBe(b.runId);
  });

  it('places runRoot under active/shared/tmp/scenarios/<runId>', () => {
    const ctx = createScenarioRunContext(scenario());
    contexts.push(ctx);
    expect(ctx.runRoot.replaceAll('\\', '/')).toMatch(
      new RegExp(`active/shared/tmp/scenarios/${ctx.runId}$`)
    );
  });

  it('deterministicId is stable for the same (namespace, n) and formatted as a UUID', () => {
    const ctx = createScenarioRunContext(scenario());
    contexts.push(ctx);
    const first = ctx.deterministicId('agents', 0);
    const again = ctx.deterministicId('agents', 0);
    expect(first).toBe(again);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('deterministicId differs across namespace and n', () => {
    const ctx = createScenarioRunContext(scenario());
    contexts.push(ctx);
    const ids = new Set([
      ctx.deterministicId('agents', 0),
      ctx.deterministicId('agents', 1),
      ctx.deterministicId('rooms', 0),
    ]);
    expect(ids.size).toBe(3);
  });

  it('starts the virtual clock at seed.clock.start_iso when declared', () => {
    const ctx = createScenarioRunContext(
      scenario({ seed: { clock: { start_iso: '2024-05-06T00:00:00.000Z' } } })
    );
    contexts.push(ctx);
    expect(ctx.clock.now()).toBe(Date.UTC(2024, 4, 6));
  });

  it('starts the virtual clock at a fixed epoch when seed.clock is absent', () => {
    const ctx = createScenarioRunContext(scenario());
    contexts.push(ctx);
    expect(ctx.clock.now()).toBe(Date.UTC(2020, 0, 1));
  });

  it('materializeSeedFiles writes seed files under runRoot', () => {
    const ctx = createScenarioRunContext(
      scenario({ seed: { files: [{ path: 'notes/hello.txt', content: 'hi there\n' }] } }),
      { seedNonce: 'materialize' }
    );
    contexts.push(ctx);
    ctx.materializeSeedFiles();
    const written = safeReadFile(`${ctx.runRoot}/notes/hello.txt`, { encoding: 'utf8' });
    expect(written).toBe('hi there\n');
  });

  it('dispose() removes runRoot by default', () => {
    const ctx = createScenarioRunContext(scenario(), { seedNonce: 'dispose-default' });
    ctx.materializeSeedFiles();
    expect(safeExistsSync(ctx.runRoot)).toBe(true);
    ctx.dispose();
    expect(safeExistsSync(ctx.runRoot)).toBe(false);
  });

  it('dispose() keeps runRoot when keep:true is set', () => {
    const ctx = createScenarioRunContext(scenario(), { seedNonce: 'dispose-keep', keep: true });
    contexts.push(ctx);
    ctx.materializeSeedFiles();
    ctx.dispose();
    expect(safeExistsSync(ctx.runRoot)).toBe(true);
  });
});
