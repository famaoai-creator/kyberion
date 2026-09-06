import { describe, expect, it } from 'vitest';
import { parseIntentMapping } from './orchestrator-intent-mapping.js';

describe('orchestrator intent mapping parser', () => {
  it('accepts complete routing definitions', () => {
    expect(
      parseIntentMapping({
        intents: [{ name: 'Audit', trigger_phrases: ['audit'], chain: ['code-actuator'] }],
      })
    ).toEqual({
      intents: [{ name: 'Audit', trigger_phrases: ['audit'], chain: ['code-actuator'] }],
    });
  });

  it('rejects malformed routing definitions', () => {
    expect(
      parseIntentMapping({ intents: [{ name: 'Audit', trigger_phrases: ['audit'] }] })
    ).toBeNull();
    expect(
      parseIntentMapping({
        intents: [{ name: 'Audit', trigger_phrases: ['audit', 42], chain: ['code-actuator'] }],
      })
    ).toBeNull();
    expect(parseIntentMapping({ intents: 'not-an-array' })).toBeNull();
  });
});
