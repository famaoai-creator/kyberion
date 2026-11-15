import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeExistsSync } from '@agent/core/secure-io';
import {
  loadIntentContractMemoryStore,
  resolveIntentContractMemoryPaths,
} from '@agent/core/intent/intent-contract-learning';

const rootDir = process.cwd();

// Asserts the seed-cache migration boundary directly instead of pinning
// prose in a doc: a governed, schema-validated seed file under knowledge/
// that runtime code never writes, merged beneath a writable runtime file
// (see libs/core/intent/intent-contract-learning.ts). The historical
// marker doc moved to docs/archive/intent-learning-seed-cache-plan.md;
// deterministic start-service / stop-service resolution is covered by
// libs/actuators/orchestrator-actuator/src/super-nerve/resolver.test.ts.
describe('intent learning seed cache contract', () => {
  it('resolves the seed inside governed knowledge and the runtime outside it', () => {
    const { seed, runtime } = resolveIntentContractMemoryPaths();
    const knowledgeRoot = path.join(rootDir, 'knowledge') + path.sep;
    expect(seed.startsWith(knowledgeRoot)).toBe(true);
    expect(seed.endsWith(path.join('governance', 'intent-contract-memory.json'))).toBe(true);
    expect(runtime).not.toBe(seed);
    expect(runtime.startsWith(knowledgeRoot)).toBe(false);
  });

  it('loads the shipped seed file through the governed catalog validator', () => {
    const { seed } = resolveIntentContractMemoryPaths();
    expect(safeExistsSync(seed)).toBe(true);
    const memory = loadIntentContractMemoryStore();
    expect(typeof memory.version).toBe('string');
    expect(Array.isArray(memory.entries)).toBe(true);
  });

  it('keeps the migration stable scope present in the tree', () => {
    const stableScope = [
      'libs/actuators/orchestrator-actuator/src/super-nerve/resolver.ts',
      'knowledge/product/governance/standard-intents.json',
      'libs/core/intent/contextual-intent-frame.ts',
      'libs/core/intent/conversation-signals.ts',
    ];
    for (const rel of stableScope) {
      expect(safeExistsSync(path.join(rootDir, rel)), rel).toBe(true);
    }
  });
});
