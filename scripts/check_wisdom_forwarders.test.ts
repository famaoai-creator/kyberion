import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { checkWisdomForwarders } from './check_wisdom_forwarders.js';

describe('wisdom forwarder checker', () => {
  it('uses the canonical operation registry loader', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/check_wisdom_forwarders.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('loadActuatorOpRegistry()');
    expect(source).not.toContain('readJson<Registry>');
  });

  it('keeps canonical targets and pipeline kinds aligned', () => {
    expect(checkWisdomForwarders()).toEqual([]);
  });
});
