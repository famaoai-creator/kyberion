import { describe, expect, it } from 'vitest';
import {
  parseUserPreferences,
  readUserPreference,
  writeUserPreference,
} from './preference-adapter.js';

describe('user preference JSON boundary', () => {
  it('accepts an object root while preserving arbitrary nested JSON values', () => {
    const preferences = {
      voice: { backend: 'local', options: { latency_ms: 250 } },
      feature_flags: ['a', 'b'],
      nullable: null,
    };

    expect(parseUserPreferences(preferences)).toBe(preferences);
    expect(readUserPreference(preferences, 'voice.options.latency_ms')).toBe(250);
    expect(readUserPreference(preferences, 'feature_flags')).toEqual(['a', 'b']);
    expect(readUserPreference(preferences, 'missing', 'fallback')).toBe('fallback');
  });

  it.each([null, [], 'preferences', 42, true])('rejects a non-object root: %p', (value) => {
    expect(parseUserPreferences(value)).toBeNull();
  });

  it('creates missing object segments and fails closed on scalar collisions', () => {
    const preferences = { voice: { backend: 'local' }, scalar: 'keep' };

    expect(writeUserPreference(preferences, 'voice.vad', 'silero')).toBe(true);
    expect(preferences).toEqual({
      voice: { backend: 'local', vad: 'silero' },
      scalar: 'keep',
    });
    expect(writeUserPreference(preferences, 'scalar.option', true)).toBe(false);
    expect(preferences.scalar).toBe('keep');
  });

  it('rejects prototype pollution segments', () => {
    const preferences: Record<string, unknown> = {};

    expect(writeUserPreference(preferences, '__proto__.polluted', true)).toBe(false);
    expect(readUserPreference(preferences, 'constructor.prototype')).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
