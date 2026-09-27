import { describe, expect, it } from 'vitest';
import {
  collectServicePresetCliFallbacks,
  getServicePresetOperationMap,
  getServicePresetPolicy,
} from './service-preset-policy.js';

describe('service-preset-policy', () => {
  it('extracts top-level policy metadata without touching operations', () => {
    const policy = getServicePresetPolicy({
      auth_strategy: 'Bearer',
      setup_hint: 'Install and authenticate',
      allow_unsafe_cli: true,
      allow_local_network: true,
      fallback_strategy: 'service_then_cli',
      headers: { 'X-Test': '1' },
      operations: {},
    } as any);

    expect(policy).toEqual({
      auth_strategy: 'Bearer',
      setup_hint: 'Install and authenticate',
      allow_unsafe_cli: true,
      allow_local_network: true,
      fallback_strategy: 'service_then_cli',
      headers: { 'X-Test': '1' },
    });
  });

  it('returns operations as a separate operation map', () => {
    const operations = getServicePresetOperationMap({
      operations: {
        alpha: { type: 'api' },
        beta: { type: 'cli', command: 'echo' },
      },
    } as any);

    expect(Object.keys(operations)).toEqual(['alpha', 'beta']);
  });

  it('collects cli fallbacks from operation alternatives', () => {
    const fallbacks = collectServicePresetCliFallbacks({
      operations: {
        alpha: {
          type: 'api',
          alternatives: [
            { type: 'cli', command: 'tool-a' },
            { type: 'api', path: 'noop' },
          ],
        },
        beta: {
          type: 'cli',
          command: 'tool-b',
        },
      },
    } as any);

    expect(fallbacks).toEqual(['tool-a', 'tool-b']);
  });
});
