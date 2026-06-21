import { describe, expect, it } from 'vitest';
import { safeReadFile } from '@agent/core';

function read(path: string): string {
  return safeReadFile(path, { encoding: 'utf8' }) as string;
}

describe('intent learning seed cache plan contract', () => {
  it('documents the migration scope and safety boundary', () => {
    const doc = read('docs/intent-learning-seed-cache-plan.md');

    expect(doc).toContain('libs/actuators/orchestrator-actuator/src/super-nerve/resolver.ts');
    expect(doc).toContain('knowledge/product/governance/standard-intents.json');
    expect(doc).toContain('libs/core/contextual-intent-frame.ts');
    expect(doc).toContain('libs/core/contextual-intent-learning.ts');
    expect(doc).toContain('deterministic static pipeline mappings');
    expect(doc).toContain('start-service and stop-service');
    expect(doc).toContain('source: seed');
    expect(doc).toContain('tier: public');
    expect(doc).toContain('No runtime behavior change');
  });
});
