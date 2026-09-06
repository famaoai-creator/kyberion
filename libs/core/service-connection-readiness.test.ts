import { describe, expect, it } from 'vitest';
import {
  hasRequiredServiceConnectionValue,
  isServiceConnectionReady,
  loadServiceConnectionReadinessConfig,
} from './service-connection-readiness.js';

describe('service connection readiness', () => {
  it('does not treat an empty required value as ready', () => {
    expect(hasRequiredServiceConnectionValue({ voice_name: '' }, ['voice_name'])).toBe(false);
    expect(isServiceConnectionReady('voice', { voice_name: '' })).toBe(false);
  });

  it('accepts a non-empty required value', () => {
    expect(isServiceConnectionReady('voice', { voice_name: 'Kyoko' })).toBe(true);
  });

  it('loads the committed readiness catalog through its schema', () => {
    expect(loadServiceConnectionReadinessConfig()).toMatchObject({
      version: expect.any(String),
      required_services: {
        voice: { required_keys_any: expect.arrayContaining(['voice_name']) },
      },
    });
  });
});
