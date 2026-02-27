import { describe, it, expect, vi, beforeEach } from 'vitest';
import { injectContext } from './lib';
import * as tierGuard from '@agent/core/tier-guard';

vi.mock('@agent/core/tier-guard');

describe('context-injector lib', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should inject knowledge into data', () => {
    const data: any = { original: true };
    const knowledge = 'some knowledge';
    vi.mocked(tierGuard.validateInjection).mockReturnValue({
      allowed: true,
      sourceTier: 'public',
      outputTier: 'public',
    });
    vi.mocked(tierGuard.scanForConfidentialMarkers).mockReturnValue({
      hasMarkers: false,
      markers: [],
    });

    const result = injectContext(data, knowledge, 'k.md', 'public');
    expect(result.injected).toBe(true);
    expect(data._context.injected_knowledge).toBe(knowledge);
  });
});
