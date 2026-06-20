import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { resolveIntentToSteps } from '../libs/actuators/orchestrator-actuator/src/super-nerve/resolver.js';

function readJson(relativePath: string): unknown {
  return JSON.parse(safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' }) as string) as unknown;
}

describe('intent resolver standard-intents contract', () => {
  it('keeps the canonical static intents in the governance catalog', async () => {
    const catalog = readJson('knowledge/product/governance/standard-intents.json') as {
      intents?: Array<{ id?: string; pipeline?: Array<{ op?: string; params?: Record<string, unknown> }> }>;
    };

    const ids = new Set((catalog.intents || []).map((intent) => intent.id).filter(Boolean) as string[]);
    for (const expectedId of [
      'verify-actuator-capability',
      'check-kyberion-baseline',
      'diagnose-kyberion-system',
      'verify-environment-readiness',
      'inspect-runtime-supervisor',
    ]) {
      expect(ids.has(expectedId)).toBe(true);
    }
  });

  it('resolves the static intent ids through the canonical catalog', async () => {
    const expectedCommands = new Map([
      ['verify-actuator-capability', 'pnpm capabilities'],
      ['check-kyberion-baseline', 'pipelines/baseline-check.json'],
      ['diagnose-kyberion-system', 'pipelines/system-diagnostics.json'],
      ['verify-environment-readiness', 'pipelines/baseline-check.json'],
      ['inspect-runtime-supervisor', 'agent_runtime_supervisor_status.js'],
    ]);

    for (const [intentId, expectedFragment] of expectedCommands) {
      const steps = await resolveIntentToSteps(intentId);
      expect(steps.length).toBeGreaterThan(0);
      expect(JSON.stringify(steps)).toContain(expectedFragment);
    }
  });
});
